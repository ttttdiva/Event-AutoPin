from __future__ import annotations

from src.space_locator.ocr_config import (
    DEFAULT_MODEL,
    DEFAULT_MAX_LENGTH,
    MAX_MAX_LENGTH,
    DEFAULT_REVISION,
    UnlimitedOCRConfig,
    model_requires_cuda,
)


def _load_setup_module():
    import importlib.util
    from pathlib import Path
    script = Path(__file__).resolve().parents[2] / "scripts" / "setup_unlimited_ocr.py"
    spec = importlib.util.spec_from_file_location("setup_unlimited_ocr_test", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_config_defaults_are_stable_and_small_digit_strategy_is_enabled():
    config = UnlimitedOCRConfig.from_env({})
    assert config.model == DEFAULT_MODEL
    assert config.revision == DEFAULT_REVISION
    assert config.strategy == "small_digits"
    assert config.mode == "gundam"
    assert config.max_length == DEFAULT_MAX_LENGTH
    assert model_requires_cuda(config.model, config.revision) is True


def test_cuda_requirement_detects_local_remote_code_without_blocking_other_models(tmp_path):
    cuda_model = tmp_path / "cuda-model"
    cuda_model.mkdir()
    (cuda_model / "modeling_unlimitedocr.py").write_text(
        'x.cuda(); torch.autocast("cuda")', encoding="utf-8"
    )

    assert model_requires_cuda(model_path=str(cuda_model)) is True
    assert model_requires_cuda("org/cpu-compatible", "main") is False


def test_config_accepts_gui_camel_case_and_preserves_empty_defaults():
    base = UnlimitedOCRConfig(model="custom/model", device="cpu")
    config = UnlimitedOCRConfig.from_mapping(
        {
            "modelPath": " <model-directory>/ocr ",
            "hfHome": "<hf-cache>",
            "ocrStrategy": "gundam_then_base",
            "ocrMode": "base",
            "ocrDevice": "cuda",
            "model": "",
        },
        base=base,
    )
    assert config.model == "custom/model"
    assert config.model_path == "<model-directory>/ocr"
    assert config.hf_home == "<hf-cache>"
    assert config.strategy == "gundam_then_base"
    assert config.mode == "base"
    assert config.device == "cuda"


def test_config_env_values_are_normalized():
    config = UnlimitedOCRConfig.from_env(
        {
            "UNLIMITED_OCR_MODEL": "local/model",
            "UNLIMITED_OCR_VENV": "<ocr-venv>",
            "UNLIMITED_OCR_TIMEOUT_SEC": "120",
            "UNLIMITED_OCR_NO_REPEAT_NGRAM_SIZE": "0",
        }
    )
    assert config.model == "local/model"
    assert config.venv_path == "<ocr-venv>"
    assert config.timeout_sec == 120
    assert config.no_repeat_ngram_size == 0


def test_config_rejects_unknown_runtime_choices():
    config = UnlimitedOCRConfig.from_mapping(
        {"device": "gpu-that-does-not-exist", "mode": "detail", "strategy": "unsupported"}
    )
    assert config.device == "auto"
    assert config.mode == "gundam"
    assert config.strategy == "small_digits"


def test_config_accepts_desktop_config_field_names():
    config = UnlimitedOCRConfig.from_mapping(
        {"unlimitedOcrModel": "org/model", "unlimitedOcrStrategy": "single"}
    )
    assert config.model == "org/model"
    assert config.strategy == "single"


def test_config_caps_unlimited_generation_length():
    config = UnlimitedOCRConfig.from_mapping({"max_length": MAX_MAX_LENGTH + 1000})
    assert config.max_length == MAX_MAX_LENGTH


def test_gui_empty_values_clear_stale_environment_overrides():
    base = UnlimitedOCRConfig(
        model="stale/model",
        model_path="stale-model-dir",
        venv_path="stale-venv-dir",
        hf_home="stale-hf-dir",
        revision="stale-revision",
        device="cuda",
    )
    config = UnlimitedOCRConfig.from_mapping(
        {
            "model": "",
            "model_path": "",
            "venv_path": "",
            "hf_home": "",
            "revision": "",
            "device": "",
        },
        base=base,
        empty_overrides=True,
    )
    assert config.model == DEFAULT_MODEL
    assert config.model_path is None
    assert config.venv_path is None
    assert config.hf_home is None
    assert config.revision == DEFAULT_REVISION
    assert config.device == "auto"


def test_setup_local_model_artifacts_requires_config_weight_and_tokenizer(tmp_path):
    setup = _load_setup_module()
    ready, missing = setup._local_model_artifacts(tmp_path)
    assert ready is False
    assert {"config.json", "weights (*.safetensors/*.bin/*.pt/*.pth)", "tokenizer/processor config"} == set(missing)
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "model.safetensors").write_bytes(b"x")
    (tmp_path / "tokenizer.json").write_text("{}", encoding="utf-8")
    ready, missing = setup._local_model_artifacts(tmp_path)
    assert ready is True
    assert missing == []
