#!/usr/bin/env python3
"""
座標マッピング処理

OCR結果、パターン分析、LLM判定を統合して完全な座標マップを生成
"""

import json
from typing import Dict, List, Any, Optional, Tuple
from statistics import median
import logging


class CoordinateMapper:
    """座標マッピング処理"""

    def __init__(self, image_width: int = None, image_height: int = None):
        """
        初期化

        Args:
            image_width: マップ画像の幅（正規化座標計算用）
            image_height: マップ画像の高さ（正規化座標計算用）
        """
        self.logger = logging.getLogger(__name__)
        self.image_width = image_width
        self.image_height = image_height

    def normalize_coordinate(self, x: int, y: int) -> tuple:
        """
        ピクセル座標を正規化座標（0-1）に変換

        Args:
            x: X座標（ピクセル）
            y: Y座標（ピクセル）

        Returns:
            (normalized_x, normalized_y) の tuple
        """
        if self.image_width is None or self.image_height is None:
            # 画像サイズが未設定の場合はピクセル座標をそのまま返す
            return (x, y)

        # 0-1の範囲に正規化（小数点第9位まで）
        norm_x = round(x / self.image_width, 9)
        norm_y = round(y / self.image_height, 9)

        return (norm_x, norm_y)

    def generate_complete_grid(
        self,
        pattern_info: Dict[str, Any],
        llm_pattern: Dict[str, Any],
        normalize: bool = True
    ) -> List[Dict[str, Any]]:
        """
        パターン情報とLLM判定から完全なグリッドを生成

        Args:
            pattern_info: OCRパターン分析結果
                {
                    "y_interval": 49.75,
                    "x_interval": 131.44,
                    "y_positions": [...],
                    "x_positions": [...]
                }
            llm_pattern: LLM判定結果
                {
                    "layout_type": "縦配置型" or "横配置型",
                    "columns": {...},
                    "rows": {...},
                    "floor": "1F"
                }

        Returns:
            完全な座標マップ:
            [
                {
                    "space_id": "E12",
                    "number": "12",
                    "x": 468,
                    "y": 304,
                    "row": 0,
                    "col": 0
                },
                ...
            ]
        """
        layout_type = llm_pattern['layout_type']

        if layout_type == '縦配置型':
            grid = self._generate_vertical_layout(pattern_info, llm_pattern)
        else:
            grid = self._generate_horizontal_layout(pattern_info, llm_pattern)

        # 正規化座標を追加
        if normalize and self.image_width and self.image_height:
            for item in grid:
                norm_x, norm_y = self.normalize_coordinate(item['x'], item['y'])
                item['normalized_x'] = norm_x
                item['normalized_y'] = norm_y

        return grid

    def _generate_vertical_layout(
        self,
        pattern_info: Dict[str, Any],
        llm_pattern: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """縦配置型のグリッドを生成"""
        columns = llm_pattern['columns']
        rows = llm_pattern['rows']

        col_labels = columns['labels']
        col_count = columns['count']
        row_count = rows['count']
        number_range = rows['range']  # [12, 1] or [1, 12]

        resolved_x_positions = self._resolve_axis_positions(
            pattern_info.get('x_positions'),
            col_count
        )
        resolved_y_positions = self._resolve_axis_positions(
            pattern_info.get('y_positions'),
            row_count
        )

        # 間隔を取得
        if len(resolved_y_positions) > 1:
            y_interval = self._average_interval(resolved_y_positions)
        else:
            y_interval = pattern_info.get('y_interval', 50)

        if len(resolved_x_positions) > 1:
            x_interval = self._average_interval(resolved_x_positions)
        else:
            x_interval = pattern_info.get('x_interval', 130)

        # 開始位置を取得
        if resolved_x_positions:
            x_start = resolved_x_positions[0]
        elif pattern_info.get('x_positions'):
            x_start = pattern_info['x_positions'][0]
        else:
            x_start = 468  # デフォルト

        if resolved_y_positions:
            y_start = resolved_y_positions[0]
        elif pattern_info.get('y_positions'):
            y_start = min(pattern_info['y_positions'])
        else:
            y_start = 304  # デフォルト

        # グリッドを生成
        complete_grid = []

        # 番号の方向を判定
        numbering_direction = rows.get('numbering', '上から下')
        if numbering_direction == '下から上':
            # 番号が下から上に増加（01が下、12が上）
            number_list = list(range(number_range[0], number_range[1] + 1))  # [1, 2, ..., 12]
            number_list.reverse()  # [12, 11, ..., 1]
        else:
            # 番号が上から下に増加（01が上、12が下）
            number_list = list(range(number_range[0], number_range[1] + 1))

        for row_idx in range(row_count):
            for col_idx in range(col_count):
                # 番号を取得
                if row_idx < len(number_list):
                    num = f"{number_list[row_idx]:02d}"
                else:
                    num = f"{row_idx + 1:02d}"

                # 座標を計算
                if len(resolved_x_positions) == col_count:
                    x = int(round(resolved_x_positions[col_idx]))
                else:
                    x = int(round(x_start + col_idx * x_interval))

                if len(resolved_y_positions) == row_count:
                    y = int(round(resolved_y_positions[row_idx]))
                else:
                    y = int(round(y_start + row_idx * y_interval))

                # ラベルを取得
                if col_idx < len(col_labels):
                    label = col_labels[col_idx]
                else:
                    label = f"Col{col_idx + 1}"

                space_id = f"{label}{num}"

                complete_grid.append({
                    'space_id': space_id,
                    'number': num,
                    'x': x,
                    'y': y,
                    'row': row_idx,
                    'col': col_idx
                })

        self.logger.info(f"縦配置型グリッド生成完了: {len(complete_grid)}個")
        return complete_grid

    def _generate_horizontal_layout(
        self,
        pattern_info: Dict[str, Any],
        llm_pattern: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """横配置型のグリッドを生成"""
        rows = llm_pattern['rows']
        columns = llm_pattern['columns']

        row_labels = rows['labels']
        row_count = rows['count']
        col_count = columns['count']
        number_range = columns['range']  # [18, 1] or [1, 18]

        resolved_y_positions = self._resolve_axis_positions(
            pattern_info.get('y_positions'),
            row_count
        )
        resolved_x_positions = self._resolve_axis_positions(
            pattern_info.get('x_positions'),
            col_count
        )

        # 間隔を取得
        if len(resolved_y_positions) > 1:
            y_interval = self._average_interval(resolved_y_positions)
        else:
            y_interval = pattern_info.get('y_interval', 90)

        if len(resolved_x_positions) > 1:
            x_interval = self._average_interval(resolved_x_positions)
        else:
            x_interval = pattern_info.get('x_interval', 54)

        # 開始位置を取得
        if resolved_x_positions:
            x_start = resolved_x_positions[0]
        elif pattern_info.get('x_positions'):
            x_start = pattern_info['x_positions'][0]
        else:
            x_start = 358  # デフォルト

        if resolved_y_positions:
            y_start = resolved_y_positions[0]
        elif pattern_info.get('y_positions'):
            y_start = min(pattern_info['y_positions'])
        else:
            y_start = 304  # デフォルト

        # グリッドを生成
        complete_grid = []

        # 番号の方向を判定
        numbering_direction = columns.get('numbering', '左から右')
        if numbering_direction == '右から左':
            # 番号が右から左に減少（18が左、01が右）
            number_list = list(range(number_range[0], number_range[1] - 1, -1))  # [18, 17, ..., 1]
        else:
            # 番号が左から右に増加（01が左、18が右）
            number_list = list(range(number_range[1], number_range[0] + 1))  # [1, 2, ..., 18]

        for row_idx in range(row_count):
            for col_idx in range(col_count):
                # 番号を取得
                if col_idx < len(number_list):
                    num = f"{number_list[col_idx]:02d}"
                else:
                    num = f"{col_idx + 1:02d}"

                # 座標を計算
                if len(resolved_x_positions) == col_count:
                    x = int(round(resolved_x_positions[col_idx]))
                else:
                    x = int(round(x_start + col_idx * x_interval))

                if len(resolved_y_positions) == row_count:
                    y = int(round(resolved_y_positions[row_idx]))
                else:
                    y = int(round(y_start + row_idx * y_interval))

                # ラベルを取得
                if row_idx < len(row_labels):
                    label = row_labels[row_idx]
                else:
                    label = f"Row{row_idx + 1}"

                space_id = f"{label}{num}"

                complete_grid.append({
                    'space_id': space_id,
                    'number': num,
                    'x': x,
                    'y': y,
                    'row': row_idx,
                    'col': col_idx
                })

        self.logger.info(f"横配置型グリッド生成完了: {len(complete_grid)}個")
        return complete_grid

    @staticmethod
    def _average_interval(positions: List[float]) -> float:
        if len(positions) < 2:
            return 0.0
        diffs = [positions[i + 1] - positions[i] for i in range(len(positions) - 1)]
        return sum(diffs) / len(diffs) if diffs else 0.0

    @staticmethod
    def _resolve_axis_positions(
        positions: Optional[List[float]],
        target_count: int
    ) -> List[float]:
        """OCR由来の座標リストを所望の段数・列数に圧縮"""

        if not positions or target_count <= 0:
            return []

        sorted_positions = sorted(positions)
        current_count = len(sorted_positions)

        if current_count == target_count:
            return sorted_positions

        if current_count > target_count and target_count > 1:
            clusters = [[value] for value in sorted_positions]

            while len(clusters) > target_count:
                min_gap = None
                merge_index = 0

                for idx in range(len(clusters) - 1):
                    gap = clusters[idx + 1][0] - clusters[idx][-1]
                    if min_gap is None or gap < min_gap:
                        min_gap = gap
                        merge_index = idx

                clusters[merge_index].extend(clusters[merge_index + 1])
                del clusters[merge_index + 1]

            centers = [sum(cluster) / len(cluster) for cluster in clusters]
            median_diff = 0.0

            if len(centers) >= 2:
                diffs = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
                median_diff = median(diffs) if diffs else 0.0

                outlier_removed = False
                if median_diff > 0:
                    for idx, diff in enumerate(diffs):
                        if diff > median_diff * 2.5:
                            clusters.pop(idx + 1)
                            outlier_removed = True
                            break

                if outlier_removed:
                    centers = [sum(cluster) / len(cluster) for cluster in clusters]
                    if len(centers) >= 2:
                        diffs = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
                        median_diff = median(diffs) if diffs else 0.0
                    else:
                        median_diff = 0.0

            if len(clusters) < target_count:
                step = median_diff if median_diff > 0 else (
                    centers[-1] - centers[-2]
                    if len(centers) > 1 else 0.0
                )
                extrapolated = clusters[-1][-1] + step if step else clusters[-1][-1]
                clusters.append([extrapolated])

            resolved = [sum(cluster) / len(cluster) for cluster in clusters]
            return sorted(resolved)

        # 検出数が不足する場合は補間
        if current_count >= 2:
            start_pos = sorted_positions[0]
            end_pos = sorted_positions[-1]
            step = (end_pos - start_pos) / (target_count - 1) if target_count > 1 else 0
            interpolated = [start_pos + step * i for i in range(target_count)]
            return interpolated

        # 単一点しか得られない場合は同値で埋める
        return [sorted_positions[0]] * target_count


    def generate_vertical_columns(
        self,
        normalized_points: List[Tuple[float, float]],
        vertical_labels: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """縦列用の座標を生成"""

        if not vertical_labels:
            return []
        points = sorted(normalized_points, key=lambda p: p[1]) if normalized_points else []
        total_required = len(vertical_labels)

        ys = [pt[1] for pt in points]
        resolved_y = self._resolve_axis_positions(ys, total_required)

        if not resolved_y:
            # 入力がない場合は均等配置で生成
            step = 1.0 / (total_required + 1) if total_required > 0 else 0.2
            resolved_y = [step * (idx + 1) for idx in range(total_required)]

        default_x = median([pt[0] for pt in points]) if points else 0.95

        resolved_points: List[Tuple[float, float]] = []
        if points:
            for target_y in resolved_y:
                nearest = min(points, key=lambda pt: abs(pt[1] - target_y))
                resolved_points.append((nearest[0], target_y))
        else:
            resolved_points = [(default_x, target_y) for target_y in resolved_y]

        # resolved_points が不足する場合は default_x で補填
        while len(resolved_points) < total_required:
            idx = min(len(resolved_y) - 1, len(resolved_points))
            resolved_points.append((default_x, resolved_y[idx]))

        result: List[Dict[str, Any]] = []
        for index, target in enumerate(vertical_labels):
            if index >= len(resolved_points):
                break
            nx, ny = resolved_points[index]
            prefix = target['prefix']
            number_str = target.get('number') or target.get('start', '01')
            number_str = number_str.zfill(2)
            entry = {
                'space_id': f"{prefix}{number_str}",
                'number': number_str,
                'x': int(round(nx * self.image_width)) if self.image_width else nx,
                'y': int(round(ny * self.image_height)) if self.image_height else ny,
                'normalized_x': nx,
                'normalized_y': ny,
                'row': prefix,
                'col': index
            }
            result.append(entry)

        return result

def main():
    """テスト実行"""
    import sys

    if len(sys.argv) < 3:
        print("Usage: python coordinate_mapper.py <pattern_json> <llm_pattern_json>")
        sys.exit(1)

    pattern_path = sys.argv[1]
    llm_pattern_path = sys.argv[2]

    # パターン情報を読み込み
    with open(pattern_path, 'r') as f:
        data = json.load(f)
        pattern_info = data.get('pattern', {})

    # LLM判定結果を読み込み
    with open(llm_pattern_path, 'r') as f:
        llm_pattern = json.load(f)

    # 座標マッピング
    mapper = CoordinateMapper()
    complete_grid = mapper.generate_complete_grid(pattern_info, llm_pattern)

    print(f"\n生成座標数: {len(complete_grid)}個")
    print(f"最初の5個: {[g['space_id'] for g in complete_grid[:5]]}")
    print(f"最後の5個: {[g['space_id'] for g in complete_grid[-5:]]}")

    # 結果を保存
    output_path = llm_pattern_path.replace('_pattern.json', '_complete.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(complete_grid, f, ensure_ascii=False, indent=2)

    print(f"\n結果を保存しました: {output_path}")


if __name__ == "__main__":
    main()
