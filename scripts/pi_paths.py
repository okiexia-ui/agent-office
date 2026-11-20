"""Anchored file operations shared by the document and project tools."""
import contextlib
import os
import re
import secrets
import stat

MAX_FILE = 16 * 1024 * 1024
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
def directory(root, parts, create=False, identity=None):
    fd = os.open(root, DIR_FLAGS)
    try:
        if identity:
            info = os.fstat(fd)
            if f"{info.st_dev}:{info.st_ino}" != identity:
                raise Problem("原项目目录已被更换。请重新选择文件夹。")
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


def write_file(folder, name, data, overwrite, expected=None):
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
            if expected is not None and existing:
                os.fchmod(stream.fileno(), stat.S_IMODE(existing.st_mode) & 0o777)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if expected is not None and read_file(folder, name, MAX_FILE) != expected:
            raise Problem("文件已被其他进程修改。请重新读取后编辑。")
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
