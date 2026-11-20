"""Project-only text tools and a per-turn journal of the writes they make."""
import difflib
import hashlib
import fcntl
import json
import os
import re
import stat
from pathlib import Path
from pi_paths import DIR_FLAGS, Problem, directory, list_files, read_file, relative_parts, valid_name, write_file

MAX_SOURCE = 256 * 1024
MAX_DIFF = 8192
SKIP_SEARCH = {"node_modules", "__pycache__", "vendor", "target", "dist", "build"}


def text_file(folder, name):
    data = read_file(folder, name, MAX_SOURCE)
    if b"\0" in data:
        raise Problem("请选择 UTF-8 文本文件。")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Problem("请选择 UTF-8 文本文件。")


def search(folder, query):
    if not isinstance(query, str) or not query or len(query) > 240:
        raise Problem("请输入 1 至 240 字的搜索内容。")
    matches = []
    visited = consumed = 0
    truncated = False

    def scan(parent, prefix, depth):
        nonlocal visited, consumed, truncated
        with os.scandir(parent) as entries:
            for entry in entries:
                visited += 1
                if visited > 5000 or consumed >= 12 * 1024 * 1024 or len(matches) >= 40:
                    truncated = True
                    return
                if not valid_name(entry.name):
                    continue
                relative = prefix + entry.name
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        if depth < 15 and entry.name not in SKIP_SEARCH:
                            child = os.open(entry.name, DIR_FLAGS, dir_fd=parent)
                            try:
                                scan(child, relative + "/", depth + 1)
                            finally:
                                os.close(child)
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_SOURCE:
                        consumed += info.st_size
                        for number, line in enumerate(text_file(parent, entry.name).splitlines(), 1):
                            if query in line:
                                pos = max(0, line.index(query) - 80)
                                matches.append({"path": relative, "line": number, "text": line[pos:pos + 300]})
                                if len(matches) == 40:
                                    truncated = True
                                    return
                except (OSError, Problem):
                    continue
    scan(folder, "", 0)
    return {"matches": matches, "truncated": truncated}


def save_record(file, record):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def list_headerless(lines):
    # The display uses workspace-relative names rather than temporary names.
    next(lines, None)
    next(lines, None)
    return lines


def changes(req, journal):
    result = []
    for file in sorted(journal.glob("*.change")):
        record = json.loads(file.read_text(encoding="utf-8"))
        pending = record.get("pending")
        if pending is not None:
            # A cancelled process can exit between atomic replacement and its receipt.
            try:
                parts = relative_parts(record["path"], False)
                with directory(req["root"], parts[:-1], identity=req.get("identity")) as folder:
                    if text_file(folder, parts[-1]) == pending:
                        record["after"] = pending
            except (OSError, Problem):
                pass
        before, after = record["before"], record["after"]
        if before == after or after is None:
            continue
        name = record["path"]
        old = (before or "").splitlines(keepends=True)
        new = after.splitlines(keepends=True)
        # Trim common ends before bounding the diff. A change near the end of a
        # large tracked file still gets its correct hunk and actual line number.
        prefix = 0
        while prefix < min(len(old), len(new)) and old[prefix] == new[prefix]:
            prefix += 1
        suffix = 0
        while suffix < min(len(old), len(new)) - prefix and old[-1 - suffix] == new[-1 - suffix]:
            suffix += 1
        start = max(0, prefix - 3)
        end_old, end_new = len(old) - max(0, suffix - 3), len(new) - max(0, suffix - 3)
        truncated = max(end_old, end_new) - start > 1400
        diff = "--- " + ("/dev/null" if before is None else "a/" + name) + "\n+++ b/" + name + "\n"
        lines = difflib.unified_diff(old[start:min(end_old, start + 1400)], new[start:min(end_new, start + 1400)])
        for line in list_headerless(lines):
            if line.startswith("@@ "):
                line = re.sub(r"([-+])(\d+)", lambda match: match[1] + str(start + int(match[2])), line, count=2)
            elif not line.endswith("\n"):
                line += "\n\\ No newline at end of file\n"
            remaining = MAX_DIFF - len(diff)
            diff += line[:remaining]
            if len(line) > remaining:
                truncated = True
                break
        result.append({"path": name, "status": "added" if before is None else "modified", "diff": diff, "truncated": truncated})
    return {"changes": sorted(result, key=lambda item: item["path"])}


def project_tool(req):
    journal = Path(req["journal"])
    # A stopped run's subprocesses cannot race finalization or a subsequent turn.
    # If the server died, startup seals the journal before recovering an interrupted write.
    with (journal / "run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if req["action"] == "changes":
            return changes(req, journal)
        if (journal / "closed").exists():
            raise Problem("本轮工作已经停止。")
        return operate(req, journal)


def operate(req, journal):
    action = req["action"]
    path = req.get("path", "") or ""
    listing = action in {"list", "search"}
    if action not in {"list", "search", "read", "edit", "write"}:
        raise Problem("不支持这个项目操作。")
    parts = relative_parts(path, listing)
    log = journal / "activity.jsonl"
    if not log.exists() or log.stat().st_size < 32768:
        with log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"operation": action, "path": path or "."}, ensure_ascii=False) + "\n")
    with directory(req["root"], parts if listing else parts[:-1], create=action == "write", identity=req.get("identity")) as folder:
        if action == "list":
            return list_files(folder)
        if action == "search":
            return search(folder, req.get("query"))
        name = parts[-1]
        if action == "read":
            start = req.get("startLine", 1)
            if type(start) is not int or start < 1:
                raise Problem("起始行号必须为正整数。")
            lines = text_file(folder, name).splitlines(keepends=True)
            window = "".join(lines[start - 1:start + 149])
            return {"path": path, "startLine": start, "text": window[:12000], "lines": len(lines),
                    "truncated": start + 149 < len(lines) or len(window) > 12000}
        try:
            current = text_file(folder, name)
        except FileNotFoundError:
            current = None
        if action == "write":
            if current is not None:
                raise Problem("此文件已存在。请先读取，再用 edit 精确替换。")
            updated = req.get("text")
        else:
            old = req.get("oldText")
            new = req.get("newText")
            if current is None or not isinstance(old, str) or not old or not isinstance(new, str) or current.count(old) != 1:
                raise Problem("原文必须唯一匹配现有文件。请重新读取并提供足够的上下文。")
            updated = current.replace(old, new, 1)
        if not isinstance(updated, str) or "\0" in updated or len(updated.encode("utf-8")) > MAX_SOURCE:
            raise Problem("只支持 256 KiB 以内的 UTF-8 文本。")
        if updated == current:
            return {"path": path, "changed": False}
        key = hashlib.sha256(path.encode("utf-8")).hexdigest()
        file = journal / (key + ".change")
        if file.exists():
            record = json.loads(file.read_text(encoding="utf-8"))
            if current != record["after"]:
                raise Problem("这个文件在本轮工作期间被其他程序改过。已保留外部修改，请另开一轮继续。")
        else:
            if sum(1 for _ in journal.glob("*.change")) >= 32:
                raise Problem("本轮已处理 32 个不同文件。请分轮继续。")
            record = {"path": path, "before": current, "after": current}
        record["pending"] = updated
        save_record(file, record)
        try:
            write_file(folder, name, updated.encode("utf-8"), current is not None,
                       expected=current.encode("utf-8") if current is not None else None)
            record["after"] = updated
        finally:
            record.pop("pending")
            save_record(file, record)
        return {"path": path, "changed": True}
