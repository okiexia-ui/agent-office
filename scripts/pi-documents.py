"""Local document conversions. All workspace I/O stays anchored to directory FDs."""
import contextlib
import csv
import io
import json
import os
from pathlib import PurePosixPath
import re
import secrets
import stat
import sys
import zipfile

MAX_FILE = 16 * 1024 * 1024
MAX_TEXT = 32000
TEXT_TYPES = {".txt", ".md", ".html", ".htm", ".css", ".js", ".json", ".csv", ".tsv"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Problem(Exception):
    def __init__(self, message, code="DOCUMENT_ERROR"):
        super().__init__(message)
        self.code = code


def relative_parts(value, listing):
    if listing and value in ("", "."):
        return []
    if not isinstance(value, str) or len(value) > 1024:
        raise Problem("请提供工作区内的相对文件名。", "INVALID_PATH")
    parts = value.split("/")
    if len(parts) > 32 or any(
        not valid_name(part) for part in parts
    ):
        raise Problem("路径必须在工作区内，不能包含隐藏项或上级目录。", "INVALID_PATH")
    return parts


def valid_name(name):
    return bool(name) and not name.startswith(".") and "\\" not in name and not re.search(r"[\x00-\x1f\x7f]", name)


@contextlib.contextmanager
def directory(root, parts, create=False):
    fd = os.open(root, DIR_FLAGS)
    try:
        for name in parts:
            if create:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def list_files(folder):
    files = []
    with os.scandir(folder) as entries:
        for entry in entries:
            if not valid_name(entry.name):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(info.st_mode):
                files.append({"name": entry.name, "kind": "directory", "bytes": 0})
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                files.append({"name": entry.name, "kind": "file", "bytes": info.st_size})
            if len(files) > 200:
                break
    return {"files": sorted(files[:200], key=lambda f: (f["kind"], f["name"])), "truncated": len(files) > 200}


def read_file(folder, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Problem("只支持工作区内独立的普通文件。", "INVALID_PATH")
        if info.st_size > limit:
            raise Problem("文件超过读取大小上限。", "FILE_TOO_LARGE")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise Problem("文件超过读取大小上限。", "FILE_TOO_LARGE")
        return data


def write_file(folder, name, data, overwrite):
    if len(data) > MAX_FILE:
        raise Problem("文件超过 16 MiB。", "FILE_TOO_LARGE")
    if not isinstance(overwrite, bool):
        raise Problem("overwrite 须为布尔值。")
    try:
        existing = os.stat(name, dir_fd=folder, follow_symlinks=False)
    except FileNotFoundError:
        existing = None
    if existing:
        if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
            raise Problem("只支持工作区内独立的普通文件。", "INVALID_PATH")
        if not overwrite:
            raise Problem("已有同名文件。请另取文件名，或明确要求覆盖。", "FILE_EXISTS")
    temp = ".document-" + secrets.token_hex(12)
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=folder)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
        else:
            # Install a fully written file without clobbering a concurrent creator.
            os.link(temp, name, src_dir_fd=folder, dst_dir_fd=folder, follow_symlinks=False)
    finally:
        try:
            os.unlink(temp, dir_fd=folder)
        except FileNotFoundError:
            pass


def check_package(data):
    # Check expansion before passing zipped OOXML to a parser. No package entries
    # are ever extracted to disk, and XML parts cannot declare external entities.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(e.file_size for e in entries) > 64 * 1024 * 1024:
            raise Problem("文档解压后的大小超出限制。")
        for entry in entries:
            if entry.filename.lower().endswith((".xml", ".rels")):
                if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", archive.read(entry).replace(b"\0", b""), re.I):
                    raise Problem("文档包含不支持的 XML 声明。")


def table_rows(value):
    if not isinstance(value, list) or not value or len(value) > 2000:
        raise Problem("请提供 1 至 2000 行的 rows 二维数组。")
    for row in value:
        if not isinstance(row, list) or not 1 <= len(row) <= 100:
            raise Problem("每行应有 1 至 100 个单元格。")
        for cell in row:
            if cell is not None and not isinstance(cell, (str, bool, float, int)):
                raise Problem("单元格应为文字、数值、布尔值或 null。")
            if isinstance(cell, str) and len(cell) > 32767:
                raise Problem("单元格文字太长。")
    return value


def csv_literal(value):
    if isinstance(value, str) and re.match(r"^[\s\x00-\x1f]*[=+@＝＋＠－-]", value):
        return "'" + value
    return value


def create_pdf(text, title):
    from html import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont, TTFError
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate

    # Prefer an embedded Chinese font, including its Unicode map for copying and
    # searching text. Use the standard PDF Chinese font when no local TTF exists.
    font = "OfficeCJK"
    for filename, index in [
        ("/System/Library/Fonts/STHeiti Light.ttc", 1),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        ("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", 0),
    ]:
        if os.path.isfile(filename):
            try:
                pdfmetrics.registerFont(TTFont(font, filename, subfontIndex=index))
                break
            except TTFError:
                continue
    else:
        font = "STSong-Light"
        pdfmetrics.registerFont(UnicodeCIDFont(font))

    style = ParagraphStyle("Body", fontName=font, fontSize=11.5, leading=18, wordWrap="CJK")
    story = []
    for number, page_text in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\f")):
        if number:
            story.append(PageBreak())
        for line in page_text.split("\n"):
            story.append(Paragraph(escape(line.expandtabs(4)) or "&#160;", style))
    result = io.BytesIO()
    pdf = SimpleDocTemplate(result, pagesize=A4, title=title, leftMargin=54, rightMargin=54,
                            topMargin=54, bottomMargin=54, pageCompression=1)
    pdf.build(story)
    return result.getvalue()


def create_document(ext, req):
    if ext in {".xlsx", ".csv", ".tsv"}:
        rows = table_rows(req.get("rows"))
        if ext == ".xlsx":
            from openpyxl import Workbook
            workbook = Workbook()
            sheet = workbook.active
            for i, row in enumerate(rows, 1):
                for j, value in enumerate(row, 1):
                    cell = sheet.cell(i, j, value)
                    if isinstance(value, str):
                        cell.data_type = "s"  # user-provided text is always literal
            result = io.BytesIO()
            workbook.save(result)
            return result.getvalue()
        stream = io.StringIO(newline="")
        writer = csv.writer(stream, delimiter="," if ext == ".csv" else "\t")
        writer.writerows([csv_literal(v) for v in row] for row in rows)
        return stream.getvalue().encode("utf-8-sig")
    result = io.BytesIO()
    if ext == ".pptx":
        slides = req.get("slides")
        if not isinstance(slides, list) or not 1 <= len(slides) <= 100:
            raise Problem("请提供 1 至 100 张 slides，每张包含 title 与 body。")
        from pptx import Presentation
        deck = Presentation()
        for spec in slides:
            if not isinstance(spec, dict) or not all(isinstance(spec.get(key), str) for key in ("title", "body")):
                raise Problem("每张幻灯片都需要 title 和 body 字符串。")
            slide = deck.slides.add_slide(deck.slide_layouts[1])
            slide.shapes.title.text = spec["title"]
            slide.placeholders[1].text = spec["body"]
        deck.save(result)
    elif ext in TEXT_TYPES or ext in {".docx", ".pdf"}:
        text = req.get("text")
        if not isinstance(text, str):
            raise Problem("请用 text 提供文档正文。")
        if ext == ".pdf":
            return create_pdf(text, PurePosixPath(req["path"]).stem)
        if ext != ".docx":
            return text.encode("utf-8")
        from docx import Document
        doc = Document()
        for line in text.split("\n"):
            doc.add_paragraph(line.rstrip("\r"))
        doc.save(result)
    else:
        raise Problem("暂不支持写入这种文档格式。")
    return result.getvalue()


def document_lines(ext, data):
    source = io.BytesIO(data)
    if ext in TEXT_TYPES:
        yield data.decode("utf-8-sig")
        return
    if ext == ".pdf":
        from pypdf import PdfReader
        pdf = PdfReader(source)
        if pdf.is_encrypted:
            raise Problem("请先在本机解除 PDF 密码保护。")
        for number, page in enumerate(pdf.pages, 1):
            if number > 100:
                yield None
                return
            yield page.extract_text() or ""
        return
    if ext not in {".docx", ".pptx", ".xlsx"}:
        raise Problem("支持读取 DOCX、XLSX、PPTX、PDF 和 UTF-8 文本。")
    check_package(data)
    if ext == ".docx":
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph
        doc = Document(source)
        # Follow the actual ordering of body paragraphs and tables, including in
        # older versions of python-docx without iter_inner_content().
        for element in doc.element.body:
            if element.tag.endswith("}p"):
                yield Paragraph(element, doc).text
            elif element.tag.endswith("}tbl"):
                for row in Table(element, doc).rows:
                    yield "\t".join(cell.text for cell in row.cells)
    elif ext == ".pptx":
        from pptx import Presentation
        from pptx.shapes.group import GroupShape

        def slide_text(shapes):
            for shape in shapes:
                if isinstance(shape, GroupShape):
                    yield from slide_text(shape.shapes)
                elif shape.has_text_frame:
                    yield shape.text
                elif shape.has_table:
                    for row in shape.table.rows:
                        yield "\t".join(cell.text for cell in row.cells)

        for i, slide in enumerate(Presentation(source).slides, 1):
            yield f"[幻灯片 {i}]"
            yield from slide_text(slide.shapes)
    else:
        from openpyxl import load_workbook
        book = load_workbook(source, read_only=True, data_only=False, keep_links=False)
        try:
            for sheet in book.worksheets:
                yield "[" + sheet.title + "]"
                # Streaming exporters sometimes record A1 as the dimension of
                # an entire sheet. Limit actual rows and cells as they arrive.
                sheet.reset_dimensions()
                for i, row in enumerate(sheet.iter_rows(values_only=True), 1):
                    if i > 2000:
                        yield None
                        break
                    if len(row) > 100:
                        yield None
                    yield "\t".join(str(cell) if cell is not None else "" for cell in row[:100]).rstrip("\t")
        finally:
            book.close()


def extract(ext, data):
    chunks = []
    length = 0
    truncated = False
    for line in document_lines(ext, data):
        if line is None:
            truncated = True
            continue
        remaining = MAX_TEXT - length - int(bool(chunks))
        if remaining < len(line):
            if remaining > 0:
                chunks.append(line[:remaining])
            truncated = True
            break
        length += len(line) + int(bool(chunks))
        chunks.append(line)
    text = "\n".join(chunks)
    if ext == ".pdf" and not text.strip():
        raise Problem("没有可提取的 PDF 文字。扫描页需要先进行 OCR。")
    return {"text": text, "truncated": truncated}


def main():
    header = sys.stdin.buffer.readline(1024 * 1024 + 1)
    if len(header) > 1024 * 1024 or not header.endswith(b"\n"):
        raise Problem("请求过大。可拆成较小的文档。")
    req = json.loads(header)
    op = req["operation"]
    relative = req["path"]
    parts = relative_parts(relative, op == "list")
    create_parents = op == "write" or (op == "upload" and req.get("createParents", True))
    with directory(req["root"], parts if op == "list" else parts[:-1], create=create_parents) as folder:
        if op == "list":
            return list_files(folder)
        name = parts[-1]
        ext = PurePosixPath(name).suffix.lower()
        if op in {"read", "download", "locate"}:
            data = read_file(folder, name, req.get("maxBytes", MAX_FILE))
            if op == "locate":
                return os.path.join(os.path.realpath(req["root"]), *parts)
            if op == "download":
                sys.stdout.buffer.write(data)
                return
            return {"path": relative, **extract(ext, data)}
        if op == "upload":
            data = sys.stdin.buffer.read(MAX_FILE + 1)
        elif op == "write":
            data = create_document(ext, req)
        else:
            raise Problem("文档操作不存在。")
        write_file(folder, name, data, req.get("overwrite", False))
        return {"path": relative, "bytes": len(data)}


if __name__ == "__main__":
    try:
        result = main()
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        if isinstance(exc, Problem):
            message, code = str(exc), exc.code
        elif isinstance(exc, ModuleNotFoundError):
            packages = {"docx": "python-docx", "pptx": "python-pptx"}
            package = packages.get(exc.name, exc.name)
            message, code = f"文档运行时缺少 {package}，可用 OFFICE_DOCUMENT_PYTHON 指向已安装该库的 Python 3。", "MISSING_MODULE"
        elif isinstance(exc, FileNotFoundError):
            message, code = "找不到此文件或工作目录。", "NOT_FOUND"
        elif isinstance(exc, FileExistsError):
            message, code = "已有同名文件。请另取文件名或明确要求覆盖。", "FILE_EXISTS"
        elif isinstance(exc, OSError):
            message, code = "无法访问此工作区路径。请检查文件类型和目录权限。", "INVALID_PATH"
        else:
            message, code = "无法处理此文档。请检查格式、编码或文件完整性。", "DOCUMENT_ERROR"
        print(json.dumps({"error": message, "code": code}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
