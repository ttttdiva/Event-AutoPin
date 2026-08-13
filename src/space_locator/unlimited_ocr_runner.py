"""OCR専用venv内で baidu/Unlimited-OCR を実行するCLI。"""

from __future__ import annotations

import argparse
import copy
import html
import importlib.util
import json
import math
import os
import re
import hashlib
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

# runner は専用 venv から直接起動されるため、リポジトリの純stdlib設定を
# importlib で読み込む（本体 venv の依存を持ち込まない）。
CONFIG_PATH = Path(__file__).resolve().with_name("ocr_config.py")
config_spec = importlib.util.spec_from_file_location("ocr_config", CONFIG_PATH)
if config_spec is None or config_spec.loader is None:
    raise RuntimeError(f"OCR設定を読み込めません: {CONFIG_PATH}")
config_module = importlib.util.module_from_spec(config_spec)
sys.modules["ocr_config"] = config_module
config_spec.loader.exec_module(config_module)
UnlimitedOCRConfig = config_module.UnlimitedOCRConfig
DEFAULT_MODEL = config_module.DEFAULT_MODEL
DEFAULT_REVISION = config_module.DEFAULT_REVISION
DEFAULT_MODE = config_module.DEFAULT_MODE
DEFAULT_STRATEGY = config_module.DEFAULT_STRATEGY
model_requires_cuda = config_module.model_requires_cuda
DEFAULT_MODEL_CPU_UNSUPPORTED_REASON = config_module.DEFAULT_MODEL_CPU_UNSUPPORTED_REASON


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROMPT = "<image>\n<|grounding|>OCR this image. "
SMALL_DIGITS_PROMPT = (
    "<image>\n<|grounding|>OCR every small space number in this map. "
    "Return each number with its bounding box. "
)
LAYOUT_DIGITS_PROMPT = (
    "<image>\n<|grounding|>Given the layout of the image. "
)
_NUMERIC_TOKEN_RE = re.compile(r"^[0-9０-９]{1,2}$")
_NUMBER_RE = re.compile(r"(?<!\d)[0-9０-９]{1,2}(?!\d)")
MIN_FULL_FRAME_NUMBERS = 12


def should_tile(
    candidate_count: int,
    expected_candidate_count: int | None = None,
    min_coverage: float = 0.5,
) -> bool:
    """Decide fallback from OCR recall evidence, preserving legacy behavior."""
    count = max(0, int(candidate_count))
    expected = int(expected_candidate_count) if expected_candidate_count is not None else 0
    coverage = count / expected if expected > 0 else None
    if count < MIN_FULL_FRAME_NUMBERS:
        return True
    if expected > 0 and coverage is not None and coverage < min_coverage:
        return True
    return False


def _tile_decision(candidate_count: int, expected_candidate_count: int | None) -> dict[str, Any]:
    count = max(0, int(candidate_count))
    expected = int(expected_candidate_count) if expected_candidate_count is not None else 0
    coverage = count / expected if expected > 0 else None
    trigger_reason = None
    if count < MIN_FULL_FRAME_NUMBERS:
        trigger_reason = "below_legacy_minimum"
    elif expected > 0 and coverage is not None and coverage < 0.5:
        trigger_reason = "below_expected_coverage"
    return {
        "candidate_count": count,
        "expected_candidate_count": expected_candidate_count,
        "coverage": coverage,
        "trigger_reason": trigger_reason,
        "should_tile": should_tile(count, expected_candidate_count),
    }


def _contains_numeric_text(text: str) -> bool:
    normalized = html.unescape(str(text or ""))
    normalized = re.sub(r"<[^>]*>", " ", normalized)
    normalized = re.sub(r"[,，、;；|/／]+", " ", normalized)
    tokens = [token for token in re.split(r"\s+", normalized.strip()) if token]
    if not tokens:
        return False
    if len(tokens) == 1 and tokens[0].isdigit():
        compact = tokens[0]
        if 4 <= len(compact) <= 24 and len(compact) % 2 == 0:
            chunks = [compact[index : index + 2] for index in range(0, len(compact), 2)]
            if all(1 <= int(chunk) <= 99 for chunk in chunks):
                return True
    numeric = sum(bool(_NUMERIC_TOKEN_RE.fullmatch(token)) for token in tokens)
    separated_candidates = re.findall(r"(?<![\w])\d{1,2}(?!\d)", normalized)
    if len(separated_candidates) == 1 and re.search(r"(?:^|[\s\-‐‑‒–—−ー－])\d{1,2}(?!\d)", normalized):
        try:
            if 1 <= int(separated_candidates[0]) <= 99:
                return True
        except ValueError:
            pass
    # 小さい連番のtile出力には短い方位/装飾語（例「あ 01 02」）が
    # 混ざる。候補が2件以上で半数以上がnumericなら有効とする一方、
    # 長い自由文の数字は従来どおり拒否する。
    return numeric > 0 and (
        numeric / len(tokens) >= 0.8
        or (numeric >= 2 and numeric / len(tokens) >= 0.5 and len(tokens) <= 8)
        or (
            numeric == 1
            and bool(re.search(r"(?:^|\s|[-‐‑‒–—−ー－])[^\d]{1,24}?[-‐‑‒–—−ー－\s]+\d{1,2}(?!\d)", normalized))
        )
        or bool(re.search(r"<[^>]+>", str(text)))
    )


def _structured_table_has_numbers(text: str) -> bool:
    """table結果を成功扱いする前に、行・セル・数字の構造を検査する。

    `<table>`という長大な説明文字列だけでは成功扱いにしない。DOMの
    行/セルが存在し、少なくとも一つのセルに1〜99の数字候補があり、
    後段が座標を割り当てられる形式だけを有効とする。
    """
    rows = re.findall(r"<\s*tr\b[^>]*>(.*?)<\s*/\s*tr\s*>", str(text or ""), re.I | re.S)
    if not rows:
        return False
    numeric_cells = 0
    for row in rows:
        cells = re.findall(r"<\s*(?:td|th)\b[^>]*>(.*?)<\s*/\s*(?:td|th)\s*>", row, re.I | re.S)
        for cell in cells:
            candidates = [int(x.translate(str.maketrans("０１２３４５６７８９", "0123456789"))) for x in _NUMBER_RE.findall(re.sub(r"<[^>]*>", " ", cell))]
            if any(1 <= value <= 99 for value in candidates):
                numeric_cells += 1
    return numeric_cells > 0


def _valid_numeric_element(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    try:
        if not (float(item["x1"]) < float(item["x2"]) and float(item["y1"]) < float(item["y2"])):
            return False
    except (KeyError, TypeError, ValueError):
        return False
    text = str(item.get("text", ""))
    if re.search(r"<\s*table\b", text, re.I):
        return _structured_table_has_numbers(text)
    return _contains_numeric_text(text)


def _numeric_element_count(elements: list[dict[str, Any]]) -> int:
    """grounding要素に含まれる番号候補数を概算する。

    Unlimited OCRは番号列を1つのbboxへまとめるため、要素数だけでは
    full-frameの成否を判定できない。ここではfallback発火判定だけに使い、
    最終的な厳密な契約変換は ``ocr_engine._elements_to_numbers`` に任せる。
    """
    count = 0
    for item in elements:
        if not _valid_numeric_element(item):
            continue
        text = html.unescape(str(item.get("text", "")))
        plain = re.sub(r"<[^>]*>", " ", text)
        candidates = _NUMBER_RE.findall(plain)
        if candidates:
            count += len(candidates)
            continue
        compact = re.sub(r"\s+", "", plain)
        if compact.isdigit() and 4 <= len(compact) <= 24 and len(compact) % 2 == 0:
            count += len(compact) // 2
        else:
            count += 1
    return count


def _unique_numeric_element_count(elements: list[dict[str, Any]]) -> int:
    candidates: list[tuple[str, float, float]] = []
    for item in elements:
        if not _valid_numeric_element(item):
            continue
        values = _NUMBER_RE.findall(re.sub(r"<[^>]*>", " ", html.unescape(str(item.get("text", "")))))
        if not values:
            values = [str(item.get("text", "")).strip()]
        try:
            cx = (float(item["x1"]) + float(item["x2"])) / 2
            cy = (float(item["y1"]) + float(item["y2"])) / 2
        except (KeyError, TypeError, ValueError):
            continue
        for value in values:
            normalized = value.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
            if not normalized.isdigit() or not 1 <= int(normalized) <= 99:
                continue
            token = f"{int(normalized):02d}"
            tolerance = min(36.0, max(18.0, 0.6 * max(float(item["x2"]) - float(item["x1"]), float(item["y2"]) - float(item["y1"]))))
            if any(
                existing == token and math.hypot(ex - cx, ey - cy) <= tolerance
                for existing, ex, ey in candidates
            ):
                continue
            candidates.append((token, cx, cy))
    return len(candidates)
DEFAULT_OUTPUT_DIR = REPO_ROOT / "temp" / "unlimited_ocr_output"

PARSER_PATH = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_parser.py"

parser_spec = importlib.util.spec_from_file_location("unlimited_ocr_parser", PARSER_PATH)
if parser_spec is None or parser_spec.loader is None:
    raise RuntimeError(f"parserを読み込めません: {PARSER_PATH}")
parser_module = importlib.util.module_from_spec(parser_spec)
parser_spec.loader.exec_module(parser_module)
parse_grounding_output = parser_module.parse_grounding_output


def resolve_device(
    device: str,
    *,
    model_source: str = DEFAULT_MODEL,
    revision: str = DEFAULT_REVISION,
) -> str:
    import torch

    cuda_available = torch.cuda.is_available()
    if device == "auto":
        actual = "cuda" if cuda_available else "cpu"
    else:
        actual = device
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA が使えません。CUDA対応PCを使うか、CPU対応モデルを設定して --device cpu を指定してください。"
        )
    if actual == "cpu" and model_requires_cuda(
        model=DEFAULT_MODEL if Path(model_source).expanduser().exists() else model_source,
        revision=revision,
        model_path=model_source if Path(model_source).expanduser().exists() else None,
    ):
        raise RuntimeError(
            "cpu_unsupported: " + DEFAULT_MODEL_CPU_UNSUPPORTED_REASON
            + "。CUDA搭載PCで --device cuda/auto を使うか、CPU対応モデルへ切り替えてください。"
        )
    return actual


def load_model(
    device: str,
    revision: str = DEFAULT_REVISION,
    model_source: str = DEFAULT_MODEL,
):
    import torch
    from transformers import AutoModel, AutoTokenizer

    actual_device = resolve_device(
        device, model_source=model_source, revision=revision
    )
    dtype = torch.bfloat16 if actual_device == "cuda" else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(
        model_source,
        revision=revision,
        trust_remote_code=True,
    )
    model = AutoModel.from_pretrained(
        model_source,
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
    attempts: list[dict[str, Any]] = []
    # 小さい連番向けの gundam + 専用プロンプトを優先し、結果が空の場合だけ
    # base/全文OCRへフォールバックする。モデルを二重ロードせず同一インスタンスを
    # 再利用するため、配布先のGPUメモリを圧迫しない。
    strategy = str(getattr(args, "strategy", "balanced") or "balanced").lower()
    requested_max_length = max(1, int(getattr(args, "max_length", 4096) or 4096))
    if strategy == "small_digits":
        first_mode = getattr(args, "mode", None) or "gundam"
        first_prompt = getattr(args, "prompt", None) or SMALL_DIGITS_PROMPT
        # 小さい番号の検出では長大な出力を許可しても精度向上が見込めず、
        # GPUメモリ・待ち時間だけが増える。明示的に32kを選んだ場合も
        # この戦略の各試行は4k/8kへ制限し、baseフォールバックを現実的に
        # 完了させる（他戦略では要求値をそのまま使用）。
        primary_max_length = min(requested_max_length, 4096)
        fallback_max_length = min(max(requested_max_length, 4096), 8192)
        attempt_specs = [(first_mode, first_prompt, primary_max_length)]
        if getattr(args, "fallback", True):
            fallback_mode = "base" if first_mode == "gundam" else "gundam"
            attempt_specs.append((fallback_mode, DEFAULT_PROMPT, fallback_max_length))
    elif strategy == "gundam_then_base":
        attempt_specs = [
            ("gundam", getattr(args, "prompt", None) or DEFAULT_PROMPT, requested_max_length),
            ("base", DEFAULT_PROMPT, requested_max_length),
        ]
    else:
        attempt_specs = [
            (getattr(args, "mode", "gundam"), getattr(args, "prompt", None) or DEFAULT_PROMPT, requested_max_length)
        ]

    raw_output = ""
    elements: list[dict[str, Any]] = []
    for attempt_mode, attempt_prompt, attempt_max_length in attempt_specs:
        raw_output = model.infer(
            tokenizer,
            prompt=attempt_prompt,
            image_file=str(image_path),
            output_path=str(DEFAULT_OUTPUT_DIR),
            eval_mode=True,
            save_results=False,
            max_length=attempt_max_length,
            no_repeat_ngram_size=args.no_repeat_ngram_size,
            ngram_window=args.ngram_window,
            temperature=args.temperature,
            **mode_options(attempt_mode),
        )
        parsed = parse_grounding_output(str(raw_output or ""), image_width, image_height)
        attempts.append(
            {
                "mode": attempt_mode,
                "prompt": attempt_prompt,
                "max_length": attempt_max_length,
                "elements": len(parsed),
            }
        )
        has_numeric = any(_valid_numeric_element(item) for item in parsed)
        if parsed and has_numeric:
            elements = parsed
            break
        if parsed:
            # 座標は取れたが「image」「table」等の非番号だけだった場合も
            # 小さい連番フォールバックを試す。
            elements = parsed
    result: dict[str, Any] = {
        "image": str(image_path),
        "image_width": image_width,
        "image_height": image_height,
        "elapsed_sec": round(time.monotonic() - started, 3),
        "elements": elements,
        "strategy": strategy,
        "max_length": requested_max_length,
        "attempts": attempts,
    }
    if args.include_raw:
        result["raw_output"] = str(raw_output or "")
    return result


def _tile_origins(width: int, height: int, size: int, overlap: int, max_count: int = 32) -> list[tuple[int, int]]:
    if size <= 0 or (width <= size and height <= size):
        return []
    stride = max(1, size - max(0, overlap))
    xs = list(range(0, max(width - size, 0) + 1, stride))
    ys = list(range(0, max(height - size, 0) + 1, stride))
    if xs[-1] != max(width - size, 0):
        xs.append(max(width - size, 0))
    if ys[-1] != max(height - size, 0):
        ys.append(max(height - size, 0))
    coarse = [(x, y) for y in ys for x in xs]
    # 会場図は「画像全体の粗い走査」だけでは、番号列がcropの端へ入り
    # gundamが artwork を優先する場合がある。絶対座標は使わず、画像寸法
    # から上半分中央（横番号列）と右端（縦番号列）のdetail ROIを作る。
    # 小さい明示上限では従来どおりcoarseのみとし、CLIの上限契約を守る。
    detail: list[tuple[int, int]] = []
    if max_count >= 64 and width > size * 3 and height > size * 2:
        quantum = max(1, size // 16)
        x_step = max(1, round((size * 5 / 8) / quantum) * quantum)
        y_step = max(1, round((size / 3) / quantum) * quantum)
        x_start = max(0, (width // 3 // x_step) * x_step)
        x_end = max(x_start, width - size - size // 2)
        y_start = min(max(0, size + size // 4), max(0, height - size))
        y_end = min(max(0, height - size), height // 2)
        for y in range(y_start, y_end + 1, y_step):
            for x in range(x_start, x_end + 1, x_step):
                detail.append((min(x, width - size), min(y, height - size)))
        right_x = max(0, width - size)
        for y in range(y_step, min(max(0, height - size), height * 2 // 3) + 1, y_step):
            detail.append((right_x, y))
        detail = list(dict.fromkeys(detail))

    coarse_limit = max_count - len(detail) if max_count > 0 else 0
    origins = coarse
    if coarse_limit > 0 and len(coarse) > coarse_limit:
        # 画像全体を均等に覆うよう、先頭だけに偏らず等間隔で間引く。
        if coarse_limit == 1:
            origins = [coarse[0]]
        else:
            indexes = [round(i * (len(coarse) - 1) / (coarse_limit - 1)) for i in range(coarse_limit)]
            origins = [coarse[index] for index in indexes]
    origins = list(dict.fromkeys(origins + detail))
    if max_count > 0:
        origins = origins[:max_count]
    return origins


def _write_tiles(image_path: Path, size: int, overlap: int, max_count: int = 32) -> tuple[list[Path], list[tuple[int, int]]]:
    with Image.open(image_path) as image:
        origins = _tile_origins(image.width, image.height, size, overlap, max_count)
        if not origins:
            return [], []
        tile_dir = DEFAULT_OUTPUT_DIR / "tiles" / uuid.uuid4().hex
        tile_dir.mkdir(parents=True, exist_ok=True)
        paths: list[Path] = []
        try:
            for index, (x, y) in enumerate(origins):
                tile_path = tile_dir / f"{image_path.stem}_{index:04d}.png"
                image.crop((x, y, min(x + size, image.width), min(y + size, image.height))).save(tile_path)
                paths.append(tile_path)
        except Exception:
            for path in tile_dir.glob("*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
            try:
                tile_dir.rmdir()
            except OSError:
                pass
            raise
        return paths, origins


def _edge_cover_origins(length: int, crop: int) -> list[int]:
    if crop >= length:
        return [0]
    count = max(2, math.ceil(length / crop))
    return list(dict.fromkeys(round(index * (length - crop) / (count - 1)) for index in range(count)))


def _content_y_origin(image: Image.Image, x: int, crop_width: int, crop_height: int) -> int:
    max_y = max(0, image.height - crop_height)
    if max_y == 0:
        return 0
    grayscale = image.convert("L")
    inset = 12
    left, right = min(image.width, x + inset), max(x + inset + 1, min(image.width, x + crop_width - inset))
    search_start = round(max_y * 0.25)
    search_end = round(max_y * 0.75)
    best = (0, round((search_start + search_end) / 2))
    candidates = list(range(search_start, search_end + 1, 8))
    if not candidates or candidates[-1] != search_end:
        candidates.append(search_end)
    for y in candidates:
        band = grayscale.crop((left, y, right, min(image.height, y + crop_height)))
        histogram = band.histogram()
        dark = sum(histogram[:140])
        # Ignore isolated logo/artwork noise; favor broad numeric-layout ink.
        score = dark if dark >= max(3, band.width * 3) else 0
        candidate = (score, -abs(y - max_y // 2), -y)
        if candidate > (best[0], -abs(best[1] - max_y // 2), -best[1]):
            best = (score, y)
    return best[1]


def _context_rectangles(image: Image.Image) -> tuple[tuple[int, int], list[tuple[int, int]]]:
    width, height = image.size
    short = min(min(width, height), 640)
    short = min(short, 512)
    long = min(max(width, height), round(short * 1.5))
    rect_width, rect_height = (short, long) if height >= width else (long, short)
    # Preserve the useful 512x768 context on ordinary maps. For large maps,
    # enlarge it proportionally until complete edge-to-edge coverage plus one
    # content-aligned row per x strip fits within the inference budget.
    # At most nine rectangles keeps A+C within 18 calls; together with the
    # full-frame primary/fallback attempts this preserves the 20-call budget.
    max_rectangles = 9
    while True:
        xs = _edge_cover_origins(width, rect_width)
        ys = _edge_cover_origins(height, rect_height)
        possible_count = len(xs) * (len(ys) + (1 if rect_height < height else 0))
        if possible_count <= max_rectangles:
            break
        growth = max(1.05, math.sqrt(possible_count / max_rectangles))
        next_width = min(width, max(rect_width + 1, math.ceil(rect_width * growth)))
        next_height = min(height, max(rect_height + 1, math.ceil(rect_height * growth)))
        if (next_width, next_height) == (rect_width, rect_height):
            break
        rect_width, rect_height = next_width, next_height

    origins: list[tuple[int, int]] = []
    for x in xs:
        content_y = _content_y_origin(image, x, rect_width, rect_height)
        for y in sorted(set([*ys, content_y])):
            origins.append((x, y))
    return (rect_width, rect_height), origins


def _write_context_rectangles(image_path: Path) -> tuple[list[Path], list[tuple[int, int]], tuple[int, int]]:
    with Image.open(image_path) as image:
        size, origins = _context_rectangles(image)
        rect_width, rect_height = size
        tile_dir = DEFAULT_OUTPUT_DIR / "tiles" / uuid.uuid4().hex
        tile_dir.mkdir(parents=True, exist_ok=True)
        paths: list[Path] = []
        try:
            for index, (x, y) in enumerate(origins):
                path = tile_dir / f"{image_path.stem}_context_{index:02d}.png"
                image.crop((x, y, x + rect_width, y + rect_height)).save(path)
                paths.append(path)
        except Exception:
            for path in tile_dir.glob("*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
            try:
                tile_dir.rmdir()
            except OSError:
                pass
            raise
        return paths, origins, size


def _safe_inference_error(exc: Exception, error_code: str) -> dict[str, str]:
    """Return bounded diagnostics without exposing exception messages or paths."""
    error_type = re.sub(r"[^A-Za-z0-9_.-]", "_", type(exc).__name__)[:80]
    return {
        "error_code": error_code,
        "type": error_type or "Exception",
    }


def _merge_tile_results(
    image_path: Path,
    tile_paths: list[Path],
    origins: list[tuple[int, int]],
    tokenizer: Any,
    model: Any,
    args: argparse.Namespace,
    diagnostics: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    # full-frame向けsmall_digits promptはcropでは説明文やimage要素へ
    # 退行しやすい。実マップで再現性が得られたgundam + 標準groundingを
    # tile専用に使い、呼び出し元argsやモデルinstanceは変更しない。
    tile_args = copy.copy(args)
    tile_args.strategy = "single"
    tile_args.mode = "gundam"
    tile_args.prompt = DEFAULT_PROMPT
    tile_args.fallback = False
    tile_args.max_length = min(max(1, int(getattr(args, "max_length", 4096) or 4096)), 4096)
    for tile_index, (tile_path, (origin_x, origin_y)) in enumerate(zip(tile_paths, origins)):
        try:
            tile_result = infer_image(tokenizer, model, tile_path, tile_args)
        except Exception as exc:
            if diagnostics is not None:
                diagnostics.append(
                    {
                        "tile_index": tile_index,
                        "origin": [origin_x, origin_y],
                        **_safe_inference_error(exc, "tile_inference_failed"),
                    }
                )
            continue
        for element in tile_result.get("elements", []):
            if not isinstance(element, dict):
                continue
            text = str(element.get("text", ""))
            if not _contains_numeric_text(text) and not _structured_table_has_numbers(text):
                continue
            try:
                shifted = dict(element)
                shifted["x1"] = float(element["x1"]) + origin_x
                shifted["x2"] = float(element["x2"]) + origin_x
                shifted["y1"] = float(element["y1"]) + origin_y
                shifted["y2"] = float(element["y2"]) + origin_y
            except (KeyError, TypeError, ValueError):
                continue
            merged.append(shifted)
    return merged


def _merge_context_results(
    paths: list[Path],
    origins: list[tuple[int, int]],
    tokenizer: Any,
    model: Any,
    args: argparse.Namespace,
    prompt: str,
    diagnostics: list[dict[str, Any]],
    tier: str,
) -> list[dict[str, Any]]:
    context_args = copy.copy(args)
    context_args.strategy = "single"
    context_args.mode = "gundam"
    context_args.prompt = prompt
    context_args.fallback = False
    context_args.max_length = min(max(1, int(getattr(args, "max_length", 4096) or 4096)), 4096)
    merged: list[dict[str, Any]] = []
    for index, (path, (origin_x, origin_y)) in enumerate(zip(paths, origins)):
        started = time.monotonic()
        with Image.open(path) as crop:
            crop_size = [crop.width, crop.height]
        try:
            output = infer_image(tokenizer, model, path, context_args)
        except Exception as exc:
            diagnostics.append({
                "tier": tier,
                "rectangle_index": index,
                "origin": [origin_x, origin_y],
                "size": crop_size,
                "elapsed_sec": round(time.monotonic() - started, 3),
                **_safe_inference_error(exc, "context_inference_failed"),
            })
            continue
        raw = str(output.get("raw_output") or "")
        valid_elements = [element for element in output.get("elements", []) if _valid_numeric_element(element)]
        diagnostics.append({
            "tier": tier,
            "rectangle_index": index,
            "origin": [origin_x, origin_y],
            "size": crop_size,
            "prompt": "standard" if prompt == DEFAULT_PROMPT else "layout",
            "elapsed_sec": round(time.monotonic() - started, 3),
            "crop_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "raw_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest() if raw else None,
            "element_count": len(output.get("elements", [])),
            "numeric_count": _unique_numeric_element_count(valid_elements),
        })
        for element in output.get("elements", []):
            if not _valid_numeric_element(element):
                continue
            shifted = dict(element)
            shifted["x1"] = float(element["x1"]) + origin_x
            shifted["x2"] = float(element["x2"]) + origin_x
            shifted["y1"] = float(element["y1"]) + origin_y
            shifted["y2"] = float(element["y2"]) + origin_y
            merged.append(shifted)
    return merged


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Baidu Unlimited OCR を座標付きJSONとして実行します。"
    )
    parser.add_argument("--image", action="append", required=True, help="OCR対象画像。複数指定可。")
    parser.add_argument("--output-json", required=True, help="結果JSONの出力先。")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default=None)
    parser.add_argument("--mode", choices=("gundam", "base"), default=None)
    parser.add_argument("--strategy", choices=("small_digits", "balanced", "single", "gundam_then_base"), default=None)
    parser.add_argument("--fallback", action=argparse.BooleanOptionalAction, default=True, help="small_digitsでbaseフォールバックを許可")
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--model", default=None, help="Hugging FaceモデルIDまたはローカルディレクトリ")
    parser.add_argument("--model-path", default=None, help="--modelより優先するローカルモデルパス")
    parser.add_argument("--hf-home", default=None, help="Hugging Faceキャッシュディレクトリ")
    parser.add_argument("--revision", default=None)
    parser.add_argument("--max-length", type=int, default=None)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=None)
    parser.add_argument("--ngram-window", type=int, default=None)
    parser.add_argument("--temperature", type=float, default=None)
    parser.add_argument("--include-raw", action="store_true")
    parser.add_argument("--tile-size", type=int, default=0, help="0=無効。小数字失敗時に重複タイルを推論")
    parser.add_argument("--tile-overlap", type=int, default=None)
    parser.add_argument("--tile-max-count", type=int, default=None)
    parser.add_argument("--no-tile-fallback", action="store_true")
    parser.add_argument("--expected-candidate-count", type=int, default=None)
    return parser.parse_args()


def _apply_tile_fallback(
    image_path: Path,
    result: dict[str, Any],
    tokenizer: Any,
    model: Any,
    args: argparse.Namespace,
) -> None:
    candidate_count = _numeric_element_count(
        [item for item in result.get("elements", []) if isinstance(item, dict)]
    )
    result["tile_decision"] = _tile_decision(
        candidate_count,
        getattr(args, "expected_candidate_count", None),
    )
    tile_needed = bool(result["tile_decision"]["should_tile"])
    if not tile_needed or args.no_tile_fallback or args.tile_size <= 0:
        return
    context_paths, context_origins, context_size = _write_context_rectangles(image_path)
    context_calls: list[dict[str, Any]] = []
    context_tiers: list[dict[str, Any]] = []
    try:
        context_a = _merge_context_results(
            context_paths, context_origins, tokenizer, model, args, DEFAULT_PROMPT, context_calls, "A"
        )
        result["elements"] = list(result.get("elements", [])) + context_a
        count_a = _unique_numeric_element_count(result["elements"])
        context_tiers.append({"tier": "A", "prompt": DEFAULT_PROMPT, "numeric_count": count_a})
        if should_tile(count_a, getattr(args, "expected_candidate_count", None)):
            context_c = _merge_context_results(
                context_paths, context_origins, tokenizer, model, args, LAYOUT_DIGITS_PROMPT, context_calls, "C"
            )
            result["elements"] = list(result.get("elements", [])) + context_c
            count_c = _unique_numeric_element_count(result["elements"])
            context_tiers.append({"tier": "C", "prompt": LAYOUT_DIGITS_PROMPT, "numeric_count": count_c})
        final_context_count = _numeric_element_count(result["elements"])
        context_errors = [call for call in context_calls if call.get("error_code")]
        result["context_fallback"] = {
            "enabled": True,
            "rectangle_size": list(context_size),
            "rectangle_count": len(context_paths),
            "tiers": context_tiers,
            "call_count": len(context_calls),
            "calls": context_calls[:20],
            "error_count": len(context_errors),
            "errors": context_errors[:20],
        }
    finally:
        context_root = (DEFAULT_OUTPUT_DIR / "tiles").resolve()
        for context_dir in {path.parent.resolve() for path in context_paths}:
            if context_dir.parent != context_root:
                continue
            for path in context_paths:
                if path.parent.resolve() == context_dir:
                    path.unlink(missing_ok=True)
            try:
                context_dir.rmdir()
            except OSError:
                pass
    if not should_tile(
        _unique_numeric_element_count(result.get("elements", [])),
        getattr(args, "expected_candidate_count", None),
    ):
        return
    if getattr(args, "expected_candidate_count", None) is not None:
        return
    tile_paths, origins = _write_tiles(
        image_path, args.tile_size, args.tile_overlap, args.tile_max_count
    )
    tile_errors: list[dict[str, Any]] = []
    try:
        tiled = _merge_tile_results(
            image_path,
            tile_paths,
            origins,
            tokenizer,
            model,
            args,
            diagnostics=tile_errors,
        )
    finally:
        tile_root = (DEFAULT_OUTPUT_DIR / "tiles").resolve()
        tile_dirs = {path.parent.resolve() for path in tile_paths}
        for tile_dir in tile_dirs:
            if tile_dir.parent != tile_root:
                continue
            for tile_path in tile_paths:
                if tile_path.parent.resolve() == tile_dir:
                    tile_path.unlink(missing_ok=True)
            try:
                tile_dir.rmdir()
            except OSError:
                pass
    if tiled:
        result["elements"] = list(result.get("elements", [])) + tiled
        result["tile_fallback"] = {
            "enabled": True,
            "tile_size": args.tile_size,
            "tile_overlap": args.tile_overlap,
            "tile_count": len(tile_paths),
            "numeric_elements": len(tiled),
            "tile_strategy": "single_gundam_grounding",
            "error_count": len(tile_errors),
            "errors": tile_errors[:20],
        }
    else:
        result["tile_fallback"] = {
            "enabled": True,
            "tile_count": len(tile_paths),
            "numbers": 0,
            "error_count": len(tile_errors),
            "errors": tile_errors[:20],
        }


def main() -> int:
    args = parse_args()
    env_config = UnlimitedOCRConfig.from_env()
    # CLI指定を設定へ上書きし、desktop bridgeから渡された環境変数も尊重する。
    mapping = {
        "model": args.model,
        "model_path": args.model_path,
        "hf_home": args.hf_home,
        "revision": args.revision,
        "device": args.device,
        "mode": args.mode,
        "strategy": args.strategy,
        "prompt": args.prompt,
        "max_length": args.max_length,
        "no_repeat_ngram_size": args.no_repeat_ngram_size,
        "ngram_window": args.ngram_window,
        "temperature": args.temperature,
        "tile_fallback": False if args.no_tile_fallback else None,
        "tile_size": args.tile_size or None,
        "tile_overlap": args.tile_overlap,
        "tile_max_count": args.tile_max_count,
    }
    config = UnlimitedOCRConfig.from_mapping(mapping, base=env_config)
    if config.hf_home:
        os.environ["HF_HOME"] = str(Path(config.hf_home).expanduser())
        os.environ["HF_HUB_CACHE"] = str(Path(config.hf_home).expanduser() / "hub")
        for alias in ("TRANSFORMERS_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_DATASETS_CACHE", "HF_MODULES_CACHE"):
            os.environ.pop(alias, None)
    else:
        os.environ.setdefault("HF_HOME", str(REPO_ROOT / "temp" / "hf_cache"))
    # infer_imageはargparse Namespaceを受け取る既存テスト互換のため、正規化済み
    # 設定値を引き続きargsへ反映する。
    args.model = config.model
    args.model_path = config.model_path
    args.hf_home = config.hf_home
    args.revision = config.revision
    args.device = config.device
    args.mode = config.mode
    args.strategy = config.strategy
    args.prompt = config.prompt
    args.max_length = config.max_length
    args.no_repeat_ngram_size = config.no_repeat_ngram_size
    args.ngram_window = config.ngram_window
    args.temperature = config.temperature
    args.tile_size = config.tile_size if config.tile_fallback else 0
    args.tile_overlap = config.tile_overlap
    args.tile_max_count = config.tile_max_count
    args.no_tile_fallback = not config.tile_fallback
    revision = config.revision
    model_source = config.model_source()
    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_json = Path(args.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)

    try:
        if model_source == DEFAULT_MODEL:
            # 既存の外部呼び出し（load_model(device, revision)）との互換性を維持。
            tokenizer, model, actual_device = load_model(args.device, revision)
        else:
            tokenizer, model, actual_device = load_model(
                args.device, revision=revision, model_source=model_source
            )
    except Exception as exc:
        error = str(exc)
        error_code = "cpu_unsupported" if error.startswith("cpu_unsupported:") else "model_load_failed"
        output_json.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "model": model_source,
                    "revision": revision,
                    "device": args.device,
                    "results": [
                        {
                            "image": str(Path(image_arg).resolve()),
                            "error_code": error_code,
                            "error": error,
                        }
                        for image_arg in args.image
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Unlimited OCR runner: {error}", file=sys.stderr, flush=True)
        return 2
    results: list[dict[str, Any]] = []
    for image_arg in args.image:
        image_path = Path(image_arg).resolve()
        try:
            result = infer_image(tokenizer, model, image_path, args)
            # full-frameの番号候補が少ないときだけ、安全な重複tileへ
            # 切り替える。番号列は1bboxへまとまるためtoken概算で判定する。
            _apply_tile_fallback(image_path, result, tokenizer, model, args)
            results.append(result)
        except Exception as exc:
            results.append({"image": str(image_path), "error": str(exc)})

    output = {
        "schema_version": 1,
        "model": model_source,
        "revision": revision,
        "device": actual_device,
        "results": results,
    }
    output_json.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    # 画像単位のエラーをJSONへ残したうえで、全画像失敗は呼び出し側が
    # 成功扱いしないよう非0で返す。部分成功はJSONの診断を利用できるため
    # 0（呼び出し側で結果ごとのerrorを確認）とする。
    if not results:
        print("Unlimited OCR runner: 結果が空です", file=sys.stderr, flush=True)
        return 2
    if all(isinstance(item, dict) and item.get("error") for item in results):
        print("Unlimited OCR runner: すべての画像で推論に失敗しました", file=sys.stderr, flush=True)
        return 2
    valid_numeric_results = sum(
        1
        for item in results
        if isinstance(item, dict)
        and any(
            _valid_numeric_element(element)
            for element in item.get("elements", [])
            if isinstance(element, dict)
        )
    )
    if valid_numeric_results == 0:
        print(
            "Unlimited OCR runner: 座標付きの妥当なnumeric要素がありません "
            "（image/table長大出力だけでは成功扱いしません）",
            file=sys.stderr,
            flush=True,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
