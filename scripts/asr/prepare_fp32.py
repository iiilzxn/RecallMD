"""Extract only Paraformer FP32 from the existing official download.

This entry point never downloads other models or the native runtime.
"""
import argparse
import json
from pathlib import Path
from prepare import MODELS, prepare_model, release_assets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--downloads", type=Path, required=True)
    parser.add_argument("--lab", type=Path, required=True)
    args = parser.parse_args()
    slug = "paraformer-bilingual-fp32"
    definition = MODELS[slug]
    if not (args.downloads / (definition["package"] + ".tar.bz2")).is_file():
        parser.error("Place the existing sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2 in --downloads first")
    lab = args.lab.resolve()
    lab.mkdir(parents=True, exist_ok=True)
    model = prepare_model(slug, definition, args.downloads, lab, release_assets("asr-models"))
    for name in ["models.json", "models-fp32.json"]:
        (lab / name).write_text(json.dumps({"models": [model]}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
