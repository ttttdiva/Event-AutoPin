#!/usr/bin/env python3
"""
OCRエンジン - 座標付き番号検出

マップ画像から番号とその座標を検出します。
"""

import json
import os
import re
import subprocess
import tempfile
import cv2
from pathlib import Path
from typing import Dict, List, Any, Optional
from statistics import median
import logging
import math
import unicodedata
import html
from html.parser import HTMLParser

from .ocr_config import UnlimitedOCRConfig


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_runner.py"
UNLIMITED_OCR_VARIANT = "unlimited_ocr_0"
NUMBER_TOKEN_RE = re.compile(r"\d{1,2}")
HTML_TAG_RE = re.compile(r"<[^>]*>")
HTML_BREAK_RE = re.compile(r"<\s*/?\s*(?:br|td|th|tr|table|p|div|li|ul|ol)\b[^>]*>", re.IGNORECASE)


def _normalize_ocr_text(text: str) -> str:
    """モデルが返すHTML/table形式のテキストを番号抽出用に正規化する。

    Unlimited-OCR の実マップ出力は ``<table><tr><td>01`` のような
    grouped text を返す場合がある。タグを単純に削除すると隣接した番号が
    連結するため、セル・行境界を空白へ変換してからタグを除去する。
    既存の空白区切り出力や全角数字も同じ経路で扱う。
    """
    value = html.unescape(str(text or ""))
    value = HTML_BREAK_RE.sub(" ", value)
    value = HTML_TAG_RE.sub(" ", value)
    value = unicodedata.normalize("NFKC", value)
    # grouped outputで使われる区切りを token 境界へ揃える。
    value = re.sub(r"[,，、;；|/／]+", " ", value)
    return " ".join(value.split())


def _resolve_ocr_python(venv_override: str | Path | None = None) -> Path:
    venv_dir = Path(
        venv_override
        or os.environ.get("UNLIMITED_OCR_VENV", REPO_ROOT / "temp" / "unlimited_ocr_venv")
    )
    python_path = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python_path.exists():
        setup_command = (
            "scripts\\setup_unlimited_ocr.bat"
            if os.name == "nt"
            else "python3 scripts/setup_unlimited_ocr.py"
        )
        raise RuntimeError(
            f"Unlimited OCR環境が未構築です。{setup_command} を実行してください"
        )
    return python_path


def _number_from_text(text: str) -> int | None:
    stripped = _normalize_ocr_text(text)
    if NUMBER_TOKEN_RE.fullmatch(stripped):
        value = int(stripped)
        if 1 <= value <= 99:
            return value
    # Prefix付き番号は、単一英字（A-01/P-12）または数字を含まない
    # 非ASCII名称（企業-01）だけ許可する。AB-12、2025-01、123-45、
    # 2025/01のような日付・長いIDは番号候補へ落とさない。
    match = re.fullmatch(
        r"(?P<prefix>.+?)(?:\s*[-‐‑‒–—−ー－]\s*|\s+)(?P<number>\d{1,2})",
        stripped,
    )
    if match:
        prefix = match.group("prefix").strip()
        allowed_ascii_prefix = bool(re.fullmatch(r"[A-Za-z]", prefix))
        allowed_named_prefix = (
            bool(prefix)
            and not re.search(r"[0-9A-Za-z]", prefix)
            and any(ord(char) > 127 for char in prefix)
        )
        value = int(match.group("number"))
        if (allowed_ascii_prefix or allowed_named_prefix) and 1 <= value <= 99:
            return value
    return None


def _split_numeric_tokens(text: str) -> list[tuple[int, int, int]]:
    original = str(text or "")
    # 年月や長い数値IDを ``/`` 区切りの番号グループと誤認しない。
    # 例: 2025/01, 2025-01, 123/45。
    if re.fullmatch(r"\s*\d{3,}\s*[-/／‐‑‒–—−ー－]\s*\d{1,2}\s*", original):
        return []
    normalized = _normalize_ocr_text(original)
    raw_tokens = [token for token in re.split(r"\s+", normalized.strip()) if token]
    if not raw_tokens:
        return []

    # OCRが空白を落として ``04050607`` のように連結するケースは、
    # 2桁固定の候補列としてのみ分割する。長いID/日付を番号列へ捏造
    # しないため24桁（最大12番号）までに制限し、各チャンクを1〜99で
    # 検証する。
    if len(raw_tokens) == 1 and raw_tokens[0].isdigit():
        compact = raw_tokens[0]
        if len(compact) >= 4 and len(compact) % 2 == 0 and len(compact) <= 24:
            chunks = [compact[i : i + 2] for i in range(0, len(compact), 2)]
            if all(1 <= int(chunk) <= 99 for chunk in chunks):
                return [(index, len(chunks), int(chunk)) for index, chunk in enumerate(chunks)]

    values: list[tuple[int, int, int]] = []
    numeric_count = 0
    for index, token in enumerate(raw_tokens):
        if NUMBER_TOKEN_RE.fullmatch(token):
            value = int(token)
            if 1 <= value <= 99:
                numeric_count += 1
                values.append((index, len(raw_tokens), value))
                continue

    if numeric_count / len(raw_tokens) < 0.8:
        # HTML table/grouped outputでは列名や装飾文字が混ざるため、従来の
        # 80%閾値だけで全番号を捨てない。ただし通常の自由文は誤検出を
        # 防ぐため従来どおり拒否する。
        has_markup_or_group_separator = bool(
            HTML_TAG_RE.search(original)
            or re.search(r"[,，、;；|/／]", original)
            or re.search(r"\b(?:table|row|cell|group)\b", normalized, re.IGNORECASE)
        )
        if has_markup_or_group_separator and numeric_count:
            return values
        # tileでは行見出し（例「あ 01 02」）が同じbboxへ入る。短いbboxで
        # 数字が過半数を占める場合だけ見出しを無視し、長い自由文・日付・
        # IDを番号列へ展開しない。
        if (
            numeric_count >= 2
            and len(raw_tokens) <= 8
            and values
            and 1 <= values[0][0] <= 2
            and numeric_count == len(raw_tokens) - values[0][0]
        ):
            return values
        return []
    return values


class _TableParser(HTMLParser):
    """table/tr/td の構造だけを収集する軽量DOMパーサー。

    OCRモデルのHTMLは完全な文書でないことがあるため、壊れたタグでも
    例外を投げず、閉じたセルだけを採用する。座標の横等分は table の
    行・列構造が実際に得られた場合に限定する。
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict[str, Any]]] = []
        self._row: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None
        self.table_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "table":
            self.table_depth += 1
            return
        if not self.table_depth:
            return
        if tag in {"p", "div", "li", "ul", "ol"} and self._cell is not None:
            self._cell["parts"].append("\n")
            return
        if tag == "br" and self._cell is not None:
            self._cell["parts"].append("\n")
            return
        if tag == "tr":
            if self._row is not None:
                self.rows.append(self._row)
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            attr = {str(k).lower(): v for k, v in attrs}
            try:
                colspan = max(1, int(attr.get("colspan") or 1))
            except (TypeError, ValueError):
                colspan = 1
            try:
                rowspan = max(1, int(attr.get("rowspan") or 1))
            except (TypeError, ValueError):
                rowspan = 1
            self._cell = {"parts": [], "colspan": colspan, "rowspan": rowspan}

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"p", "div", "li"} and self._cell is not None:
            self._cell["parts"].append("\n")
        elif tag in {"td", "th"} and self._cell is not None and self._row is not None:
            self._cell["text"] = "".join(self._cell["parts"]).strip()
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
        elif tag == "table" and self.table_depth:
            if self._row is not None:
                self.rows.append(self._row)
                self._row = None
            self.table_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["parts"].append(data)


def _table_to_numbers(
    text: str, x1: int, y1: int, x2: int, y2: int
) -> list[tuple[int, int, int, int, int]] | None:
    """構造化されたtableを2Dセル矩形へ変換する。

    戻り値 ``None`` はtable構造不明を表し、呼び出し側は座標を捏造せず
    当該要素を拒否する。空セルは行・列位置を維持する。
    """
    parser = _TableParser()
    try:
        parser.feed(str(text or ""))
        parser.close()
    except Exception:
        return None
    # 空trも行位置として保持する（番号が無い行を詰めると後続のy座標が
    # 実テーブルとずれる）。
    rows = parser.rows
    if not rows:
        return None
    row_count = len(rows)
    occupancy: dict[tuple[int, int], dict[str, Any]] = {}
    placements: list[tuple[dict[str, Any], int, int, int, int]] = []
    for row_index, row in enumerate(rows):
        col = 0
        for cell in row:
            while (row_index, col) in occupancy:
                col += 1
            colspan = int(cell.get("colspan", 1))
            rowspan = int(cell.get("rowspan", 1))
            # rowspans beyond the observed table are invalid structure rather
            # than a reason to invent y coordinates.
            if row_index + rowspan > row_count:
                return None
            for rr in range(row_index, row_index + rowspan):
                for cc in range(col, col + colspan):
                    if (rr, cc) in occupancy:
                        return None
                    occupancy[(rr, cc)] = cell
            placements.append((cell, row_index, col, rowspan, colspan))
            col += colspan
    col_count = max((col + colspan for _, _, col, _, colspan in placements), default=0)
    if col_count <= 0:
        return None
    output: list[tuple[int, int, int, int, int]] = []
    for cell, row_index, col, rowspan, colspan in placements:
        cell_text = str(cell.get("text", ""))
        # 明示的な<br>/改行は同じセル内の縦方向番号として扱う。
        lines = [line.strip() for line in re.split(r"\r?\n", cell_text) if line.strip()]
        vertical_values: list[int] = []
        if len(lines) > 1:
            for line in lines:
                value = _number_from_text(line)
                if value is not None:
                    vertical_values.append(value)
            if not vertical_values:
                continue
        numbers = _split_numeric_tokens(cell_text)
        single = _number_from_text(cell_text) if len(lines) <= 1 else None
        if single is not None:
            values = [single]
        elif vertical_values:
            values = vertical_values
        elif numbers:
            values = [value for _, _, value in numbers]
        else:
            continue
        cell_x1 = x1 + int(round((x2 - x1) * col / col_count))
        cell_x2 = x1 + int(round((x2 - x1) * (col + colspan) / col_count))
        cell_y1 = y1 + int(round((y2 - y1) * row_index / row_count))
        cell_y2 = y1 + int(round((y2 - y1) * (row_index + rowspan) / row_count))
        if cell_x2 <= cell_x1 or cell_y2 <= cell_y1:
            continue
        # A multi-number cell with an explicit colspan is still safely split
        # only inside its own structural cell; rows remain two-dimensional.
        for index, value in enumerate(values):
            if vertical_values:
                token_y1 = cell_y1 + int(round((cell_y2 - cell_y1) * index / len(values)))
                token_y2 = cell_y1 + int(round((cell_y2 - cell_y1) * (index + 1) / len(values)))
                output.append((value, cell_x1, token_y1, cell_x2, max(token_y2, token_y1 + 1)))
            else:
                token_x1 = cell_x1 + int(round((cell_x2 - cell_x1) * index / len(values)))
                token_x2 = cell_x1 + int(round((cell_x2 - cell_x1) * (index + 1) / len(values)))
                output.append((value, token_x1, cell_y1, max(token_x2, token_x1 + 1), cell_y2))
    return output


def _plain_group_is_vertical(text: str, width: int, height: int, numeric_count: int) -> bool:
    """改行/divで明示された縦番号列だけを縦分割する。

    空白区切りはbboxが縦長でも横列として扱う。OCRの説明文に含まれる
    偶発改行を避けるため、各行が単一番号で、bboxも縦長の場合に限定する。
    """
    if height <= width or numeric_count < 2:
        return False
    value = html.unescape(str(text or ""))
    value = re.sub(r"<\s*br\s*/?\s*>", "\n", value, flags=re.IGNORECASE)
    value = re.sub(
        r"<\s*/\s*(?:div|p|li)\s*>\s*<\s*(?:div|p|li)\b[^>]*>",
        "\n",
        value,
        flags=re.IGNORECASE,
    )
    value = HTML_TAG_RE.sub("", value)
    lines = [unicodedata.normalize("NFKC", line).strip() for line in value.splitlines()]
    lines = [line for line in lines if line]
    if len(lines) != numeric_count:
        return False
    return all(_number_from_text(line) is not None for line in lines)


def _elements_to_numbers(elements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []

    def add_candidate(entry: Dict[str, Any]) -> None:
        center_x = entry["x"] + entry["width"] / 2
        center_y = entry["y"] + entry["height"] / 2
        for existing in candidates:
            existing_center_x = existing["x"] + existing["width"] / 2
            existing_center_y = existing["y"] + existing["height"] / 2
            left = max(existing["x"], entry["x"])
            top = max(existing["y"], entry["y"])
            right = min(
                existing["x"] + existing["width"], entry["x"] + entry["width"]
            )
            bottom = min(
                existing["y"] + existing["height"], entry["y"] + entry["height"]
            )
            intersection = max(0, right - left) * max(0, bottom - top)
            union = (
                existing["width"] * existing["height"]
                + entry["width"] * entry["height"]
                - intersection
            )
            iou = intersection / union if union > 0 else 0.0
            center_distance = math.hypot(
                existing_center_x - center_x, existing_center_y - center_y
            )
            size_distance = min(
                36.0,
                max(
                    18.0,
                    0.6
                    * max(
                        existing["width"], existing["height"], entry["width"], entry["height"]
                    ),
                ),
            )
            if existing["number"] == entry["number"] and (
                iou >= 0.25 or center_distance <= size_distance
            ):
                # overlap tile由来のboxは数px〜数十pxずれる。同一候補の
                # 片方を恣意的に選ぶと中心座標が偏るため、包含boxへ統合する。
                merged_x1 = min(existing["x"], entry["x"])
                merged_y1 = min(existing["y"], entry["y"])
                merged_x2 = max(
                    existing["x"] + existing["width"], entry["x"] + entry["width"]
                )
                merged_y2 = max(
                    existing["y"] + existing["height"], entry["y"] + entry["height"]
                )
                existing.update(
                    {
                        "x": merged_x1,
                        "y": merged_y1,
                        "width": merged_x2 - merged_x1,
                        "height": merged_y2 - merged_y1,
                    }
                )
                return
        candidates.append(entry)

    def make_entry(value: int, x1: int, y1: int, x2: int, y2: int) -> Dict[str, Any]:
        return {
            "number": str(value).zfill(2),
            "x": x1,
            "y": y1,
            "width": max(x2 - x1, 1),
            "height": max(y2 - y1, 1),
            "confidence": 99,
            "variant": UNLIMITED_OCR_VARIANT,
        }

    for element in elements:
        text = str(element.get("text", "")).strip()
        try:
            x1 = int(element["x1"])
            y1 = int(element["y1"])
            x2 = int(element["x2"])
            y2 = int(element["y2"])
        except (KeyError, TypeError, ValueError):
            continue
        if x1 >= x2 or y1 >= y2:
            continue

        # table/grouped outputはDOMの行列を解釈できた場合だけ2Dセル矩形を
        # 生成する。構造が壊れている場合、巨大bboxを横一列へ割るより
        # 座標なしとして拒否する方が安全で、後続のfallbackも発火できる。
        if re.search(r"<\s*table\b", text, re.IGNORECASE):
            table_values = _table_to_numbers(text, x1, y1, x2, y2)
            if table_values is None:
                continue
            for value, token_x1, token_y1, token_x2, token_y2 in table_values:
                add_candidate(make_entry(value, token_x1, token_y1, token_x2, token_y2))
            continue

        single_value = _number_from_text(text)
        if single_value is not None:
            add_candidate(make_entry(single_value, x1, y1, x2, y2))
            continue

        token_values = _split_numeric_tokens(text)
        if not token_values:
            continue
        vertical_values = _plain_group_is_vertical(
            text, x2 - x1, y2 - y1, len(token_values)
        )
        for token_position, (index, token_count, value) in enumerate(token_values):
            if vertical_values:
                token_height = (y2 - y1) / len(token_values)
                token_y1 = int(y1 + token_height * token_position)
                token_y2 = int(y1 + token_height * (token_position + 1))
                add_candidate(make_entry(value, x1, token_y1, x2, token_y2))
            else:
                token_width = (x2 - x1) / token_count
                token_x1 = int(x1 + token_width * index)
                token_x2 = int(x1 + token_width * (index + 1))
                add_candidate(make_entry(value, token_x1, y1, token_x2, y2))

    candidates.sort(key=lambda n: (n["y"], n["x"]))
    return candidates


class OCREngine:
    """OCRを使った番号検出エンジン"""

    def __init__(self, config: UnlimitedOCRConfig | Dict[str, Any] | None = None):
        """初期化"""
        self.logger = logging.getLogger(__name__)
        self._config_from_mapping = isinstance(config, dict)
        self._config_explicit = config is not None
        if isinstance(config, UnlimitedOCRConfig):
            self.config = config
        elif isinstance(config, dict):
            # GUI payloadは空欄も「親環境の値を解除する」という明示値。
            self.config = UnlimitedOCRConfig.from_mapping(config, empty_overrides=True)
        else:
            self.config = UnlimitedOCRConfig.from_env()
        # GUI/CLIへ返せる診断情報。番号配列の既存契約は変更しない。
        self.last_error: Dict[str, Any] | None = None
        self.last_run: Dict[str, Any] = {}

    @property
    def diagnostics(self) -> Dict[str, Any]:
        """直近実行の機械可読な診断情報を返す（機密値は含めない）。"""
        return {
            "error": self.last_error,
            "last_run": dict(self.last_run),
            "config": self.config.to_public_dict(),
        }

    def _set_error(self, code: str, message: str, **details: Any) -> None:
        self.last_error = {"code": code, "message": message, **details}
        self.logger.error("%s: %s", code, message)

    def extract_numbers_with_coordinates(
        self,
        image_path: str,
        min_confidence: int = 55,
        expected_candidate_count: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        マップ画像から番号と座標を抽出

        Args:
            image_path: マップ画像のローカルパス
            min_confidence: 互換性維持用。Unlimited OCR では使用しません。

        Returns:
            番号と座標のリスト:
            [
                {"number": "12", "x": 468, "y": 304, "width": 20, "height": 18,
                 "confidence": 99, "variant": "unlimited_ocr_0"},
                ...
            ]
        """
        self.logger.info(f"Unlimited OCR処理開始: {image_path}")
        self.last_error = None
        self.last_run = {
            "image": str(image_path),
            "strategy": self.config.strategy,
            "expected_candidate_count": expected_candidate_count,
        }

        if cv2.imread(image_path) is None:
            message = f"画像の読み込みに失敗: {image_path}"
            self._set_error("image_read_failed", message)
            raise ValueError(message)

        # 既存テストが引数なしで monkeypatch できるよう、既定経路は従来の
        # helper をそのまま呼ぶ。GUIで専用venvを指定した場合だけ overrideする。
        try:
            # 辞書設定はGUI由来なので、venv_path空欄を親の
            # UNLIMITED_OCR_VENVで補完しない（stale環境を解除する）。
            # 環境変数を使う旧CLI経路は config=None のときだけ維持する。
            if self._config_explicit:
                ocr_python = _resolve_ocr_python(
                    self.config.venv_path or REPO_ROOT / "temp" / "unlimited_ocr_venv"
                )
            else:
                ocr_python = _resolve_ocr_python(self.config.venv_path) if self.config.venv_path else _resolve_ocr_python()
        except RuntimeError as exc:
            self._set_error("venv_missing", str(exc))
            raise
        timeout_sec = self.config.timeout_sec
        device = self.config.device
        mode = self.config.mode

        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".json",
                prefix="unlimited_ocr_",
                delete=False,
                encoding="utf-8",
            ) as temp_file:
                temp_path = temp_file.name

            command = [
                str(ocr_python),
                str(RUNNER_PATH),
                "--image",
                str(Path(image_path).resolve()),
                "--output-json",
                temp_path,
                "--device",
                device,
                "--mode",
                mode,
                "--strategy",
                self.config.strategy,
                "--max-length",
                str(self.config.max_length),
                "--no-repeat-ngram-size",
                str(self.config.no_repeat_ngram_size),
                "--ngram-window",
                str(self.config.ngram_window),
                "--temperature",
                str(self.config.temperature),
                "--tile-size",
                str(self.config.tile_size),
                "--tile-overlap",
                str(self.config.tile_overlap),
                "--tile-max-count",
                str(self.config.tile_max_count),
            ]
            if not self.config.tile_fallback:
                command.append("--no-tile-fallback")
            if expected_candidate_count is not None:
                command.extend(["--expected-candidate-count", str(max(0, int(expected_candidate_count)))])
            if self.config.model:
                command.extend(["--model", self.config.model])
            if self.config.model_path:
                command.extend(["--model-path", self.config.model_path])
            if self.config.hf_home:
                command.extend(["--hf-home", self.config.hf_home])
            if self.config.revision:
                command.extend(["--revision", self.config.revision])
            if self.config.prompt:
                command.extend(["--prompt", self.config.prompt])
            child_env = os.environ.copy()
            # GUIで明示された設定を専用runnerへ伝える際、親プロセスに残る
            # HF/UNLIMITED_OCR_* の stale 値が競合しないよう一度全て除去する。
            for key in (
                "HF_HOME",
                "HF_HUB_CACHE",
                "UNLIMITED_OCR_MODEL",
                "UNLIMITED_OCR_MODEL_NAME",
                "UNLIMITED_OCR_MODEL_PATH",
                "UNLIMITED_OCR_VENV",
                "UNLIMITED_OCR_HF_HOME",
                "UNLIMITED_OCR_HF_CACHE",
                "UNLIMITED_OCR_REVISION",
                "UNLIMITED_OCR_DEVICE",
                "UNLIMITED_OCR_MODE",
                "UNLIMITED_OCR_STRATEGY",
                "UNLIMITED_OCR_PROMPT",
                "TRANSFORMERS_CACHE",
                "HUGGINGFACE_HUB_CACHE",
                "HF_DATASETS_CACHE",
                "HF_MODULES_CACHE",
            ):
                child_env.pop(key, None)
            if self.config.hf_home:
                child_env["HF_HOME"] = self.config.hf_home
            child_env["UNLIMITED_OCR_MODEL"] = self.config.model
            if self.config.model_path:
                child_env["UNLIMITED_OCR_MODEL_PATH"] = self.config.model_path
            child_env["UNLIMITED_OCR_REVISION"] = self.config.revision
            result = subprocess.run(
                command,
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
                env=child_env,
            )
            if result.returncode != 0:
                self._set_error(
                    "runner_failed",
                    "Unlimited OCR runner が失敗しました",
                    returncode=result.returncode,
                    stderr=(result.stderr or "")[-4000:],
                    stdout=(result.stdout or "")[-1000:],
                )
                return []

            with open(temp_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except subprocess.TimeoutExpired:
            self._set_error(
                "timeout",
                f"Unlimited OCR runner がタイムアウトしました: {timeout_sec}秒",
                timeout_sec=timeout_sec,
            )
            return []
        except Exception as exc:
            self._set_error("runner_exception", f"Unlimited OCR runner 実行中に失敗しました: {exc}")
            return []
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

        if not isinstance(payload, dict):
            self._set_error("invalid_result", "Unlimited OCR runnerのJSONトップレベルがobjectではありません")
            return []
        results = payload.get("results") or []
        if not isinstance(results, list):
            self._set_error("invalid_result", "Unlimited OCR runnerのresultsが配列ではありません")
            return []
        if not results:
            self._set_error("empty_result", "Unlimited OCR runner の結果が空です")
            return []

        first_result = results[0]
        if not isinstance(first_result, dict):
            self._set_error("invalid_result", "Unlimited OCR runnerのresults要素がobjectではありません")
            return []
        if first_result.get("error"):
            self._set_error(
                "image_inference_failed",
                f"Unlimited OCR 画像処理失敗: {first_result['error']}",
            )
            return []

        elements = first_result.get("elements") or []
        numbers = _elements_to_numbers(elements)
        self.last_run.update(
            {
                "model": payload.get("model"),
                "revision": payload.get("revision"),
                "device": payload.get("device"),
                "strategy": first_result.get("strategy", self.config.strategy),
                "attempts": first_result.get("attempts", []),
                "element_count": len(elements),
                "number_count": len(numbers),
                "tile_decision": first_result.get("tile_decision"),
                "tile_fallback": first_result.get("tile_fallback"),
                "context_fallback": first_result.get("context_fallback"),
            }
        )
        if not numbers:
            self._set_error(
                "no_numbers",
                "Unlimited OCR は実行できましたが、1〜99の番号を検出できませんでした",
                element_count=len(elements),
                attempts=first_result.get("attempts", []),
            )
        self.logger.info(f"検出番号数: {len(numbers)}個")
        return numbers

    def save_debug_image(
        self,
        image_path: str,
        numbers: List[Dict[str, Any]],
        output_path: str
    ) -> None:
        """検出した番号を枠とラベル付きで描画して出力する"""
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"画像の読み込みに失敗: {image_path}")

        for entry in numbers:
            x = int(entry.get('x', 0))
            y = int(entry.get('y', 0))
            w = int(entry.get('width', 0))
            h = int(entry.get('height', 0))
            number = entry.get('number', '')
            confidence = entry.get('confidence')
            variant = entry.get('variant')

            top_left = (max(x, 0), max(y, 0))
            bottom_right = (max(x + w, 0), max(y + h, 0))
            cv2.rectangle(img, top_left, bottom_right, (0, 255, 0), 2)

            label = number
            if confidence is not None:
                label += f" ({confidence})"
            if variant:
                label += f" [{variant}]"

            cv2.putText(
                img,
                label,
                (top_left[0], max(top_left[1] - 6, 0)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2,
                cv2.LINE_AA
            )

        cv2.imwrite(output_path, img)
        self.logger.info(f"デバッグ画像を保存しました: {output_path}")

    def analyze_grid_pattern(
        self,
        numbers: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        検出された番号からグリッドパターンを分析

        Args:
            numbers: 番号と座標のリスト

        Returns:
            パターン情報:
            {
                "rows": 12,
                "cols": 5,
                "y_interval": 49.75,
                "x_interval": 131.44,
                "y_positions": [...],
                "x_positions": [...]
            }
        """
        if not numbers:
            return {}

        def cluster_axis(values: List[float], threshold: float) -> List[Dict[str, Any]]:
            """座標をクラスタリングして中心値とカウントを返す"""
            if not values:
                return []

            sorted_values = sorted(values)
            clusters: List[List[float]] = [[sorted_values[0]]]

            for value in sorted_values[1:]:
                if value - clusters[-1][-1] <= threshold:
                    clusters[-1].append(value)
                else:
                    clusters.append([value])

            return [
                {
                    'center': sum(cluster) / len(cluster),
                    'count': len(cluster)
                }
                for cluster in clusters
            ]

        def average_interval(positions: List[float]) -> float:
            if len(positions) < 2:
                return 0.0
            diffs = [positions[i + 1] - positions[i] for i in range(len(positions) - 1)]
            return sum(diffs) / len(diffs) if diffs else 0.0

        # 中心座標を算出（バウンディングボックス差異を吸収）
        centers_x: List[float] = []
        centers_y: List[float] = []
        widths: List[float] = []
        heights: List[float] = []

        for num in numbers:
            width = num.get('width', 0)
            height = num.get('height', 0)
            widths.append(width)
            heights.append(height)
            centers_x.append(num['x'] + width / 2)
            centers_y.append(num['y'] + height / 2)

        median_height = median(heights) if heights else 0.0
        median_width = median(widths) if widths else 0.0

        # 行・列のクラスタリングしきい値を動的に設定
        y_threshold = max(20.0, median_height * 1.4)  # 縦方向は3段を分離できる程度に
        x_threshold = max(12.0, median_width * 1.4)   # 横方向は列を細かく分ける

        y_clusters = cluster_axis(centers_y, y_threshold)
        x_clusters = cluster_axis(centers_x, x_threshold)

        def filter_clusters(
            clusters: List[Dict[str, Any]],
            min_count: int,
            max_clusters: int | None = None
        ) -> List[float]:
            filtered = [c for c in clusters if c['count'] >= min_count]
            if not filtered and clusters:
                filtered = clusters
            centers = [c['center'] for c in filtered]
            if max_clusters and len(centers) > max_clusters:
                # 間隔が狭い順に統合
                centers.sort()
                while len(centers) > max_clusters:
                    diffs = [centers[i+1] - centers[i] for i in range(len(centers)-1)]
                    idx = diffs.index(min(diffs))
                    merged = (centers[idx] + centers[idx+1]) / 2
                    centers[idx:idx+2] = [merged]
            return centers

        expected_rows = min(6, max(3, len(numbers) // 15))
        expected_cols = min(20, max(4, len(numbers) // max(expected_rows, 1)))

        y_positions = filter_clusters(y_clusters, max(3, len(numbers) // 30), expected_rows)
        x_positions = filter_clusters(x_clusters, 1, expected_cols)

        y_interval = average_interval(y_positions)
        x_interval = average_interval(x_positions)

        return {
            'rows': len(y_positions),
            'cols': len(x_positions),
            'y_interval': y_interval,
            'x_interval': x_interval,
            'y_positions': y_positions,
            'x_positions': x_positions
        }


def main():
    """テスト実行"""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python ocr_engine.py <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]

    # OCR実行
    engine = OCREngine()
    numbers = engine.extract_numbers_with_coordinates(image_path)

    print(f"\n検出番号数: {len(numbers)}個")
    print("\n最初の10個:")
    for num in numbers[:10]:
        print(f"  {num['number']} at ({num['x']}, {num['y']}) - conf: {num['confidence']}")

    # パターン分析
    pattern = engine.analyze_grid_pattern(numbers)
    print(f"\nパターン分析:")
    print(f"  行数: {pattern.get('rows', 0)}")
    print(f"  列数: {pattern.get('cols', 0)}")
    print(f"  行間隔: {pattern.get('y_interval', 0):.1f}px")
    print(f"  列間隔: {pattern.get('x_interval', 0):.1f}px")

    # 結果を保存
    output = {
        'numbers': numbers,
        'pattern': pattern
    }

    from pathlib import Path

    image_path_obj = Path(image_path)
    output_path = image_path_obj.with_suffix(image_path_obj.suffix + '.ocr.json')

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n結果を保存しました: {output_path}")


if __name__ == "__main__":
    main()
