"""Unlimited OCR の実行設定。

OCR は本体 venv と専用 venv をまたいで起動されるため、設定を環境変数・
デスクトップ設定・CLI のいずれからでも同じ形式に正規化する。このモジュールは
stdlib のみで動作し、OCR 専用 venv からも安全に import できる。
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Optional


DEFAULT_MODEL = "baidu/Unlimited-OCR"
DEFAULT_REVISION = "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead"
DEFAULT_MODE = "gundam"
DEFAULT_STRATEGY = "small_digits"
DEFAULT_MODEL_CPU_UNSUPPORTED_REASON = (
    "baidu/Unlimited-OCR の固定revisionはremote model codeがCUDAを直接要求するためCPU実行できません"
)
DEFAULT_TIMEOUT_SEC = 900
# 32768 はモデルの最大コンテキスト長としては有効だが、地図の小さい番号を
# 抽出する用途では推論が不必要に長くなり、配布先GPUでタイムアウトしやすい。
# 既定値は実マップの待ち時間を抑える 4k とし、明示設定時のみ最大 32k まで許可する。
DEFAULT_MAX_LENGTH = 4096
MAX_MAX_LENGTH = 32768
_DEVICES = {"auto", "cuda", "cpu"}
_MODES = {"gundam", "base"}
_STRATEGIES = {"small_digits", "gundam_then_base", "balanced", "single"}


def model_requires_cuda(
    model: str = DEFAULT_MODEL,
    revision: str = DEFAULT_REVISION,
    model_path: str | None = None,
) -> bool:
    """既知のCUDA専用remote codeかをfail-closed判定する。

    固定Hub revisionは ``Tensor.cuda()`` とCUDA autocastを直接使う。
    ローカルpathは同梱remote codeを検査し、別実装のモデルまで一律に
    CUDA専用扱いしない。
    """
    if model_path:
        source = Path(model_path).expanduser() / "modeling_unlimitedocr.py"
        try:
            code = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return False
        return ".cuda(" in code and "autocast(\"cuda\"" in code
    return _clean(model) == DEFAULT_MODEL and _clean(revision) == DEFAULT_REVISION


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _optional_path(value: Any) -> Optional[str]:
    text = _clean(value)
    return text or None


@dataclass(frozen=True)
class UnlimitedOCRConfig:
    """Runner に渡す設定。

    ``model_path`` はローカル snapshot / モデルディレクトリを優先する。
    未指定時は ``model``（Hub ID）を使用する。HF_HOME は空欄なら runner の
    リポジトリ内既定値に任せる。
    """

    model: str = DEFAULT_MODEL
    model_path: Optional[str] = None
    venv_path: Optional[str] = None
    hf_home: Optional[str] = None
    revision: str = DEFAULT_REVISION
    device: str = "auto"
    mode: str = DEFAULT_MODE
    strategy: str = DEFAULT_STRATEGY
    prompt: Optional[str] = None
    timeout_sec: int = DEFAULT_TIMEOUT_SEC
    max_length: int = DEFAULT_MAX_LENGTH
    no_repeat_ngram_size: int = 35
    ngram_window: int = 128
    temperature: float = 0.0
    tile_fallback: bool = True
    tile_size: int = 320
    # 320px tileを半分ずつずらす。高解像度マップの番号列がtile境界へ
    # 落ちても、次のcropでは中央付近へ入るようにする。
    tile_overlap: int = 160
    # 全体のcoarse sweepに、上半分中央と右端のdetail ROIを加えても
    # 既定900秒timeout内に収まる実測上限。
    tile_max_count: int = 160

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "UnlimitedOCRConfig":
        env = os.environ if environ is None else environ
        def get(name: str, default: Any = "") -> Any:
            value = env.get(name)
            return default if value is None or not str(value).strip() else value

        def integer(name: str, default: int) -> int:
            try:
                return max(1, int(get(name, default)))
            except (TypeError, ValueError):
                return default

        try:
            temperature = float(get("UNLIMITED_OCR_TEMPERATURE", 0.0))
        except (TypeError, ValueError):
            temperature = 0.0
        device = _clean(get("UNLIMITED_OCR_DEVICE", "auto")).lower() or "auto"
        mode = _clean(get("UNLIMITED_OCR_MODE", DEFAULT_MODE)).lower() or DEFAULT_MODE
        strategy = _clean(get("UNLIMITED_OCR_STRATEGY", DEFAULT_STRATEGY)).lower() or DEFAULT_STRATEGY
        model = _clean(get("UNLIMITED_OCR_MODEL", get("UNLIMITED_OCR_MODEL_NAME", DEFAULT_MODEL)))
        return cls(
            model=model or DEFAULT_MODEL,
            model_path=_optional_path(get("UNLIMITED_OCR_MODEL_PATH", "")),
            venv_path=_optional_path(get("UNLIMITED_OCR_VENV", "")),
            hf_home=_optional_path(
                get("HF_HOME", get("UNLIMITED_OCR_HF_HOME", get("UNLIMITED_OCR_HF_CACHE", "")))
            ),
            revision=_clean(get("UNLIMITED_OCR_REVISION", DEFAULT_REVISION)),
            device=device if device in _DEVICES else "auto",
            mode=mode if mode in _MODES else DEFAULT_MODE,
            strategy=strategy if strategy in _STRATEGIES else DEFAULT_STRATEGY,
            prompt=_optional_path(get("UNLIMITED_OCR_PROMPT", "")),
            timeout_sec=integer("UNLIMITED_OCR_TIMEOUT_SEC", DEFAULT_TIMEOUT_SEC),
            max_length=min(
                MAX_MAX_LENGTH,
                integer("UNLIMITED_OCR_MAX_LENGTH", DEFAULT_MAX_LENGTH),
            ),
            no_repeat_ngram_size=max(
                0,
                int(get("UNLIMITED_OCR_NO_REPEAT_NGRAM_SIZE", 35))
                if str(get("UNLIMITED_OCR_NO_REPEAT_NGRAM_SIZE", 35)).strip().lstrip("-").isdigit()
                else 35,
            ),
            ngram_window=integer("UNLIMITED_OCR_NGRAM_WINDOW", 128),
            temperature=temperature,
            tile_fallback=_clean(get("UNLIMITED_OCR_TILE_FALLBACK", "1")).lower()
            not in {"0", "false", "no", "off"},
            tile_size=integer("UNLIMITED_OCR_TILE_SIZE", 320),
            tile_overlap=integer("UNLIMITED_OCR_TILE_OVERLAP", 160),
            tile_max_count=integer("UNLIMITED_OCR_TILE_MAX_COUNT", 160),
        )

    @classmethod
    def from_mapping(
        cls,
        value: Optional[Mapping[str, Any]],
        *,
        base: Optional["UnlimitedOCRConfig"] = None,
        empty_overrides: bool = False,
    ) -> "UnlimitedOCRConfig":
        """GUI/bridge payloadを設定へ変換する。

        キーはsnake_caseとcamelCaseの両方を受け付ける。通常は空文字を
        無視するが、GUIの現行フォームのように「明示的に解除」を表す
        payloadでは ``empty_overrides=True`` を指定する。この場合は
        model/revision/device/mode/strategy を安全な既定値へ戻し、
        model_path/venv_path/hf_home/prompt の空欄を ``None`` にして、
        親プロセスに残った stale な環境変数を再利用しない。
        """
        current = base or cls.from_env()
        if not value:
            return current
        data = dict(asdict(current))
        aliases = {
            "modelPath": "model_path",
            "venvPath": "venv_path",
            "hfHome": "hf_home",
            "modelName": "model",
            "modelRevision": "revision",
            "unlimitedOcrModel": "model",
            "unlimitedOcrModelPath": "model_path",
            "unlimitedOcrVenv": "venv_path",
            "unlimitedOcrHfHome": "hf_home",
            "unlimitedOcrRevision": "revision",
            "unlimitedOcrDevice": "device",
            "unlimitedOcrMode": "mode",
            "unlimitedOcrStrategy": "strategy",
            "ocrDevice": "device",
            "ocrMode": "mode",
            "ocrStrategy": "strategy",
            "promptText": "prompt",
            "timeoutSec": "timeout_sec",
            "maxLength": "max_length",
            "noRepeatNgramSize": "no_repeat_ngram_size",
            "ngramWindow": "ngram_window",
        }
        for key, raw in value.items():
            canonical = aliases.get(key, key)
            if canonical not in data or raw is None:
                continue
            if raw == "":
                if empty_overrides:
                    if canonical in {"model_path", "venv_path", "hf_home", "prompt"}:
                        data[canonical] = None
                    elif canonical == "model":
                        data[canonical] = DEFAULT_MODEL
                    elif canonical == "revision":
                        data[canonical] = DEFAULT_REVISION
                    elif canonical == "device":
                        data[canonical] = "auto"
                    elif canonical == "mode":
                        data[canonical] = DEFAULT_MODE
                    elif canonical == "strategy":
                        data[canonical] = DEFAULT_STRATEGY
                continue
            data[canonical] = raw

        for key in ("model", "revision", "device", "mode", "strategy"):
            data[key] = _clean(data[key]) or getattr(current, key)
        if data["device"] not in _DEVICES:
            data["device"] = current.device if current.device in _DEVICES else "auto"
        if data["mode"] not in _MODES:
            data["mode"] = current.mode if current.mode in _MODES else DEFAULT_MODE
        if data["strategy"] not in _STRATEGIES:
            data["strategy"] = current.strategy if current.strategy in _STRATEGIES else DEFAULT_STRATEGY
        for key in ("model_path", "venv_path", "hf_home", "prompt"):
            data[key] = _optional_path(data[key])
        for key in ("timeout_sec", "ngram_window"):
            try:
                data[key] = max(1, int(data[key]))
            except (TypeError, ValueError):
                data[key] = getattr(current, key)
        try:
            data["max_length"] = min(MAX_MAX_LENGTH, max(1, int(data["max_length"])))
        except (TypeError, ValueError):
            data["max_length"] = current.max_length
        try:
            data["no_repeat_ngram_size"] = max(0, int(data["no_repeat_ngram_size"]))
        except (TypeError, ValueError):
            data["no_repeat_ngram_size"] = current.no_repeat_ngram_size
        try:
            data["temperature"] = float(data["temperature"])
        except (TypeError, ValueError):
            data["temperature"] = current.temperature
        data["tile_fallback"] = bool(data.get("tile_fallback", current.tile_fallback))
        for key in ("tile_size", "tile_overlap", "tile_max_count"):
            try:
                data[key] = max(0, int(data[key]))
            except (TypeError, ValueError):
                data[key] = getattr(current, key)
        if data["tile_size"] and data["tile_overlap"] >= data["tile_size"]:
            data["tile_overlap"] = max(0, data["tile_size"] // 4)
        data["tile_max_count"] = max(1, data["tile_max_count"])
        return cls(**data)

    def model_source(self) -> str:
        return str(Path(self.model_path).expanduser()) if self.model_path else self.model

    def to_public_dict(self) -> dict[str, Any]:
        """ログ/UIに返す設定（機密情報を含まない）。"""
        return asdict(self)
