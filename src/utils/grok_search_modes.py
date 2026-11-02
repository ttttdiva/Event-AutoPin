"""Grok検索3方式の設定解決と、送信しない利用可否probe。

このモジュールはUI/bridgeとTwitter処理の間に置く設定の正本です。
``grok_search_mode`` が明示されている新契約では、``use_grok_search`` を
全方式共通のon/offとして扱い、選択した方式だけを有効にします。
同キーがない旧設定では、従来どおりAPIの ``use_grok_search`` とBuild救済の
``use_grok_rescue``（既定true）を独立して扱います。

probeは秘密値を返さず、APIは環境変数の有無、Buildは既存の無送信models
probe、BotはAoiTalkのbindingとローカルdesktop-statusだけを確認します。
Botの実送信・会話・外部API呼び出しはこのモジュールでは行いません。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

GROK_SEARCH_MODES = ("api", "build", "bot")
DEFAULT_GROK_SEARCH_MODE = "api"

_TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
_FALSE_VALUES = {"0", "false", "no", "off", "disabled", ""}
_MODE_ALIASES = {
    "api": "api",
    "xai": "api",
    "xai-api": "api",
    "grok-api": "api",
    "build": "build",
    "cli": "build",
    "grok-build": "build",
    "bot": "bot",
    "grok-bot": "bot",
    "chat": "bot",
}


def _config_value(config: Any, key: str, default: Any = None) -> Any:
    if isinstance(config, Mapping):
        return config.get(key, default)
    getter = getattr(config, "get", None)
    if callable(getter):
        try:
            return getter(key, default)
        except TypeError:
            return default
    return getattr(config, key, default)


def _as_bool(value: Any, default: bool = False) -> bool:
    """YAML/GUI由来の真偽値を安全に正規化する。"""

    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    text = str(value).strip().lower()
    if text in _TRUE_VALUES:
        return True
    if text in _FALSE_VALUES:
        return False
    return default


def normalize_grok_search_mode(value: Any) -> Optional[str]:
    """``api`` / ``build`` / ``bot`` のいずれかへ正規化する。

    未指定・空文字・未知値は ``None`` を返す。未知値をAPIへ黙って
    フォールバックさせないことで、明示設定の誤り時に意図しない送信を
    防ぐ。
    """

    if value is None:
        return None
    key = str(value).strip().lower().replace("_", "-").replace(" ", "-")
    return _MODE_ALIASES.get(key)


@dataclass(frozen=True)
class GrokSearchSettings:
    """正規化済みの方式設定。"""

    enabled: bool
    mode: Optional[str]
    explicit_mode: bool
    mode_valid: bool
    api_enabled: bool
    build_enabled: bool
    bot_enabled: bool
    legacy: bool

    @property
    def selected_mode(self) -> Optional[str]:
        """実行対象の単一方式（legacyではAPI/Buildの複合をNone扱い）。"""

        if not self.explicit_mode:
            return None
        return self.mode if self.enabled and self.mode_valid else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "explicit_mode": self.explicit_mode,
            "mode_valid": self.mode_valid,
            "api_enabled": self.api_enabled,
            "build_enabled": self.build_enabled,
            "bot_enabled": self.bot_enabled,
            "legacy": self.legacy,
        }


def resolve_grok_search_settings(config: Any) -> GrokSearchSettings:
    """GUI/legacy設定を1つの実行契約へ解決する。

    ``grok_search_mode`` キーが存在して空でない場合を新契約の明示modeと
    判定する。新契約のOFF（``use_grok_search=false``）では全方式を停止し、
    とくにBuild救済が既定値で復活しない。
    """

    raw_mode = _config_value(config, "grok_search_mode", None)
    explicit_mode = raw_mode is not None and str(raw_mode).strip() != ""
    mode = normalize_grok_search_mode(raw_mode) if explicit_mode else None
    mode_valid = not explicit_mode or mode in GROK_SEARCH_MODES
    enabled = _as_bool(_config_value(config, "use_grok_search", False), False)

    if explicit_mode:
        api_enabled = enabled and mode == "api"
        build_enabled = enabled and mode == "build"
        bot_enabled = enabled and mode == "bot"
    else:
        # 旧設定の互換: APIとBuild救済は独立していた。
        api_enabled = enabled
        build_enabled = _as_bool(
            _config_value(config, "use_grok_rescue", True), True
        )
        bot_enabled = False

    return GrokSearchSettings(
        enabled=enabled,
        mode=mode,
        explicit_mode=explicit_mode,
        mode_valid=mode_valid,
        api_enabled=api_enabled,
        build_enabled=build_enabled,
        bot_enabled=bot_enabled,
        legacy=not explicit_mode,
    )


def _safe_reason(value: Any, fallback: str) -> str:
    """probe理由を秘密抜きの短い固定語へ制限する。"""

    text = str(value or "").strip()
    if not text:
        return fallback
    # path/token/query等を含むプロバイダ診断は返さない。
    lowered = text.lower()
    if any(marker in lowered for marker in ("token", "secret", "password", "cookie", "api_key", "authorization")):
        return fallback
    return text[:240]


def _api_probe() -> dict[str, Any]:
    configured = bool(str(os.getenv("XAI_API_KEY", "") or "").strip())
    return {
        "available": configured,
        "authenticated": configured,
        "auth_status": "configured" if configured else "missing",
        "reason": None if configured else "XAI_API_KEYが未設定です",
    }


def _build_probe() -> dict[str, Any]:
    # Import lazily so settings-only callers do not initialize subprocess code.
    installed = False
    try:
        from .grok_build import resolve_grok_bin
        from .grok_build_x_search import check_available

        resolve_grok_bin()
        installed = True
        available, reason = check_available()
    except Exception as exc:  # noqa: BLE001 - probe must be non-fatal
        available, reason = False, f"{getattr(exc, 'code', '') or type(exc).__name__}"
    return {
        "available": bool(available),
        "installed": installed,
        "authenticated": bool(available),
        "auth_status": "authenticated" if available else "unavailable",
        "reason": None if available else _safe_reason(reason, "Grok Buildを利用できません"),
    }


def _bot_section(config: Any) -> Any:
    section = _config_value(config, "grok_bot_chat", None)
    return section if isinstance(section, Mapping) else None


def _bot_root(config: Any) -> Optional[Path]:
    configured = _config_value(config, "grok_bot_root", None) or os.getenv("AOITALK_ROOT", "")
    if configured:
        return Path(str(configured)).expanduser()
    # The two sibling repositories are the supported local layout.
    candidate = Path(__file__).resolve().parents[2].parent / "41_AoiTalk"
    return candidate


def _bot_probe(config: Any) -> dict[str, Any]:
    section = _bot_section(config)
    if section is None:
        return {
            "available": False,
            "dependencies": False,
            "authenticated": False,
            "auth_status": "unconfigured",
            "reason": "grok_bot_chat設定が未設定です",
        }
    if section.get("enabled") is not True:
        return {
            "available": False,
            "dependencies": False,
            "authenticated": False,
            "auth_status": "disabled",
            "reason": "grok_bot_chat.enabledがtrueではありません",
        }
    target = section.get("target_identity")
    owners = section.get("owners")
    if not isinstance(target, str) or not target.strip():
        return {
            "available": False,
            "dependencies": False,
            "authenticated": False,
            "auth_status": "unconfigured",
            "reason": "Botのtarget_identityが未設定です",
        }
    if not isinstance(owners, Mapping) or not owners:
        return {
            "available": False,
            "dependencies": False,
            "authenticated": False,
            "auth_status": "unconfigured",
            "reason": "Botのowners bindingが未設定です",
        }

    root = _bot_root(config)
    required = (
        root / "src" / "llm" / "grok_bot_client.py",
        root / "src" / "services" / "grok_bot_chat_service.py",
    ) if root is not None else ()
    dependencies = bool(required) and all(path.is_file() for path in required)
    if not dependencies:
        return {
            "available": False,
            "dependencies": False,
            "authenticated": False,
            "auth_status": "dependency_missing",
            "reason": "AoiTalkのGrok Bot依存コードを利用できません",
        }

    # AoiTalkの正本と同じdesktop-status.jsonを読み取り専用で確認する。
    # sand-secrets.jsonは存在確認だけに留め、秘密値は開かない。
    profile_root = Path(os.getenv("APPDATA", "")) / "Grok Bot"
    status_path = profile_root / "desktop-status.json"
    secrets_path = profile_root / "sand-secrets.json"
    signed_in = False
    if status_path.is_file():
        try:
            with status_path.open("rb") as stream:
                raw_bytes = stream.read(2 * 1024 * 1024 + 1)
            if len(raw_bytes) > 2 * 1024 * 1024:
                raise ValueError("profile too large")
            status = json.loads(raw_bytes.decode("utf-8"))
            signed_in = isinstance(status, Mapping) and status.get("signedIn") is True
        except (OSError, ValueError, TypeError):
            signed_in = False
    auth_status = "authenticated" if signed_in and secrets_path.is_file() else "unknown"
    # これは送信前のローカルprobeなので、実際のgateway認証成功とは区別する。
    authenticated = auth_status == "authenticated"
    return {
        "available": authenticated,
        "dependencies": True,
        "authenticated": authenticated,
        "auth_status": auth_status,
        "reason": None if authenticated else "Bot認証は送信前probeでは確定できません",
    }


def check_grok_search_availability(
    mode: Any = None,
    config: Any = None,
    *,
    build_probe: Optional[Callable[[], dict[str, Any]]] = None,
    bot_probe: Optional[Callable[[Any], dict[str, Any]]] = None,
) -> dict[str, Any]:
    """選択方式または全方式の無送信利用可否を返す。

    戻り値はbridgeでそのままJSON化できる辞書で、各理由は秘密値を含めない。
    ``mode`` を省略すると全方式、指定すると選択方式のみをprobeする。
    """

    # 便宜上 ``check_grok_search_availability(config)`` も受け付ける。
    if config is None and isinstance(mode, Mapping):
        config, mode = mode, None
    settings = resolve_grok_search_settings(config or {})
    selected = normalize_grok_search_mode(mode) if mode is not None else None
    if mode is not None and selected is None:
        return {
            "mode": None,
            "available": False,
            "reason": "grok_search_modeがapi/build/botのいずれでもありません",
            "settings": settings.as_dict(),
        }

    probes: dict[str, dict[str, Any]] = {}
    requested = (selected,) if selected else GROK_SEARCH_MODES
    for item in requested:
        if item == "api":
            probes[item] = _api_probe()
        elif item == "build":
            probes[item] = build_probe() if build_probe is not None else _build_probe()
        else:
            probes[item] = bot_probe(config) if bot_probe is not None else _bot_probe(config)

    result: dict[str, Any] = {
        "mode": selected,
        "available": all(bool(probes[item].get("available")) for item in requested),
        "reason": None,
        "settings": settings.as_dict(),
        "modes": probes,
    }
    if not result["available"]:
        result["reason"] = next(
            (
                str(probes[item].get("reason"))
                for item in requested
                if probes[item].get("reason")
            ),
            "Grok検索方式を利用できません",
        )
    if selected:
        result.update(probes[selected])
    return result


__all__ = [
    "DEFAULT_GROK_SEARCH_MODE",
    "GROK_SEARCH_MODES",
    "GrokSearchSettings",
    "check_grok_search_availability",
    "normalize_grok_search_mode",
    "resolve_grok_search_settings",
]
