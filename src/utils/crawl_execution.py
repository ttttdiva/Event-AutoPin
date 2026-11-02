"""クロール実行の入力契約・実行計画・排他制御。

デスクトップUIから届く payload は、旧CLI設定と新しい一括実行設定が
混在しても同じ形で処理できる必要があります。このモジュールには外部
APIを呼ばない純粋な正規化/検証を置き、bridge はこの結果を実行前に
確認します。バックアップと出力ディレクトリのロックも、実処理から
独立した小さな補助として提供します。
"""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import date, datetime
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

import yaml


DEFAULT_COLLECT_CATALOGS = True
DEFAULT_ENABLE_TWITTER_CATALOG = True
DEFAULT_USE_GROK_SEARCH = False
DEFAULT_GROK_SEARCH_MODE = "api"
DEFAULT_BACKUP = False
DEFAULT_REPROCESS = False
DEFAULT_REGENERATE_COORDINATES = False
DEFAULT_SKIP_CIRCLE_IMAGES = False
DEFAULT_VERBOSE = False
DEFAULT_DAYS_BEFORE = 30
DEFAULT_DAYS_AFTER = 7
GROK_SEARCH_MODES = ("api", "build", "bot")

_TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
_FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


class CrawlValidationError(ValueError):
    """payload が実行契約を満たさないときに使うエラー。"""

    def __init__(self, errors: Sequence[str], warnings: Sequence[str] = ()) -> None:
        self.errors = list(dict.fromkeys(str(item) for item in errors if str(item)))
        self.warnings = list(dict.fromkeys(str(item) for item in warnings if str(item)))
        super().__init__("; ".join(self.errors) or "クロール設定が不正です")


class CrawlExecutionBusyError(RuntimeError):
    """同じ出力先で別のクロールが実行中。"""

    error_code = "crawl_already_running"


@dataclass(frozen=True)
class EventSource:
    """一つのイベントサイト入力。"""

    name: str
    url: str
    map_urls: Tuple[str, ...] = ()
    catalog_additional_prompt: str = ""

    def as_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {"name": self.name, "url": self.url}
        if self.map_urls:
            data["map_urls"] = list(self.map_urls)
        if self.catalog_additional_prompt:
            data["catalog_additional_prompt"] = self.catalog_additional_prompt
        return data


@dataclass(frozen=True)
class CrawlExecutionPlan:
    """検証済みクロールの実行方針。"""

    reprocess: bool
    collect_catalogs: bool
    enable_twitter_catalog: bool
    use_grok_search: bool
    grok_search_mode: str
    backup: bool
    regenerate_coordinates: bool
    skip_circle_images: bool
    verbose: bool
    days_before: int
    days_after: int
    event_sources: Tuple[EventSource, ...]
    twitter_strategy: str
    catalog_strategy: str
    effective_stages: Tuple[str, ...] = ()
    warnings: Tuple[str, ...] = ()

    @property
    def urls(self) -> List[str]:
        return [source.url for source in self.event_sources]

    def as_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["event_sources"] = [source.as_dict() for source in self.event_sources]
        data["warnings"] = list(self.warnings)
        data["effective_stages"] = list(self.effective_stages)
        data["urls"] = self.urls
        return data


def _raw_settings(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """トップレベルと ``crawl_settings`` を一つへ統合する。

    新UIは options を nested にして送れる一方、旧UI/CLI は top-level
    を使うため、nested を先に読み、top-level の明示値を優先します。
    ``event_sources`` のような入力データは options へ複製しません。
    """

    nested = payload.get("crawl_settings")
    result: Dict[str, Any] = dict(nested) if isinstance(nested, Mapping) else {}
    for key, value in payload.items():
        if key == "crawl_settings":
            continue
        if value is not None:
            result[key] = value
    return result


def _bool(value: Any, *, name: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value in (0, 1):
            return bool(value)
    text = str(value).strip().lower()
    if text in _TRUE_VALUES:
        return True
    if text in _FALSE_VALUES:
        return False
    raise CrawlValidationError([f"{name} は真偽値で指定してください"])


def _non_negative_int(value: Any, *, name: str, default: int, maximum: int = 3650) -> int:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise CrawlValidationError([f"{name} は0以上の整数で指定してください"])
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise CrawlValidationError([f"{name} は0以上の整数で指定してください"]) from exc
    is_integer_value = (
        isinstance(value, float) and value.is_integer()
    ) or (
        isinstance(value, str) and re.fullmatch(r"\+?\d+", value.strip()) is not None
    ) or isinstance(value, int)
    if number < 0 or number > maximum or not is_integer_value:
        raise CrawlValidationError([f"{name} は0以上{maximum}以下の整数で指定してください"])
    return number


def _valid_url(value: Any, *, field: str) -> str:
    text = str(value or "").strip()
    parsed = urlsplit(text)
    if not _URL_RE.match(text) or not parsed.netloc or any(ch.isspace() for ch in text):
        raise CrawlValidationError([f"{field} は http(s) URL で指定してください"])
    return text


def _url_values(value: Any, *, field: str) -> List[str]:
    if value is None or value == "":
        return []
    values: List[Any]
    if isinstance(value, str):
        values = re.findall(r"https?://[^\s,]+", value, flags=re.IGNORECASE)
        if not values and value.strip():
            values = [value.strip()]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        values = list(value)
    else:
        raise CrawlValidationError([f"{field} はURLの配列で指定してください"])
    result: List[str] = []
    for item in values:
        text = str(item or "").strip().rstrip(",])};")
        if not text:
            continue
        url = _valid_url(text, field=field)
        if url not in result:
            result.append(url)
    return result


def _event_date(value: Any, *, field: str = "event_date") -> Optional[str]:
    if value is None or value == "":
        return None
    text = str(value).strip()
    try:
        parsed = datetime.strptime(text, "%Y-%m-%d").date()
    except (TypeError, ValueError) as exc:
        raise CrawlValidationError(
            [f"{field}が不正です（YYYY-MM-DD形式の実在日が必要です）"]
        ) from exc
    # strptime accepts zero-padded values only in the strict form above, and
    # date.isoformat gives one canonical value to the subprocess config.
    return parsed.isoformat()


def _source_list(settings: Mapping[str, Any]) -> List[EventSource]:
    raw_sources = settings.get("event_sources")
    sources: List[EventSource] = []
    if raw_sources is not None:
        if not isinstance(raw_sources, list):
            raise CrawlValidationError(["event_sources は配列で指定してください"])
        for index, raw in enumerate(raw_sources, start=1):
            if not isinstance(raw, Mapping):
                raise CrawlValidationError([f"event_sources[{index}] はオブジェクトで指定してください"])
            try:
                url = _valid_url(raw.get("url"), field=f"event_sources[{index}].url")
            except CrawlValidationError:
                raise
            name = str(raw.get("name") or "").strip() or url
            maps = _url_values(
                raw.get("map_urls", raw.get("map_url")),
                field=f"event_sources[{index}].map_urls",
            )
            prompt = raw.get("catalog_additional_prompt", raw.get("additional_prompt", ""))
            if prompt is None:
                prompt = ""
            if not isinstance(prompt, str):
                raise CrawlValidationError(
                    [f"event_sources[{index}].catalog_additional_prompt は文字列で指定してください"]
                )
            if any(source.url == url for source in sources):
                raise CrawlValidationError([f"event_sources[{index}].url が重複しています"])
            sources.append(EventSource(name, url, tuple(maps), prompt))

    raw_urls: List[str] = []
    for key in ("urls", "event_urls", "url"):
        raw_urls.extend(_url_values(settings.get(key), field=key))
    for url in raw_urls:
        if not any(source.url == url for source in sources):
            sources.append(EventSource(url, url))
    return sources


def _explicit_catalog_urls(payload: Mapping[str, Any]) -> List[str]:
    """保存済みJSONに残り得る明示的なポスト/カタログURLの候補。"""

    urls: List[str] = []
    for key in ("catalog_urls", "catalog_url", "post_urls", "post_url", "oshinagaki_post"):
        value = payload.get(key)
        if isinstance(value, Mapping):
            nested: List[Any] = []
            for item in value.values():
                nested.extend(item if isinstance(item, list) else [item])
            value = nested
        try:
            urls.extend(_url_values(value, field=key))
        except CrawlValidationError:
            # This is only a strategy hint; malformed optional candidates are
            # rejected by their owning job, not silently converted here.
            continue
    return list(dict.fromkeys(urls))


def normalize_crawl_payload(
    payload: Mapping[str, Any],
    *,
    require_output_dir: bool = False,
    require_event_date: bool = False,
) -> Dict[str, Any]:
    """payload を検証済みの JSON 互換辞書へ正規化する。

    外部API・ファイルには触れません。問題があれば
    :class:`CrawlValidationError` を送出します。
    """

    if not isinstance(payload, Mapping):
        raise CrawlValidationError(["crawl payload はオブジェクトで指定してください"])
    settings = _raw_settings(payload)
    reprocess = _bool(settings.get("reprocess"), name="reprocess", default=DEFAULT_REPROCESS)
    collect_catalogs = _bool(
        settings.get("collect_catalogs"), name="collect_catalogs", default=DEFAULT_COLLECT_CATALOGS
    )
    enable_twitter = _bool(
        settings.get("enable_twitter_catalog"),
        name="enable_twitter_catalog",
        default=DEFAULT_ENABLE_TWITTER_CATALOG,
    )
    use_grok = _bool(
        settings.get("use_grok_search"), name="use_grok_search", default=DEFAULT_USE_GROK_SEARCH
    )
    backup = _bool(settings.get("backup"), name="backup", default=DEFAULT_BACKUP)
    regenerate = _bool(
        settings.get("regenerate_coordinates"),
        name="regenerate_coordinates",
        default=DEFAULT_REGENERATE_COORDINATES,
    )
    skip_images = _bool(
        settings.get("skip_circle_images"),
        name="skip_circle_images",
        default=DEFAULT_SKIP_CIRCLE_IMAGES,
    )
    verbose = _bool(settings.get("verbose"), name="verbose", default=DEFAULT_VERBOSE)

    raw_mode = settings.get("grok_search_mode", DEFAULT_GROK_SEARCH_MODE)
    grok_mode = str(raw_mode or DEFAULT_GROK_SEARCH_MODE).strip().lower()
    if grok_mode not in GROK_SEARCH_MODES:
        raise CrawlValidationError(["grok_search_mode は api/build/bot のいずれかで指定してください"])

    days_before = _non_negative_int(
        settings.get("days_before"), name="days_before", default=DEFAULT_DAYS_BEFORE
    )
    days_after = _non_negative_int(
        settings.get("days_after"), name="days_after", default=DEFAULT_DAYS_AFTER
    )
    event_date = _event_date(settings.get("event_date"))
    if require_event_date and not reprocess and event_date is None:
        raise CrawlValidationError(["event_date はYYYY-MM-DD形式の実在日を指定してください"])

    sources = _source_list(settings)
    if reprocess:
        # URL/urlsは再処理対象として使わない。一方、event_sourcesは
        # 保存済みcircle.source_event_urlへ対応する設定として保持する。
        raw_sources = settings.get("event_sources")
        sources = (
            _source_list({"event_sources": raw_sources})
            if isinstance(raw_sources, list)
            else []
        )
    if not reprocess and not sources:
        raise CrawlValidationError(["url または event_sources を1件以上指定してください"])
    if require_output_dir and not str(settings.get("output_dir") or "").strip():
        raise CrawlValidationError(["output_dir は必須です"])

    warnings: List[str] = []
    if reprocess and sources:
        warnings.append(
            "reprocess=trueではcrawl URLを使用せず、event_sourcesは保存済みsource設定として利用します"
        )
    if reprocess:
        warnings.append(
            "再処理では保存済みのサークル画像を保持します（skip_circle_imagesは新規サイト収集時のみ適用）"
        )
    if not use_grok and "use_grok_search" in settings:
        # Explicit OFF must not allow legacy Build rescue to come back.
        warnings.append("use_grok_search=falseのため全Grok方式を無効化します")

    if not collect_catalogs:
        catalog_strategy = "disabled"
        twitter_strategy = "disabled"
        warnings.append("collect_catalogs=falseのため、おしながき本文・画像解析/取得を行いません")
    elif not enable_twitter:
        catalog_strategy = "explicit_urls_only"
        twitter_strategy = "explicit_urls_only"
        if not _explicit_catalog_urls(settings):
            warnings.append("enable_twitter_catalog=falseのためX検索は行わず、明示された保存済みURLだけを処理します")
    else:
        catalog_strategy = "full"
        twitter_strategy = "search_and_collect"

    if reprocess and not collect_catalogs and not regenerate:
        raise CrawlValidationError(
            [
                "再処理する対象がありません（collect_catalogs=false、"
                "regenerate_coordinates=false）"
            ],
            warnings,
        )

    effective_stages: List[str] = []
    if reprocess:
        if collect_catalogs:
            effective_stages.append(
                "stored_catalog_urls" if not enable_twitter else "stored_catalogs_and_x"
            )
        if regenerate:
            effective_stages.append("coordinates")
    else:
        effective_stages.append("site_catalog")
        if collect_catalogs and enable_twitter:
            effective_stages.append("x_catalogs")
        if not skip_images:
            effective_stages.append("circle_images")
        if regenerate:
            effective_stages.append("coordinates")

    normalized: Dict[str, Any] = dict(payload)
    # Keep nested options intact while making canonical values available to
    # older subprocess code that reads flat config keys.
    canonical_settings = {
        "collect_catalogs": collect_catalogs,
        "enable_twitter_catalog": enable_twitter,
        "use_grok_search": use_grok,
        "grok_search_mode": grok_mode,
        "backup": backup,
        "reprocess": reprocess,
        "regenerate_coordinates": regenerate,
        "skip_circle_images": skip_images,
        "verbose": verbose,
        "days_before": days_before,
        "days_after": days_after,
    }
    preserved_settings = (
        dict(payload.get("crawl_settings"))
        if isinstance(payload.get("crawl_settings"), Mapping)
        else {}
    )
    preserved_settings.update(canonical_settings)
    normalized.update(
        {
            "collect_catalogs": collect_catalogs,
            "enable_twitter_catalog": enable_twitter,
            "use_grok_search": use_grok,
            "grok_search_mode": grok_mode,
            "backup": backup,
            "reprocess": reprocess,
            "regenerate_coordinates": regenerate,
            "skip_circle_images": skip_images,
            "verbose": verbose,
            "days_before": days_before,
            "days_after": days_after,
            "event_sources": [source.as_dict() for source in sources],
            "event_urls": [] if reprocess else [source.url for source in sources],
            "event_date": event_date or settings.get("event_date"),
            "crawl_settings": preserved_settings,
        }
    )
    # 成功したfresh crawlの実入力URLだけを保存する。reprocessでは空配列で
    # 既存値を上書きせず、JSONFormatterのbaseline carryに任せる。
    if not reprocess:
        normalized["crawl_data_source_urls"] = [source.url for source in sources]
    if require_output_dir and str(settings.get("output_dir") or "").strip():
        normalized["output_dir"] = settings["output_dir"]
    plan = CrawlExecutionPlan(
        reprocess=reprocess,
        collect_catalogs=collect_catalogs,
        enable_twitter_catalog=enable_twitter,
        use_grok_search=use_grok,
        grok_search_mode=grok_mode,
        backup=backup,
        regenerate_coordinates=regenerate,
        skip_circle_images=skip_images,
        verbose=verbose,
        days_before=days_before,
        days_after=days_after,
        event_sources=tuple(sources),
        twitter_strategy=twitter_strategy,
        catalog_strategy=catalog_strategy,
        effective_stages=tuple(effective_stages),
        warnings=tuple(warnings),
    )
    normalized["execution_plan"] = plan.as_dict()
    normalized["validation_warnings"] = list(warnings)
    return normalized


def validate_crawl_payload(
    payload: Mapping[str, Any],
    *,
    require_output_dir: bool = False,
    require_event_date: bool = False,
) -> Dict[str, Any]:
    """UI向けの非例外 validation job 契約。"""

    try:
        normalized = normalize_crawl_payload(
            payload,
            require_output_dir=require_output_dir,
            require_event_date=require_event_date,
        )
    except CrawlValidationError as exc:
        return {
            "valid": False,
            "errors": list(exc.errors),
            "warnings": list(exc.warnings),
            "normalized": None,
            "plan": None,
        }
    return {
        "valid": True,
        "errors": [],
        "warnings": list(normalized.get("validation_warnings") or []),
        "normalized": normalized,
        "plan": normalized.get("execution_plan"),
    }


def create_backup(
    output_dir: str | os.PathLike[str],
    *,
    label: str = "crawl",
    backup_root: str | os.PathLike[str] | None = None,
) -> Optional[Path]:
    """event.json と生成済みアセットを同一イベントの復旧用に複製する。

    出力先がまだ存在しない場合は何も作らず ``None`` を返します。
    バックアップはイベント一覧の探索対象外（通常はproject/.local）へ
    置くため、通常の `event.json` cleanup や再処理対象に混入しません。
    """

    source = Path(output_dir).resolve()
    if not source.is_dir() or not any(source.iterdir()):
        return None
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_label = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(label or "crawl"))[:48] or "crawl"
    root = (
        Path(backup_root).resolve()
        if backup_root is not None
        else source.parent.parent / ".event-autopin-backups"
    )
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{source.name}.{safe_label}.backup-{stamp}"
    # mktemp-style reservation prevents two simultaneous callers from choosing
    # the same destination even when timestamp resolution is coarse.
    try:
        target.mkdir(parents=False, exist_ok=False)
    except FileExistsError:
        target = root / f"{source.name}.{safe_label}.backup-{stamp}-{os.getpid()}"
        target.mkdir(parents=False, exist_ok=False)
    try:
        for item in source.iterdir():
            if item.name in {".crawl.lock", ".crawl-backup.lock"}:
                continue
            destination = target / item.name
            if item.is_dir():
                shutil.copytree(item, destination)
            elif item.is_file():
                shutil.copy2(item, destination)
        return target
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise


def _deep_merge_yaml(existing: Mapping[str, Any], incoming: Mapping[str, Any]) -> Dict[str, Any]:
    """既存設定を保持しつつ、提示されたキーだけを更新する。

    mapping同士は再帰マージするが、incomingの空mapping ``{}`` は
    「明示的にクリア」の意図として置換する。配列・scalarは常に置換し、
    既存の未知キーや資格情報キーの値を返却しない。
    """

    result = deepcopy(dict(existing))
    for key, value in incoming.items():
        if isinstance(value, Mapping):
            if not value:
                result[key] = {}
            elif isinstance(result.get(key), Mapping):
                result[key] = _deep_merge_yaml(result[key], value)
            else:
                result[key] = deepcopy(dict(value))
        else:
            result[key] = deepcopy(value)
    return result


def _atomic_write_yaml(path: Path, data: Mapping[str, Any]) -> None:
    """YAMLを同一ディレクトリの一時ファイルから原子的に公開する。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            yaml.safe_dump(dict(data), handle, allow_unicode=True, sort_keys=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        raise


def save_crawl_project_config(
    project_root: str | os.PathLike[str], yaml_content: str
) -> Dict[str, str]:
    """config.yamlへcrawl設定を未知キー保持で原子的に保存する。

    既存/入力いずれかが不正なら保存前に失敗し、既存ファイルを変更しない。
    戻り値には機密を含む設定内容を一切載せない。
    """

    if not isinstance(yaml_content, str):
        raise ValueError("yaml_contentは文字列で指定してください")
    root = Path(project_root).resolve()
    path = root / "config.yaml"
    existing: Dict[str, Any] = {}
    if path.exists():
        try:
            raw_existing = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, yaml.YAMLError) as exc:
            raise ValueError(f"既存config.yamlの読み込みに失敗しました: {type(exc).__name__}") from exc
        if raw_existing is None:
            raw_existing = {}
        if not isinstance(raw_existing, Mapping):
            raise ValueError("既存config.yamlのrootはobjectである必要があります")
        existing = dict(raw_existing)
    try:
        raw_incoming = yaml.safe_load(yaml_content)
    except (yaml.YAMLError, UnicodeError) as exc:
        raise ValueError(f"入力yamlの解析に失敗しました: {type(exc).__name__}") from exc
    if raw_incoming is None:
        raw_incoming = {}
    if not isinstance(raw_incoming, Mapping):
        raise ValueError("入力yamlのrootはobjectである必要があります")
    merged = _deep_merge_yaml(existing, raw_incoming)
    _atomic_write_yaml(path, merged)
    return {"status": "ok"}


@contextmanager
def crawl_output_lock(output_dir: str | os.PathLike[str]) -> Iterator[Path]:
    """同じ出力ディレクトリへのクロールを排他する。

    固定lockファイルのfdへOS advisory lockを掛ける。プロセス異常終了
    時はWindows/POSIXともfd解放に伴いOSがlockを解放するため、stale
    lock判定やPID再利用判定を行わずに再実行できる。
    """

    directory = Path(output_dir).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    # main.pyの既存出力cleanupがイベントディレクトリ内を走査するため、
    # lockは兄弟の隠しファイルに置いて実行中に削除されないようにする。
    lock_path = directory.parent / f".{directory.name}.crawl.lock"
    handle = None
    try:
        handle = lock_path.open("a+b")
    except OSError:
        raise
    try:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if handle is not None:
            handle.close()
        raise CrawlExecutionBusyError(
            f"出力先で別のクロールが実行中です: {directory}"
        ) from exc
    try:
        yield lock_path
    finally:
        if handle is not None:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            finally:
                handle.close()


__all__ = [
    "CrawlExecutionBusyError",
    "CrawlExecutionPlan",
    "CrawlValidationError",
    "EventSource",
    "DEFAULT_GROK_SEARCH_MODE",
    "GROK_SEARCH_MODES",
    "create_backup",
    "save_crawl_project_config",
    "crawl_output_lock",
    "normalize_crawl_payload",
    "validate_crawl_payload",
]
