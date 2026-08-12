"""OCR専用venv内で baidu/Unlimited-OCR を実行するCLI。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_NAME = "baidu/Unlimited-OCR"
DEFAULT_REVISION = "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead"
DEFAULT_PROMPT = "<image>\n<|grounding|>OCR this image. "
DEFAULT_OUTPUT_DIR = REPO_ROOT / "temp" / "unlimited_ocr_output"

PARSER_PATH = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_parser.py"

parser_spec = importlib.util.spec_from_file_location("unlimited_ocr_parser", PARSER_PATH)
if parser_spec is None or parser_spec.loader is None:
    raise RuntimeError(f"parserを読み込めません: {PARSER_PATH}")
parser_module = importlib.util.module_from_spec(parser_spec)
parser_spec.loader.exec_module(parser_module)
parse_grounding_output = parser_module.parse_grounding_output


def resolve_device(device: str) -> str:
    import torch

    if device == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA が使えません。--device cpu を指定してください。")
    return device


def load_model(device: str, revision: str):
    import torch
    from transformers import AutoModel, AutoTokenizer

    actual_device = resolve_device(device)
    dtype = torch.bfloat16 if actual_device == "cuda" else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_NAME,
        revision=revision,
        trust_remote_code=True,
    )
    model = AutoModel.from_pretrained(
        MODEL_NAME,
        revision=revision,
        trust_remote_code=True,
        use_safetensors=True,
        torch_dtype=dtype,
    )
    model = model.eval()
    if actual_device == "cuda":
        model = model.cuda()
    return tokenizer, model, actual_device


def mode_options(mode: str) -> dict[str, Any]:
    if mode == "gundam":
        return {"base_size": 1024, "image_size": 640, "crop_mode": True}
    return {"base_size": 1024, "image_size": 1024, "crop_mode": False}


def infer_image(
    tokenizer: Any,
    model: Any,
    image_path: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    started = time.monotonic()
    with Image.open(image_path) as image:
        image_width, image_height = image.size

    print(f"OCR: {image_path}", flush=True)
    raw_output = model.infer(
        tokenizer,
        prompt=args.prompt,
        image_file=str(image_path),
        output_path=str(DEFAULT_OUTPUT_DIR),
        eval_mode=True,
        save_results=False,
        max_length=args.max_length,
        no_repeat_ngram_size=args.no_repeat_ngram_size,
        ngram_window=args.ngram_window,
        temperature=args.temperature,
        **mode_options(args.mode),
    )
    elements = parse_grounding_output(str(raw_output or ""), image_width, image_height)
    result: dict[str, Any] = {
        "image": str(image_path),
        "image_width": image_width,
        "image_height": image_height,
        "elapsed_sec": round(time.monotonic() - started, 3),
        "elements": elements,
    }
    if args.include_raw:
        result["raw_output"] = raw_output
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Baidu Unlimited OCR を座標付きJSONとして実行します。"
    )
    parser.add_argument("--image", action="append", required=True, help="OCR対象画像。複数指定可。")
    parser.add_argument("--output-json", required=True, help="結果JSONの出力先。")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--mode", choices=("gundam", "base"), default="base")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--max-length", type=int, default=32768)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=35)
    parser.add_argument("--ngram-window", type=int, default=128)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--include-raw", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    os.environ.setdefault("HF_HOME", str(REPO_ROOT / "temp" / "hf_cache"))
    revision = os.environ.get("UNLIMITED_OCR_REVISION", DEFAULT_REVISION)
    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    tokenizer, model, actual_device = load_model(args.device, revision)
    results: list[dict[str, Any]] = []
    for image_arg in args.image:
        image_path = Path(image_arg).resolve()
        try:
            results.append(infer_image(tokenizer, model, image_path, args))
        except Exception as exc:
            results.append({"image": str(image_path), "error": str(exc)})

    output = {
        "schema_version": 1,
        "model": MODEL_NAME,
        "revision": revision,
        "device": actual_device,
        "results": results,
    }
    output_json = Path(args.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
