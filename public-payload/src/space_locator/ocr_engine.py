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
from typing import Dict, List, Any
from statistics import median
import logging


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_runner.py"
UNLIMITED_OCR_VARIANT = "unlimited_ocr_0"
NUMBER_TOKEN_RE = re.compile(r"\d{1,2}")


def _resolve_ocr_python() -> Path:
    venv_dir = Path(
        os.environ.get("UNLIMITED_OCR_VENV", REPO_ROOT / "temp" / "unlimited_ocr_venv")
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
    stripped = text.strip()
    if NUMBER_TOKEN_RE.fullmatch(stripped):
        value = int(stripped)
        if 1 <= value <= 99:
            return value
    return None


def _split_numeric_tokens(text: str) -> list[tuple[int, int, int]]:
    raw_tokens = [token for token in re.split(r"\s+", text.strip()) if token]
    if not raw_tokens:
        return []

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
        return []
    return values


def _elements_to_numbers(elements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []

    def add_candidate(entry: Dict[str, Any]) -> None:
        center_x = entry["x"] + entry["width"] / 2
        center_y = entry["y"] + entry["height"] / 2
        for existing in candidates:
            existing_center_x = existing["x"] + existing["width"] / 2
            existing_center_y = existing["y"] + existing["height"] / 2
            if (
                existing["number"] == entry["number"]
                and abs(existing_center_x - center_x) < 15
                and abs(existing_center_y - center_y) < 15
            ):
                if entry["width"] * entry["height"] < existing["width"] * existing["height"]:
                    existing.update(entry)
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

        single_value = _number_from_text(text)
        if single_value is not None:
            add_candidate(make_entry(single_value, x1, y1, x2, y2))
            continue

        token_values = _split_numeric_tokens(text)
        if not token_values:
            continue
        for index, token_count, value in token_values:
            token_width = (x2 - x1) / token_count
            token_x1 = int(x1 + token_width * index)
            token_x2 = int(x1 + token_width * (index + 1))
            add_candidate(make_entry(value, token_x1, y1, token_x2, y2))

    candidates.sort(key=lambda n: (n["y"], n["x"]))
    return candidates


class OCREngine:
    """OCRを使った番号検出エンジン"""

    def __init__(self):
        """初期化"""
        self.logger = logging.getLogger(__name__)

    def extract_numbers_with_coordinates(
        self,
        image_path: str,
        min_confidence: int = 55
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

        if cv2.imread(image_path) is None:
            raise ValueError(f"画像の読み込みに失敗: {image_path}")

        ocr_python = _resolve_ocr_python()
        timeout_sec = int(os.environ.get("UNLIMITED_OCR_TIMEOUT_SEC", "900"))
        device = os.environ.get("UNLIMITED_OCR_DEVICE", "auto")
        mode = os.environ.get("UNLIMITED_OCR_MODE", "base")

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
            ]
            result = subprocess.run(
                command,
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
            )
            if result.returncode != 0:
                self.logger.error(
                    "Unlimited OCR runner が失敗しました: returncode=%s stderr=%s",
                    result.returncode,
                    result.stderr[-2000:],
                )
                return []

            with open(temp_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except subprocess.TimeoutExpired:
            self.logger.error("Unlimited OCR runner がタイムアウトしました: %s秒", timeout_sec)
            return []
        except Exception as exc:
            self.logger.error("Unlimited OCR runner 実行中に失敗しました: %s", exc)
            return []
        finally:
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

        results = payload.get("results") or []
        if not results:
            self.logger.error("Unlimited OCR runner の結果が空です")
            return []

        first_result = results[0]
        if first_result.get("error"):
            self.logger.error("Unlimited OCR 画像処理失敗: %s", first_result["error"])
            return []

        elements = first_result.get("elements") or []
        numbers = _elements_to_numbers(elements)
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
