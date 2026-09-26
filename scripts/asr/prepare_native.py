"""Fetch and verify the fixed native SDK; stage DLLs for Tauri packaging.

Existing model archives are not downloaded or modified by this script.
Run before a native build: python scripts/asr/prepare_native.py
"""
import json
from pathlib import Path
import shutil
from prepare import release_assets, request, verify, extract_selected

workspace = Path(__file__).resolve().parents[2]
lab = workspace / "speech-lab.local"
lab.mkdir(exist_ok=True)
name = "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib.tar.bz2"
asset = release_assets("v1.13.8")[name]
archive = lab / name
if not archive.exists():
    partial = archive.with_suffix(".partial")
    with request(asset["browser_download_url"]) as source, partial.open("wb") as target:
        shutil.copyfileobj(source, target)
    verify(partial, asset)
    partial.replace(archive)
verify(archive, asset)
sdk = lab / "shared-sdk"
extract_selected(archive, sdk, name.removesuffix(".tar.bz2"), lambda p: p.suffix.lower() in {".dll", ".lib"} or p.name == "LICENSE")
destination = workspace / "src-tauri" / "resources" / "speech-runtime"
destination.mkdir(parents=True, exist_ok=True)
copied = []
for dll in sdk.rglob("*.dll"):
    shutil.copy2(dll, destination / dll.name)
    copied.append(dll.name)
print(json.dumps({"verified_native_sdk": name, "dlls": copied, "archive_directory": str(lab)}))
