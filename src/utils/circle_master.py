"""
サークルマスターデータを管理するモジュール。
お気に入り・ジャンル・デフォルトカットをイベント横断で一元管理する。
"""

import json
import shutil
from pathlib import Path
from typing import Dict, Optional, List, Any
import logging

from ..utils.logger import setup_logger


logger = setup_logger(__name__)

# circle_master.json のエントリ型
# {
#   "circles": {
#     "サークル名": {
#       "penname": "ペンネーム",
#       "favorite": false,
#       "genre": "",
#       "default_cut": "0012.jpg"  # or null
#     }
#   }
# }


class CircleMasterManager:
    """サークルマスターデータの管理クラス"""

    def __init__(self, config_path: str = "circle_master.json", cuts_dir: str = "default_cuts"):
        project_root = Path(__file__).resolve().parent.parent.parent
        config_p = Path(config_path)
        cuts_p = Path(cuts_dir)
        self.config_path = config_p if config_p.is_absolute() else project_root / config_p
        self.cuts_dir = cuts_p if cuts_p.is_absolute() else project_root / cuts_p
        self.data: Dict[str, Any] = {"circles": {}}
        self.load()

    def load(self) -> None:
        """circle_master.json を読み込む"""
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    self.data = json.load(f)
                if "circles" not in self.data:
                    self.data["circles"] = {}
                logger.info(f"サークルマスター読み込み: {len(self.data['circles'])}件")
            except Exception as e:
                logger.error(f"circle_master.json 読み込みエラー: {e}")
                self.data = {"circles": {}}
        else:
            logger.info("circle_master.json が見つかりません。新規作成します。")
            self.data = {"circles": {}}

    def save(self) -> None:
        """circle_master.json に保存する"""
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            logger.debug(f"サークルマスター保存: {len(self.data['circles'])}件")
        except Exception as e:
            logger.error(f"circle_master.json 書き込みエラー: {e}")

    def _ensure_entry(self, name: str) -> Dict[str, Any]:
        """指定サークルのエントリを取得（なければ作成）"""
        if name not in self.data["circles"]:
            self.data["circles"][name] = {
                "penname": "",
                "favorite": False,
                "genre": "",
                "default_cut": None,
            }
        return self.data["circles"][name]

    def get(self, circle_name: str) -> Optional[Dict[str, Any]]:
        """サークルのエントリを取得"""
        return self.data["circles"].get(circle_name)

    # --- お気に入り ---

    def is_favorite(self, name: str, penname: str = "") -> bool:
        """サークル名 or ペンネームでお気に入り判定"""
        for cname, entry in self.data["circles"].items():
            if entry.get("favorite", False):
                if cname and name and cname == name:
                    return True
                ep = entry.get("penname", "")
                if ep and penname and ep == penname:
                    return True
        return False

    def set_favorite(self, name: str, penname: str, flag: bool) -> None:
        """お気に入り設定"""
        entry = self._ensure_entry(name)
        entry["favorite"] = flag
        if penname and not entry.get("penname"):
            entry["penname"] = penname

    def toggle_favorite(self, name: str, penname: str) -> bool:
        """お気に入りトグル。新しい状態を返す"""
        is_fav = self.is_favorite(name, penname)
        self.set_favorite(name, penname, not is_fav)
        return not is_fav

    def get_all_favorites(self) -> List[Dict[str, str]]:
        """全お気に入りサークルを返す"""
        result = []
        for name, entry in self.data["circles"].items():
            if entry.get("favorite", False):
                result.append({"name": name, "penname": entry.get("penname", "")})
        return result

    # --- ジャンル ---

    def get_genre(self, circle_name: str) -> Optional[str]:
        """サークルのジャンルを取得"""
        entry = self.data["circles"].get(circle_name)
        if entry:
            g = entry.get("genre", "")
            return g if g else None
        return None

    def set_genre(self, circle_name: str, genre: str) -> None:
        """サークルのジャンルを設定"""
        entry = self._ensure_entry(circle_name)
        entry["genre"] = genre

    # --- デフォルトカット ---

    def get_default_cut(self, circle_name: str) -> Optional[Path]:
        """サークル名からデフォルトカット画像のパスを取得"""
        entry = self.data["circles"].get(circle_name)
        if not entry:
            return None
        cut_file = entry.get("default_cut")
        if not cut_file:
            return None
        image_path = self.cuts_dir / cut_file
        if image_path.exists():
            return image_path
        logger.warning(f"デフォルトカット画像が見つかりません: {image_path}")
        return None

    def has_default_cut(self, circle_name: str) -> bool:
        """デフォルトカットが存在するか確認"""
        return self.get_default_cut(circle_name) is not None

    def copy_default_cut(self, circle_name: str, output_path: Path, prefix: str = "default_") -> Optional[Path]:
        """デフォルトカット画像を指定パスにコピー"""
        source_path = self.get_default_cut(circle_name)
        if not source_path:
            return None
        try:
            output_file = output_path / f"{prefix}{source_path.name}"
            shutil.copy2(source_path, output_file)
            logger.info(f"デフォルトカットをコピー: {circle_name} -> {output_file}")
            return output_file
        except Exception as e:
            logger.error(f"デフォルトカットのコピーエラー: {e}")
            return None

    def _next_filename(self) -> str:
        """次の連番ファイル名を生成"""
        max_num = -1
        for entry in self.data["circles"].values():
            cut_file = entry.get("default_cut")
            if cut_file:
                stem = Path(cut_file).stem
                try:
                    num = int(stem)
                    max_num = max(max_num, num)
                except ValueError:
                    pass
        return f"{max_num + 1:04d}.jpg"

    def register_default_cut(self, circle_name: str, penname: str, image_path: Path) -> bool:
        """おしながき画像をデフォルトカットとして登録する"""
        existing = self.data["circles"].get(circle_name)
        if existing and existing.get("default_cut"):
            logger.debug(f"デフォルトカット登録済み、スキップ: {circle_name}")
            return False

        if not image_path.exists():
            logger.warning(f"登録元画像が見つかりません: {image_path}")
            return False

        self.cuts_dir.mkdir(parents=True, exist_ok=True)
        filename = self._next_filename()
        dest = self.cuts_dir / filename

        try:
            shutil.copy2(image_path, dest)
        except Exception as e:
            logger.error(f"デフォルトカット画像コピーエラー: {e}")
            return False

        entry = self._ensure_entry(circle_name)
        entry["default_cut"] = filename
        if penname and not entry.get("penname"):
            entry["penname"] = penname

        self.save()
        logger.info(f"デフォルトカットを登録: {circle_name} -> {filename}")
        return True

    # --- マージ ---

    def merge(self, other_data: Dict[str, Any]) -> int:
        """
        他のcircle_masterデータをマージする。
        - favorite: OR（どちらかがtrueならtrue）
        - genre: 空でない方を採用。両方あればローカルを維持
        - default_cut: 空でない方を採用。両方あればローカルを維持
        - penname: 空でない方を採用

        Returns:
            変更されたエントリ数
        """
        other_circles = other_data.get("circles", {})
        changed = 0

        for name, other_entry in other_circles.items():
            local_entry = self.data["circles"].get(name)

            if local_entry is None:
                # ローカルに存在しない → 丸ごと追加
                self.data["circles"][name] = dict(other_entry)
                changed += 1
                continue

            modified = False

            # favorite: OR
            if other_entry.get("favorite", False) and not local_entry.get("favorite", False):
                local_entry["favorite"] = True
                modified = True

            # genre: 空なら埋める
            if not local_entry.get("genre") and other_entry.get("genre"):
                local_entry["genre"] = other_entry["genre"]
                modified = True

            # default_cut: 空なら埋める
            if not local_entry.get("default_cut") and other_entry.get("default_cut"):
                local_entry["default_cut"] = other_entry["default_cut"]
                modified = True

            # penname: 空なら埋める
            if not local_entry.get("penname") and other_entry.get("penname"):
                local_entry["penname"] = other_entry["penname"]
                modified = True

            if modified:
                changed += 1

        return changed

    def reload(self) -> None:
        """設定を再読み込み"""
        self.load()

    def to_dict(self) -> Dict[str, Any]:
        """JSON出力用の辞書を返す"""
        return dict(self.data)
