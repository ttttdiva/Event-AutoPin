import json
from src.utils.output_cleanup import protected_output_entry_names


def test_event_image_referenced_by_event_json_is_protected(tmp_path):
    event_dir = tmp_path / "event"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps({"event": {"event_image": "manual_thumb.png"}}),
        encoding="utf-8",
    )
    (event_dir / "manual_thumb.png").write_bytes(b"image")
    (event_dir / "generated.tmp").write_text("remove me", encoding="utf-8")

    protected = protected_output_entry_names(event_dir)

    assert {"logs", "event.json", "manual_thumb.png"}.issubset(protected)
    assert "generated.tmp" not in protected


def test_event_image_named_file_is_protected_without_metadata(tmp_path):
    event_dir = tmp_path / "event"
    event_dir.mkdir()
    (event_dir / "event_image.jpg").write_bytes(b"image")

    protected = protected_output_entry_names(event_dir)

    assert "event_image.jpg" in protected
