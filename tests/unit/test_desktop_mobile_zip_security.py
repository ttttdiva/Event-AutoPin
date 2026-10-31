"""create_mobile_zip のasset参照境界テスト。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.commands.desktop_bridge import _job_create_mobile_zip


class _FakeCircleMaster:
    def __init__(self, cuts_dir: Path):
        self.cuts_dir = cuts_dir

    def to_dict(self) -> dict:
        return {"circles": {}}


def _patch_circle_master(monkeypatch: pytest.MonkeyPatch, cuts_dir: Path) -> None:
    monkeypatch.setattr(
        "src.utils.circle_master.CircleMasterManager",
        lambda: _FakeCircleMaster(cuts_dir),
    )


def _run_rejected_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    event_data: dict,
) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir(exist_ok=True)
    cuts_dir = tmp_path / "default_cuts"
    cuts_dir.mkdir()
    _patch_circle_master(monkeypatch, cuts_dir)
    event_json = output_dir / "event.json"
    event_json.write_text(json.dumps(event_data, ensure_ascii=False), encoding="utf-8")
    zip_path = tmp_path / "mobile.zip"

    with pytest.raises(ValueError):
        _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )
    # Validation happens before opening the archive, so an unsafe reference
    # cannot leave a partial ZIP behind.
    assert not zip_path.exists()


@pytest.mark.parametrize("event_data", [
    {"event": {"event_image": "../outside.jpg"}, "circles": []},
    {
        "event": {"maps": []},
        "circles": [{"circle_cut_filename": "../outside.jpg", "item_images": []}],
    },
    {
        "event": {"maps": []},
        "circles": [{"item_images": [{"path": "../outside.jpg"}]}],
    },
    {"event": {"maps": [{"filename": "../outside.jpg"}]}, "circles": []},
])
def test_absolute_or_traversal_asset_reference_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, event_data: dict
):
    _run_rejected_event(tmp_path, monkeypatch, event_data)


def test_absolute_event_image_reference_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"must-not-leak")
    _run_rejected_event(
        tmp_path,
        monkeypatch,
        {"event": {"event_image": str(outside)}, "circles": []},
    )


def test_midstream_asset_failure_keeps_previous_zip_and_cleans_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "event_image.jpg").write_bytes(b"image")
    event_json = output_dir / "event.json"
    event_json.write_text(
        json.dumps(
            {"event": {"event_image": "event_image.jpg"}, "circles": []},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    cuts_dir = tmp_path / "default_cuts"
    cuts_dir.mkdir()
    _patch_circle_master(monkeypatch, cuts_dir)
    zip_path = tmp_path / "mobile.zip"
    previous_bundle = b"previous-complete-bundle"
    zip_path.write_bytes(previous_bundle)

    import src.commands.desktop_bridge as bridge

    original_resolve = bridge._resolve_contained_asset

    def reject_during_copy(root: Path, reference: str, *, label: str):
        if label == "asset":
            raise ValueError("simulated asset change during copy")
        return original_resolve(root, reference, label=label)

    monkeypatch.setattr(bridge, "_resolve_contained_asset", reject_during_copy)
    with pytest.raises(ValueError, match="simulated asset change"):
        _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )

    assert zip_path.read_bytes() == previous_bundle
    assert not list(tmp_path.glob(f".{zip_path.name}.*.tmp"))


def test_symlink_asset_outside_output_root_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"must-not-leak")
    output_dir = tmp_path / "output"
    (output_dir / "circles").mkdir(parents=True)
    link = output_dir / "circles" / "link.jpg"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    _run_rejected_event(
        tmp_path,
        monkeypatch,
        {
            "event": {"maps": []},
            "circles": [{"circle_cut_filename": "circles/link.jpg", "item_images": []}],
        },
    )


def test_default_cut_symlink_outside_default_root_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"must-not-leak")
    cuts_dir = tmp_path / "default_cuts"
    cuts_dir.mkdir()
    link = cuts_dir / "link.jpg"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    output_dir = tmp_path / "output"
    output_dir.mkdir()
    _patch_circle_master(monkeypatch, cuts_dir)
    event_json = output_dir / "event.json"
    event_json.write_text(json.dumps({"event": {}, "circles": []}), encoding="utf-8")
    zip_path = tmp_path / "mobile.zip"
    with pytest.raises(ValueError):
        _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )
    assert not zip_path.exists()


def _make_event_zip_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    assets = {
        "event.jpg": b"event-image",
        "circles/cut.jpg": b"circle-cut",
        "items/item.jpg": b"item-image",
        "map_1.jpg": b"map-image",
        "default_cuts/shared.jpg": b"event-copy-of-shared-cut",
    }
    for relative, content in assets.items():
        path = output_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    cuts_dir = tmp_path / "shared_default_cuts"
    cuts_dir.mkdir()
    (cuts_dir / "shared.jpg").write_bytes(b"global-shared-cut")
    _patch_circle_master(monkeypatch, cuts_dir)
    event = {
        "event": {
            "uid": "event-uid-123",
            "event_image": "event.jpg",
            "maps": [{"filename": "map_1.jpg"}],
        },
        "circles": [
            {
                "circle_cut_filename": "circles/cut.jpg",
                "item_images": [{"path": "items/item.jpg"}],
            }
        ],
    }
    event_json = output_dir / "event.json"
    event_json.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
    return output_dir, event_json, event


def test_default_mobile_zip_keeps_shared_circle_master_and_default_cuts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output_dir, event_json, _event = _make_event_zip_fixture(tmp_path, monkeypatch)
    zip_path = tmp_path / "legacy.zip"

    result = _job_create_mobile_zip(
        {
            "event_json": str(event_json),
            "output_dir": str(output_dir),
            "zip_output_path": str(zip_path),
        }
    )

    import zipfile

    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        assert "circle_master.json" in names
        manifest = json.loads(archive.read("asset_manifest.json"))
        shared_cut_asset = manifest["aliases"]["default_cuts/shared.jpg"]
        assert shared_cut_asset in names
        assert archive.read(shared_cut_asset) == b"global-shared-cut"
    assert result["default_cuts"] == 1
    assert any(name.startswith("default_cuts/") for name in manifest["aliases"])


def test_single_event_sync_zip_contains_only_event_owned_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output_dir, event_json, event = _make_event_zip_fixture(tmp_path, monkeypatch)
    zip_path = tmp_path / "event-sync.zip"

    result = _job_create_mobile_zip(
        {
            "event_json": str(event_json),
            "output_dir": str(output_dir),
            "zip_output_path": str(zip_path),
            "include_shared_settings": False,
        }
    )

    import zipfile

    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        assert "event.json" in names
        assert "asset_manifest.json" in names
        assert "circle_master.json" not in names
        assert not any(name.startswith("default_cuts/") for name in names)
        archived_event = json.loads(archive.read("event.json"))
        manifest = json.loads(archive.read("asset_manifest.json"))

    assert archived_event == event
    assert archived_event["event"]["uid"] == "event-uid-123"
    assert result["default_cuts"] == 0
    assert {
        "event_image/event.jpg",
        "circles/cut.jpg",
        "items/item.jpg",
        "map_1.jpg",
    } <= set(
        manifest["aliases"]
    )
    assert not any(name.startswith("default_cuts/") for name in manifest["aliases"])
    assert all(
        not name.startswith("default_cuts/")
        for asset in manifest["assets"].values()
        for name in asset["original_names"]
    )
