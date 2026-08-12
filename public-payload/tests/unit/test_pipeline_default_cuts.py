from __future__ import annotations

from pathlib import Path

from src.core.pipeline import ExtractionPipeline
from src.models import Circle, ItemImage


class FakeCircleMaster:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Path]] = []

    def register_default_cut(self, circle_name: str, penname: str, image_path: Path) -> bool:
        self.calls.append((circle_name, penname, image_path))
        return True


def test_register_missing_cuts_also_sets_current_circle_cut(tmp_path: Path):
    item_file = tmp_path / "catalog_sample.jpg"
    item_file.write_bytes(b"image")
    circle = Circle(
        name="Circle A",
        penname="Author A",
        item_images=[ItemImage(path=item_file.name, source="twitter")],
    )

    pipeline = object.__new__(ExtractionPipeline)
    pipeline.output_dir = tmp_path
    pipeline.circle_master = FakeCircleMaster()
    pipeline.logger = type("Logger", (), {"info": lambda self, msg: None})()

    pipeline._register_missing_cuts_as_default([circle])

    assert circle.circle_cut is not None
    assert circle.circle_cut.url == ""
    assert circle.circle_cut.filename == item_file.name
    assert pipeline.circle_master.calls == [
        ("Circle A", "Author A", tmp_path / item_file.name)
    ]
