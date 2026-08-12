"""src.utils.circle_master のテスト。

circle_master.json の読み書き、マージ、お気に入り判定、
デフォルトカット画像の登録・取得を検証する。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.utils.circle_master import CircleMasterManager


@pytest.fixture
def master_paths(tmp_path: Path) -> tuple[str, str]:
    """tmp_path配下に空のconfig_path/cuts_dirを用意して絶対パスで返す。"""
    config_path = tmp_path / "circle_master.json"
    cuts_dir = tmp_path / "default_cuts"
    cuts_dir.mkdir()
    return str(config_path), str(cuts_dir)


def _make_image(path: Path, size: int = 16) -> Path:
    """ダミー画像ファイルを作る（内容はバイナリ文字列でOK）。"""
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * size)
    return path


class TestLoadSave:
    def test_存在しないファイルは空状態で初期化される(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.data == {"circles": {}}

    def test_既存ファイルから読み込める(self, master_paths):
        config_path, cuts_dir = master_paths
        Path(config_path).write_text(
            json.dumps({"circles": {"A": {"penname": "p", "favorite": True}}}),
            encoding="utf-8",
        )
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.get("A") == {"penname": "p", "favorite": True}

    def test_saveで内容がファイルに書かれる(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_favorite("A", "p", True)
        m.save()
        saved = json.loads(Path(config_path).read_text(encoding="utf-8"))
        assert saved["circles"]["A"]["favorite"] is True

    def test_circlesキーがないJSONでも復旧する(self, master_paths):
        config_path, cuts_dir = master_paths
        Path(config_path).write_text(
            json.dumps({"something_else": 1}), encoding="utf-8"
        )
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert "circles" in m.data
        assert m.data["circles"] == {}


class TestFavorite:
    def test_お気に入り設定と判定(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.is_favorite("A", "p") is False
        m.set_favorite("A", "p", True)
        assert m.is_favorite("A", "") is True
        assert m.is_favorite("", "p") is True

    def test_トグルで状態が反転する(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.toggle_favorite("A", "p") is True
        assert m.toggle_favorite("A", "p") is False

    def test_全お気に入りを取得できる(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_favorite("A", "pa", True)
        m.set_favorite("B", "pb", False)
        m.set_favorite("C", "pc", True)
        favorites = m.get_all_favorites()
        names = {f["name"] for f in favorites}
        assert names == {"A", "C"}


class TestGenre:
    def test_ジャンル設定と取得(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.get_genre("A") is None
        m.set_genre("A", "創作")
        assert m.get_genre("A") == "創作"

    def test_空文字列ジャンルはNone扱い(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_genre("A", "")
        assert m.get_genre("A") is None


class TestDefaultCut:
    def test_登録前はNoneを返す(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.get_default_cut("A") is None
        assert m.has_default_cut("A") is False

    def test_画像を登録してコピーできる(self, tmp_path: Path, master_paths):
        config_path, cuts_dir = master_paths
        src_img = _make_image(tmp_path / "source.jpg")

        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        ok = m.register_default_cut("サークルA", "作者A", src_img)
        assert ok is True
        assert m.has_default_cut("サークルA") is True

        # cuts_dir配下にコピーされている
        dest = m.get_default_cut("サークルA")
        assert dest is not None
        assert dest.exists()
        assert dest.parent == Path(cuts_dir)

    def test_登録済みサークルは再登録されない(self, tmp_path: Path, master_paths):
        config_path, cuts_dir = master_paths
        img1 = _make_image(tmp_path / "a.jpg")
        img2 = _make_image(tmp_path / "b.jpg")

        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.register_default_cut("A", "pa", img1) is True
        assert m.register_default_cut("A", "pa", img2) is False

    def test_連番ファイル名が加算される(self, tmp_path: Path, master_paths):
        config_path, cuts_dir = master_paths
        img1 = _make_image(tmp_path / "a.jpg")
        img2 = _make_image(tmp_path / "b.jpg")

        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.register_default_cut("A", "pa", img1)
        m.register_default_cut("B", "pb", img2)

        cuts = sorted(Path(cuts_dir).glob("*.jpg"))
        assert len(cuts) == 2
        stems = sorted(c.stem for c in cuts)
        assert stems == ["0000", "0001"]

    def test_存在しない画像は登録失敗(self, tmp_path: Path, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        assert m.register_default_cut("A", "pa", tmp_path / "ghost.jpg") is False

    def test_copy_default_cutでプレフィックス付きコピーできる(
        self, tmp_path: Path, master_paths
    ):
        config_path, cuts_dir = master_paths
        src_img = _make_image(tmp_path / "source.jpg")
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.register_default_cut("A", "pa", src_img)

        out_dir = tmp_path / "out"
        out_dir.mkdir()
        copied = m.copy_default_cut("A", out_dir, prefix="default_")
        assert copied is not None
        assert copied.exists()
        assert copied.name.startswith("default_")


class TestMerge:
    def test_新規サークルは追加される(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        changed = m.merge(
            {"circles": {"NEW": {"penname": "p", "favorite": True, "genre": "g"}}}
        )
        assert changed == 1
        assert m.get("NEW")["favorite"] is True

    def test_favoriteはORで統合される(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_favorite("A", "", False)
        m.merge({"circles": {"A": {"favorite": True}}})
        assert m.get("A")["favorite"] is True

    def test_ローカルにfavorite_trueがあれば外部falseに負けない(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_favorite("A", "", True)
        m.merge({"circles": {"A": {"favorite": False}}})
        assert m.get("A")["favorite"] is True

    def test_空フィールドのみ外部値で埋まる(self, master_paths):
        config_path, cuts_dir = master_paths
        m = CircleMasterManager(config_path=config_path, cuts_dir=cuts_dir)
        m.set_genre("A", "既存ジャンル")
        m.merge({"circles": {"A": {"genre": "上書きしない", "penname": "新しい"}}})
        entry = m.get("A")
        assert entry["genre"] == "既存ジャンル"
        assert entry["penname"] == "新しい"
