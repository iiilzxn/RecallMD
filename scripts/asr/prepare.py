"""Prepare the retained Paraformer FP32 model for native, CPU-only ASR.

Uses only the Python standard library as a lab tool. The shipped application
does not need Python. Large models and native binaries stay in *.local/.
"""
from __future__ import annotations

import argparse
import bz2
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request

RELEASE_API = "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/"
RUNTIME_VERSION = "v1.13.8"
RUNTIME_ARCHIVE = f"sherpa-onnx-{RUNTIME_VERSION}-win-x64-shared-MT-Release-no-tts.tar.bz2"
MODELS = {
    "paraformer-bilingual-fp32": {
        "package": "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
        "required": ["encoder.onnx", "decoder.onnx", "tokens.txt"],
    },
}


def request(url: str):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "RecallMD-ASR-lab"}), timeout=60)


def release_assets(tag: str) -> dict:
    with request(RELEASE_API + tag) as response:
        return {asset["name"]: asset for asset in json.load(response)["assets"]}


def checksum(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify(path: Path, asset: dict) -> dict:
    actual_size = path.stat().st_size
    if actual_size != asset["size"]:
        raise ValueError(f"Incomplete archive: {path.name}: {actual_size} != {asset['size']}")
    digest = checksum(path)
    expected = asset.get("digest")
    if expected and expected != "sha256:" + digest:
        raise ValueError(f"Release checksum mismatch: {path.name}")
    return {"archive": path.name, "bytes": actual_size, "sha256": digest,
            "official_sha256_verified": expected is not None, "source": asset["browser_download_url"]}


def extract_selected(archive: Path, destination: Path, root_name: str, include) -> list[dict]:
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    # Drain the bzip2 stream even after tar's end marker, checking its final CRC.
    with bz2.open(archive, "rb") as compressed:
        with tarfile.open(fileobj=compressed, mode="r|") as tar:
            for member in tar:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or "\\" in member.name:
                    raise ValueError(f"Unsafe member: {member.name}")
                if not path.parts or path.parts[0] != root_name:
                    raise ValueError(f"Unexpected archive root: {member.name}")
                relative = PurePosixPath(*path.parts[1:])
                if not member.isfile() or not include(relative):
                    continue
                target = destination.joinpath(*relative.parts).resolve()
                if not target.is_relative_to(destination):
                    raise ValueError(f"Member leaves destination: {member.name}")
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                if target.stat().st_size != member.size:
                    raise ValueError(f"Truncated member: {member.name}")
                entries.append({"file": relative.as_posix(), "bytes": member.size})
        while compressed.read(1024 * 1024):
            pass
    return entries


def prepare_model(slug: str, definition: dict, downloads: Path, lab: Path, assets: dict) -> dict:
    name = definition["package"]
    archive = downloads / (name + ".tar.bz2")
    verified = verify(archive, assets[archive.name])
    required = set(definition["required"])
    def include(path: PurePosixPath) -> bool:
        return path.as_posix() in required or path.as_posix() in {"README.md", "LICENSE"} or (
            len(path.parts) > 1 and path.parts[0] == "test_wavs" and path.suffix.lower() in {".wav", ".txt"})
    entries = extract_selected(archive, lab / "models" / slug, name, include)
    extracted = {entry["file"] for entry in entries}
    if not required.issubset(extracted):
        raise ValueError(f"Missing required files in {name}: {required - extracted}")
    result = {"slug": slug, **verified, "bzip2_crc_and_tar_readable": True,
              "required_bytes": sum(e["bytes"] for e in entries if e["file"] in required), "files": entries}
    print(json.dumps({"model": slug, "ready": True, "model_mib": round(result["required_bytes"] / 2**20, 2),
                      "samples": sum(e["file"].endswith(".wav") for e in entries)}, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--lab", type=Path, required=True)
    args = parser.parse_args()
    lab = args.lab.resolve()
    lab.mkdir(parents=True, exist_ok=True)
    assets = release_assets("asr-models")
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(prepare_model, slug, model, args.downloads, lab, assets) for slug, model in MODELS.items()]
        models = [job.result() for job in jobs]
    manifest = {"models": models}
    (lab / "models.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    runtime_asset = release_assets(RUNTIME_VERSION)[RUNTIME_ARCHIVE]
    runtime_archive = lab / RUNTIME_ARCHIVE
    if not runtime_archive.exists():
        partial = runtime_archive.with_suffix(runtime_archive.suffix + ".partial")
        with request(runtime_asset["browser_download_url"]) as source, partial.open("wb") as target:
            shutil.copyfileobj(source, target)
        verify(partial, runtime_asset)
        partial.replace(runtime_archive)
    runtime = verify(runtime_archive, runtime_asset)
    runtime["files"] = extract_selected(runtime_archive, lab / "runtime", RUNTIME_ARCHIVE.removesuffix(".tar.bz2"),
                                       lambda p: p.suffix.lower() in {".exe", ".dll"} or p.name == "LICENSE")
    runtime["version"] = RUNTIME_VERSION
    (lab / "runtime.json").write_text(json.dumps(runtime, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"runtime": RUNTIME_VERSION, "verified": True, "files": len(runtime["files"])}), flush=True)


if __name__ == "__main__":
    main()
