from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import importlib.util

_config_path = Path(__file__).resolve().parents[1] / "src" / "space_locator" / "ocr_config.py"
_config_spec = importlib.util.spec_from_file_location("unlimited_ocr_setup_config", _config_path)
if _config_spec is None or _config_spec.loader is None:
    raise RuntimeError(f"OCR設定を読み込めません: {_config_path}")
_config_module = importlib.util.module_from_spec(_config_spec)
sys.modules["unlimited_ocr_setup_config"] = _config_module
_config_spec.loader.exec_module(_config_module)
UnlimitedOCRConfig = _config_module.UnlimitedOCRConfig
model_requires_cuda = _config_module.model_requires_cuda
DEFAULT_MODEL_CPU_UNSUPPORTED_REASON = _config_module.DEFAULT_MODEL_CPU_UNSUPPORTED_REASON


ROOT_DIR = Path(__file__).resolve().parents[1]
VENV_DIR = Path(os.environ.get("UNLIMITED_OCR_VENV", ROOT_DIR / "temp" / "unlimited_ocr_venv"))
PYTORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu130"
PYTORCH_REQUIREMENTS = ["torch==2.10.0+cu130", "torchvision==0.25.0+cu130"]
TRANSFORMERS_REQUIREMENTS = [
    "transformers==4.57.1",
    "Pillow==12.1.1",
    "matplotlib==3.10.8",
    "einops==0.8.2",
    "addict==2.4.0",
    "easydict==1.13",
    "psutil==7.2.2",
]


def _local_model_artifacts(path: Path) -> tuple[bool, list[str]]:
    """ローカルsnapshotが実ロード可能な最低限のファイルを持つか確認する。"""
    if not path.exists() or not path.is_dir():
        return False, ["ディレクトリがありません"]
    missing: list[str] = []
    config_path = path / "config.json"
    if not config_path.is_file() or config_path.stat().st_size == 0:
        missing.append("config.json")
    else:
        try:
            if not isinstance(json.loads(config_path.read_text(encoding="utf-8")), dict):
                missing.append("config.json(object)")
        except (OSError, ValueError, UnicodeError):
            missing.append("config.json(valid JSON)")
    weight_patterns = ("*.safetensors", "*.bin", "*.pt", "*.pth")
    if not any(
        candidate.is_file() and candidate.stat().st_size > 0
        for pattern in weight_patterns
        for candidate in path.glob(pattern)
    ):
        missing.append("weights (*.safetensors/*.bin/*.pt/*.pth)")
    tokenizer_or_processor = (
        "tokenizer.json", "tokenizer_config.json", "tokenizer.model", "spiece.model",
        "preprocessor_config.json", "processor_config.json",
    )
    if not any((path / name).is_file() and (path / name).stat().st_size > 0 for name in tokenizer_or_processor):
        missing.append("tokenizer/processor config")
    return not missing, missing


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("> " + " ".join(command))
    return subprocess.run(command, cwd=ROOT_DIR, check=check, text=True)


def venv_python() -> Path:
    exe = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not exe.exists():
        raise FileNotFoundError(f"仮想環境がありません: {exe}")
    return exe


def _python_launcher() -> str:
    configured = os.environ.get("UNLIMITED_OCR_PYTHON", "").strip().strip('"')
    if configured:
        return configured
    uv = shutil.which("uv")
    if uv:
        return uv
    py = shutil.which("py")
    if py:
        return py
    if sys.version_info >= (3, 12):
        return sys.executable
    return shutil.which("python3") or shutil.which("python") or ""


def create_venv() -> None:
    VENV_DIR.parent.mkdir(parents=True, exist_ok=True)
    if VENV_DIR.exists():
        print(f"既存の仮想環境を使います: {VENV_DIR}")
        return

    launcher = _python_launcher()
    if not launcher:
        raise RuntimeError("Python 3.12 または uv/py ランチャーが見つかりません。")
    if Path(launcher).name.lower() == "uv.exe" or Path(launcher).name.lower() == "uv":
        run([launcher, "venv", "--python", "3.12", str(VENV_DIR)])
        return
    if Path(launcher).name.lower() in {"py.exe", "py"}:
        run([launcher, "-3.12", "-m", "venv", str(VENV_DIR)])
        return
    run([launcher, "-m", "venv", str(VENV_DIR)])


def install_requirements() -> None:
    python = str(venv_python())
    uv = shutil.which("uv")
    torch_index = os.environ.get("UNLIMITED_OCR_TORCH_INDEX", PYTORCH_CUDA_INDEX)
    if uv:
        command = [uv, "pip", "install", "--python", python, "--extra-index-url", torch_index]
        run(command + [*PYTORCH_REQUIREMENTS, *TRANSFORMERS_REQUIREMENTS])
        return

    run([python, "-m", "pip", "install", "--upgrade", "pip"])
    command = [python, "-m", "pip", "install", "--extra-index-url", torch_index]
    run(command + [*PYTORCH_REQUIREMENTS, *TRANSFORMERS_REQUIREMENTS])


def doctor() -> int:
    config = UnlimitedOCRConfig.from_env()
    # HF_HOME は Hub の親ディレクトリ、HF_HUB_CACHE は hub snapshot の
    # 直接指定。配布先のカスタムキャッシュでも同じ判定を行う。
    configured_hub_cache = os.environ.get("HF_HUB_CACHE", "").strip()
    hf_home = Path(config.hf_home or os.environ.get("HF_HOME", ROOT_DIR / "temp" / "hf_cache"))
    hub_cache = Path(configured_hub_cache).expanduser() if configured_hub_cache else hf_home / "hub"
    model_name = config.model.replace("/", "--")
    model_cache = hub_cache / f"models--{model_name}"
    local_model = Path(config.model_path).expanduser() if config.model_path else None
    print(f"root: {ROOT_DIR}")
    print(f"venv: {VENV_DIR}")
    print(f"HF_HOME: {hf_home}")
    print(f"HF_HUB_CACHE: {hub_cache}")
    print(f"model: {local_model or config.model}")
    print(f"model_cache: {'あり' if model_cache.exists() else 'なし'} ({model_cache})")
    issues: list[str] = []
    if local_model:
        print(f"model_path: {'あり' if local_model.exists() else 'なし'} ({local_model})")
        if not local_model.exists():
            issues.append(f"指定モデルパスがありません: {local_model}")
        else:
            ready, missing = _local_model_artifacts(local_model)
            if not ready:
                issues.append(
                    f"指定モデルパスに実ロード用ファイルが不足しています: {local_model} "
                    f"({', '.join(missing)})"
                )
    elif not model_cache.exists():
        issues.append(f"モデルキャッシュがありません: {model_cache}")
    else:
        snapshot = model_cache / "snapshots" / config.revision
        if not snapshot.is_dir():
            issues.append(f"指定revisionのモデルsnapshotがありません: {snapshot}")
        else:
            ready, missing = _local_model_artifacts(snapshot)
            if not ready:
                issues.append(
                    f"モデルsnapshotに実ロード用ファイルが不足しています: {snapshot} "
                    f"({', '.join(missing)})"
                )
    print(f"uv: {shutil.which('uv') or 'なし'}")
    print(f"py: {shutil.which('py') or 'なし'}")
    print(f"nvidia-smi: {shutil.which('nvidia-smi') or 'なし'}")

    if shutil.which("nvidia-smi"):
        run(["nvidia-smi"], check=False)

    exe = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not exe.exists():
        print("仮想環境は未作成です。scripts\\setup_unlimited_ocr.bat を実行してください。")
        return 1

    check_code = (
        "import sys; print(sys.version); "
        "import torch; print('torch', torch.__version__); "
        "print('torch_cuda', torch.version.cuda); "
        "print('cuda_available', torch.cuda.is_available()); "
        "print('device_count', torch.cuda.device_count());"
    )
    result = subprocess.run(
        [str(venv_python()), "-c", check_code],
        cwd=ROOT_DIR,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    cuda_available = False
    if result.returncode == 0:
        probe_lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        cuda_available = any(
            (line.lower().startswith("cuda_available") and line.split()[-1].lower() == "true")
            or line.lower() == "true"
            for line in probe_lines
        )
        if cuda_available:
            print(f"--device {config.device}: CUDA利用可能です。")
    elif result.returncode != 0:
        issues.append("専用venvのtorch診断に失敗しました")
    if config.device == "cuda" and not cuda_available:
        issues.append("UNLIMITED_OCR_DEVICE=cuda ですが CUDA が利用できません（fail-closed）")
    requires_cuda = model_requires_cuda(
        model=config.model,
        revision=config.revision,
        model_path=config.model_path,
    )
    if requires_cuda and config.device == "cpu":
        issues.append("device=cpu: " + DEFAULT_MODEL_CPU_UNSUPPORTED_REASON + "（fail-closed）")
    elif requires_cuda and config.device == "auto" and not cuda_available:
        issues.append("device=auto でCUDAを検出できません: " + DEFAULT_MODEL_CPU_UNSUPPORTED_REASON + "（fail-closed）")
    if issues:
        print("doctor: NG")
        for issue in issues:
            print(f"  - {issue}")
        return 2
    return result.returncode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Unlimited OCR 用の専用 Python 3.12 仮想環境を作ります。"
    )
    parser.add_argument("--doctor", action="store_true", help="状態確認だけ行います。")
    parser.add_argument("--no-install", action="store_true", help="仮想環境の作成だけ行います。")
    parser.add_argument("--hf-home", help="モデルキャッシュ先（HF_HOME）")
    parser.add_argument("--model", help="HubモデルID（UNLIMITED_OCR_MODEL）")
    parser.add_argument("--model-path", help="ローカルモデルディレクトリ（UNLIMITED_OCR_MODEL_PATH）")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), help="実行デバイス")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.hf_home:
        os.environ["HF_HOME"] = args.hf_home
        # 明示GUI/CLI設定を親プロセスの stale HF_HUB_CACHE より優先する。
        os.environ["HF_HUB_CACHE"] = str(Path(args.hf_home).expanduser() / "hub")
        for alias in ("TRANSFORMERS_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_DATASETS_CACHE", "HF_MODULES_CACHE"):
            os.environ.pop(alias, None)
    if args.model:
        os.environ["UNLIMITED_OCR_MODEL"] = args.model
    if args.model_path:
        os.environ["UNLIMITED_OCR_MODEL_PATH"] = args.model_path
    if args.device:
        os.environ["UNLIMITED_OCR_DEVICE"] = args.device
    if args.doctor:
        return doctor()

    create_venv()
    if args.no_install:
        print(f"仮想環境の作成だけ完了しました: {VENV_DIR}")
        return 0

    install_requirements()
    return doctor()


if __name__ == "__main__":
    raise SystemExit(main())
