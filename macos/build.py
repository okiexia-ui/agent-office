"""Build a local, ad-hoc-signed .app with the current checkout's runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MACOS = ROOT / "macos"
RUNTIME_TYPES = {
    "public": {".html", ".js", ".css", ".png", ".svg", ".json", ".txt", ".yaml", ".webmanifest"},
    "worker": {".js", ".mjs"},
    "scripts": {".js", ".mjs", ".jxa", ".py"},
    "licenses": {".txt"},
}


def package_files():
    for name in ["LICENSE", "package.json", "package-lock.json"]:
        yield ROOT / name
    for directory, types in RUNTIME_TYPES.items():
        for file in sorted((ROOT / directory).rglob("*")):
            if file.suffix in types and file.is_file() and not any(
                part.startswith(".") for part in file.relative_to(ROOT).parts
            ):
                yield file
    # Ship only the Node packages used to run the local edition.
    locked = json.loads((ROOT / "package-lock.json").read_text())["packages"]
    needed = {"proper-lockfile", "playwright-core"}
    included = set()
    while needed:
        name = min(needed)
        needed.remove(name)
        included.add(name)
        dependency = ROOT / "node_modules" / name
        manifest = json.loads((dependency / "package.json").read_text())
        entry = locked["node_modules/" + name]
        if manifest["version"] != entry["version"]:
            raise SystemExit(f"Dependency mismatch for {name}. Run npm ci.")
        needed.update(set(entry.get("dependencies", {})) - included)
        yield from sorted(file for file in dependency.rglob("*") if file.is_file())


def write_runtime(resources, project):
    archive = resources / "runtime.zip"
    with zipfile.ZipFile(archive, "w") as out:
        for file in package_files():
            # Never follow local symlinks into a user's project or home directory.
            if file.resolve() != file:
                raise SystemExit(f"Cannot include symlink in runtime: {file}")
            info = zipfile.ZipInfo(file.relative_to(ROOT).as_posix())
            info.create_system = 3
            info.external_attr = (0o100755 if os.access(file, os.X_OK) else 0o100644) << 16
            out.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (resources / "build.json").write_text(json.dumps({
        "runtimeSHA256": digest,
        "configuredProject": str(project) if project else None,
    }, ensure_ascii=False))
    shutil.copy2(MACOS / "start-office.cjs", resources / "start-office.cjs")


def write_icon(destination, temp):
    source = ROOT / "public/icons/icon-512.png"
    records = []
    for pixels, kind in [(16, b"icp4"), (32, b"icp5"), (64, b"icp6"), (128, b"ic07"),
                         (256, b"ic08"), (512, b"ic09")]:
        image = source
        if pixels != 512:
            image = temp / f"icon-{pixels}.png"
            subprocess.run(["sips", "-z", str(pixels), str(pixels), str(source), "--out", str(image)],
                           check=True, stdout=subprocess.DEVNULL)
        data = image.read_bytes()
        records.append(kind + struct.pack(">I", len(data) + 8) + data)
    content = b"".join(records)
    destination.write_bytes(b"icns" + struct.pack(">I", len(content) + 8) + content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release/Agent Office.app")
    parser.add_argument("--project", type=Path, help="Existing Agent Office checkout containing .env.local and .office-local")
    args = parser.parse_args()
    if args.project and not args.project.is_dir():
        parser.error("--project must name an existing directory")
    output = args.output.expanduser().absolute()
    if output.exists() or output.is_symlink() or output.suffix != ".app":
        parser.error("Choose an unused .app output path")
    node = shutil.which("node")
    if node is None:
        parser.error("Install Node.js 22.19 or later and run npm ci in this checkout")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".office-build-", dir=output.parent) as scratch:
        temp = Path(scratch)
        app = temp / "Agent Office.app"
        contents = app / "Contents"
        resources = contents / "Resources"
        resources.mkdir(parents=True)
        (contents / "MacOS").mkdir()
        write_runtime(resources, args.project.resolve() if args.project else None)
        write_icon(resources / "AgentOffice.icns", temp)
        package = json.loads((ROOT / "package.json").read_text())
        with (contents / "Info.plist").open("wb") as target:
            plistlib.dump({
                "CFBundleIdentifier": "local.agentoffice.desktop",
                "CFBundleName": "Agent Office", "CFBundleDisplayName": "Agent Office",
                "CFBundleExecutable": "OfficeWindow", "CFBundleIconFile": "AgentOffice.icns",
                "CFBundlePackageType": "APPL", "CFBundleShortVersionString": package["version"],
                "CFBundleVersion": package["version"], "CFBundleDevelopmentRegion": "zh_CN",
                "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True,
                "NSPrincipalClass": "NSApplication", "OfficeNodePath": node,
                "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
            }, target)
        arch = os.uname().machine
        subprocess.run(["xcrun", "swiftc", "-O", "-target", f"{arch}-apple-macosx13.0",
                        "-module-cache-path", str(temp / "modules"), str(MACOS / "OfficeWindow.swift"),
                        "-o", str(contents / "MacOS/OfficeWindow")], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        app.rename(output)
    print(output)


if __name__ == "__main__":
    main()
