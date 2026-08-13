"""Durable atomic JSON writes shared by standalone Python entry points."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional, Union


_REPLACE_LOCK = threading.Lock()


def _fsync_parent_directory(parent: Path) -> None:
    """Best-effort directory sync so a published rename survives power loss."""

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(str(parent), flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_write_json(
    path: Union[str, Path],
    data: Any,
    *,
    indent: int = 2,
    trailing_newline: bool = True,
) -> None:
    """Serialize *data* to a sibling temp file and atomically replace *path*.

    The parent directory must already exist.  This deliberately fails closed
    when an event directory is deleted while a late standalone writer is
    running instead of recreating the deleted event.
    """

    destination = Path(path)
    parent = destination.parent
    if not parent.is_dir():
        raise FileNotFoundError(f"JSON parent directory does not exist: {parent}")

    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=str(parent),
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=indent)
            if trailing_newline:
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        # Concurrent MoveFileEx replace calls can transiently return access
        # denied on Windows.  Serialize publication and retry only bounded
        # sharing/access errors; the destination remains intact on failure.
        with _REPLACE_LOCK:
            last_error: Optional[OSError] = None
            for attempt in range(20):
                try:
                    os.replace(temporary, destination)
                    last_error = None
                    break
                except PermissionError as error:
                    last_error = error
                    if attempt < 19:
                        time.sleep(0.005)
            if last_error is not None:
                raise last_error
            _fsync_parent_directory(parent)
    except BaseException:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        raise
