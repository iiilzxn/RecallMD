"""Measure the retained Paraformer FP32 model on official example WAVs.

No microphone capture and no recognition network requests. The Python process
only launches the official CPU binaries and reads Windows memory counters.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
import wave


class ProcessMemoryCounters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
            "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]


memory_info = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
memory_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
memory_info.restype = wintypes.BOOL


def memory_peak(process: subprocess.Popen) -> tuple[int, int]:
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    if memory_info(int(process._handle), ctypes.byref(counters), counters.cb):
        return counters.PeakWorkingSetSize, counters.PeakPagefileUsage
    return 0, 0


def commands(lab: Path, threads: int) -> dict[str, list[str]]:
    binary = lab / "runtime" / "bin"
    if not binary.exists():
        raise ValueError(f"Missing binary directory: {binary}")
    base = ["--provider=cpu", f"--num-threads={threads}"]
    paraformer = lab / "models" / "paraformer-bilingual-fp32"
    return {
        "paraformer-bilingual-fp32": [str(binary / "sherpa-onnx.exe"), *base,
            f"--paraformer-encoder={paraformer / 'encoder.onnx'}",
            f"--paraformer-decoder={paraformer / 'decoder.onnx'}", f"--tokens={paraformer / 'tokens.txt'}"],
    }


def run_one(command: list[str], sample: Path, log: Path, timeout: float) -> dict:
    with wave.open(str(sample), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
        format_info = {"sample_rate": audio.getframerate(), "channels": audio.getnchannels(), "sample_width": audio.getsampwidth()}
    started = time.perf_counter()
    peak_working = peak_commit = 0
    timed_out = False
    with log.open("wb") as output:
        process = subprocess.Popen([*command, str(sample)], stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        while True:
            working, committed = memory_peak(process)
            peak_working = max(peak_working, working)
            peak_commit = max(peak_commit, committed)
            if process.poll() is not None:
                break
            if time.perf_counter() - started > timeout:
                timed_out = True
                process.kill()
                process.wait()
                break
            time.sleep(0.01)
    wall_seconds = time.perf_counter() - started
    text = log.read_text(encoding="utf-8", errors="replace")
    elapsed = re.findall(r"Elapsed seconds:\s*([\d.eE+\-]+)", text)
    decode_seconds = float(elapsed[-1]) if elapsed else None
    results = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and "text" in value:
                results.append(value)
        except (ValueError, TypeError):
            pass
    # Streaming CLI can return multiple finalized segments; preserve all of them.
    transcript = " ".join(result["text"].strip() for result in results).strip()
    return {"exit_code": process.returncode, "timed_out": timed_out, "audio_seconds": duration, **format_info,
            "process_wall_seconds": round(wall_seconds, 4), "decode_seconds": decode_seconds,
            "decode_rtf": round(decode_seconds / duration, 4) if decode_seconds is not None and duration else None,
            "peak_working_set_mib": round(peak_working / 2**20, 2), "peak_private_commit_mib": round(peak_commit / 2**20, 2),
            "text": transcript, "segments": len(results)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    lab = args.lab.resolve()
    model_commands = commands(lab, args.threads)
    samples = {name: lab / "models" / "paraformer-bilingual-fp32" / "test_wavs" / name
               for name in ["0.wav", "1.wav", "8k.wav"]}
    log_dir = lab / "logs"
    log_dir.mkdir(exist_ok=True)
    runs = []
    for slug, command in model_commands.items():
        for sample_name, sample in samples.items():
            for repeat in range(args.repeats):
                log_name = f"{slug}-{sample_name}-{repeat + 1}.log"
                result = run_one(command, sample, log_dir / log_name, args.timeout)
                runs.append({"model": slug, "sample": sample_name, "repeat": repeat + 1, "log": "logs/" + log_name, **result})
                print(json.dumps({"model": slug, "sample": sample_name, "repeat": repeat + 1,
                                  "exit": result["exit_code"], "rtf": result["decode_rtf"],
                                  "peak_mib": result["peak_working_set_mib"], "text": result["text"]}, ensure_ascii=False), flush=True)
                (lab / "benchmark-runs.json").write_text(json.dumps(runs, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = []
    for slug in model_commands:
        selected = [r for r in runs if r["model"] == slug]
        successful = [r for r in selected if r["exit_code"] == 0 and r["decode_rtf"] is not None]
        summary.append({"model": slug, "successful_runs": len(successful), "runs": len(selected),
            "median_decode_rtf": round(statistics.median(r["decode_rtf"] for r in successful), 4) if successful else None,
            "max_peak_working_set_mib": max(r["peak_working_set_mib"] for r in selected),
            "max_peak_private_commit_mib": max(r["peak_private_commit_mib"] for r in selected),
            "median_process_wall_seconds": round(statistics.median(r["process_wall_seconds"] for r in successful), 4) if successful else None})
    report = {"runtime": "sherpa-onnx v1.13.8 Windows x64 native CPU", "threads": args.threads,
              "repeats": args.repeats, "sample_source": "Official model packages; no user microphone recording",
              "method": "Sequential native CLI runs; process timing includes model loading, native decode timing does not. OS-reported peak working set / private commitment sampled every 10 ms. File caches are not flushed. RTF is throughput, not live subtitle latency.",
              "summary": summary, "runs": runs}
    (lab / "benchmark.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": summary}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if os.name != "nt":
        raise SystemExit("This measurement script currently targets Windows memory counters.")
    main()
