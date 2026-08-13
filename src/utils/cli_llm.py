"""
CLI LLM ユーティリティ
subprocess で Antigravity CLI / Claude Code / Codex CLI を呼び出す

別projectの `<project-root>/src/llm/cli_backends` のパターンを参考に
画像分析に特化した軽量版として実装
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

_MAX_ARG_LENGTH = 8000
_ANTIGRAVITY_MAX_ARG_LENGTH = 24000


def _resolve_cli_bin(command: str) -> str:
    return shutil.which(command) or command


def _truthy_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_antigravity_bin() -> str:
    configured = (
        os.getenv("AGY_BIN")
        or os.getenv("ANTIGRAVITY_BIN")
        or os.getenv("ANTIGRAVITY_CLI_BIN")
    )
    if configured:
        return configured

    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        candidate = Path(local_app_data) / "agy" / "bin" / "agy.exe"
        if candidate.exists():
            return str(candidate)

    return _resolve_cli_bin("agy")


def _build_command(
    provider: str,
    prompt: str,
    model: Optional[str] = None,
    output_path: Optional[str] = None,
    effort: Optional[str] = None,
    force_prompt_flag: bool = False,
    auto_approve: Optional[bool] = None,
) -> List[str]:
    """プロバイダごとのCLIコマンドを構築"""
    if provider == "antigravity":
        cmd = [_resolve_antigravity_bin()]
        agy_auto_approve = (
            _truthy_env("AGY_AUTO_APPROVE", True)
            if auto_approve is None
            else auto_approve
        )
        if agy_auto_approve:
            cmd.append("--dangerously-skip-permissions")
        if _truthy_env("AGY_SANDBOX", False):
            cmd.append("--sandbox")
        effective_model = model or os.getenv("AGY_MODEL")
        if effective_model and effective_model.lower() != "default":
            cmd.extend(["--model", effective_model])
        log_file = os.getenv("AGY_LOG_FILE")
        if log_file:
            cmd.extend(["--log-file", log_file])
        print_timeout = os.getenv("AGY_PRINT_TIMEOUT")
        if print_timeout:
            cmd.extend(["--print-timeout", print_timeout.strip()])
        if prompt or force_prompt_flag:
            cmd.extend(["-p", prompt])
        return cmd

    if provider == "claude":
        bin_path = _resolve_cli_bin(os.getenv("CLAUDE_BIN", "claude"))
        cmd = [bin_path]
        if prompt or force_prompt_flag:
            cmd.extend(["-p", prompt])
        cmd.extend(["--output-format", "json"])
        effective_model = model or os.getenv("CLAUDE_MODEL")
        if effective_model:
            cmd.extend(["--model", effective_model])
        if effort and effort not in ("none", "auto"):
            cmd.extend(["--effort", effort])
        cmd.extend(["--max-turns", os.getenv("CLAUDE_MAX_TURNS", "2")])
        return cmd

    if provider == "codex":
        bin_path = _resolve_cli_bin(os.getenv("CODEX_BIN", "codex"))
        cmd = [bin_path, "exec"]
        effective_model = model or os.getenv("CODEX_MODEL")
        if effective_model:
            cmd.extend(["--model", effective_model])
        if effort and effort != "none":
            cmd.extend(["-c", f'model_reasoning_effort="{effort}"'])

        sandbox = os.getenv("CODEX_SANDBOX", "read-only")
        if sandbox:
            cmd.extend(["--sandbox", sandbox])
        if os.getenv("CODEX_EPHEMERAL", "true").lower() == "true":
            cmd.append("--ephemeral")
        if output_path:
            cmd.extend(["--output-last-message", output_path])
        if os.getenv("CODEX_AUTO_APPROVE", "false").lower() == "true":
            cmd.append("--full-auto")
        if prompt:
            cmd.append(prompt)
        return cmd

    raise ValueError(f"未知のプロバイダ: {provider}")


def _parse_output(provider: str, raw_output: str) -> str:
    """プロバイダごとの出力パース"""
    output = raw_output.strip()

    if provider == "claude":
        try:
            data = json.loads(output)
            if isinstance(data, dict) and "result" in data:
                return data["result"]
        except (json.JSONDecodeError, TypeError):
            pass
        return output

    if provider == "antigravity":
        return output

    return output


def execute_cli_prompt(
    prompt: str,
    provider: str = "antigravity",
    cwd: Optional[str] = None,
    timeout: int = 900,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    auto_approve: Optional[bool] = None,
) -> Tuple[bool, str]:
    """CLI LLMにプロンプトを実行し、可能な限りモデル応答だけを返す。"""
    use_stdin = provider == "codex" or (
        provider != "antigravity" and len(prompt) > _MAX_ARG_LENGTH
    )
    output_file = None
    prompt_file = None

    if provider == "codex":
        output_file = tempfile.NamedTemporaryFile(
            mode="w+", encoding="utf-8", suffix=".txt", delete=False
        )
        output_file.close()

    if provider == "antigravity" and len(prompt) > _ANTIGRAVITY_MAX_ARG_LENGTH:
        tmp_dir = Path(cwd) / "cache" / "tmp" if cwd else Path(tempfile.gettempdir())
        tmp_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".txt",
            prefix="event-autopin-agy-prompt-",
            delete=False,
            dir=str(tmp_dir),
        )
        prompt_file.write(prompt)
        prompt_file.close()
        prompt = (
            "Read the full Event AutoPin prompt from this UTF-8 file and "
            f"answer it: {prompt_file.name}"
        )

    try:
        output_path = output_file.name if output_file else None
        cmd_prompt = "" if use_stdin else prompt
        force_prompt_flag = False
        if use_stdin and provider == "claude":
            cmd_prompt = " "
            force_prompt_flag = True
        cmd = _build_command(
            provider,
            cmd_prompt,
            model=model,
            output_path=output_path,
            effort=effort,
            force_prompt_flag=force_prompt_flag,
            auto_approve=auto_approve,
        )

        if use_stdin:
            logger.info(f"[{provider}] プロンプトが長い ({len(prompt)} chars)、stdinを使用")
        logger.info(f"[{provider}] 実行: {cmd[0]}")
        logger.debug(f"[{provider}] プロンプト長: {len(prompt)} chars")

        max_retries = 3
        retry_delay = 1.0

        for attempt in range(max_retries):
            try:
                result = subprocess.run(
                    cmd,
                    input=prompt if use_stdin else None,
                    cwd=cwd,
                    text=True,
                    capture_output=True,
                    check=False,
                    encoding="utf-8",
                    timeout=timeout,
                )

                if result.returncode == 0:
                    raw_output = result.stdout
                    if output_path:
                        try:
                            file_output = Path(output_path).read_text(encoding="utf-8")
                            if file_output.strip():
                                raw_output = file_output
                        except OSError as e:
                            logger.warning(f"[{provider}] 出力ファイルの読み取りに失敗: {e}")
                    output = _parse_output(provider, raw_output)
                    logger.info(f"[{provider}] 実行成功: {len(output)} chars")
                    return True, output

                stderr = result.stderr.strip()
                logger.warning(
                    f"[{provider}] 試行 {attempt + 1}/{max_retries} 失敗 "
                    f"(exit code {result.returncode})"
                )

                is_transient = any(
                    err in stderr
                    for err in ["ECONNRESET", "ETIMEDOUT", "Connection refused"]
                )
                if is_transient and attempt < max_retries - 1:
                    logger.info(f"[{provider}] 一時エラーのためリトライ... ({retry_delay}s)")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                    continue

                error_msg = f"CLI失敗 (exit code {result.returncode})"
                if stderr:
                    error_msg += f"\nSTDERR: {stderr}"
                return False, error_msg

            except FileNotFoundError:
                logger.error(f"[{provider}] CLIが見つかりません: {cmd[0]}")
                return False, f"CLI not found: {cmd[0]}"
            except subprocess.TimeoutExpired:
                logger.error(f"[{provider}] タイムアウト ({timeout}s)")
                return False, f"Timeout ({timeout}s)"
            except Exception as e:
                logger.error(f"[{provider}] 予期しないエラー: {e}")
                return False, str(e)

        return False, "最大リトライ回数超過"
    finally:
        if output_file:
            try:
                Path(output_file.name).unlink(missing_ok=True)
            except OSError:
                pass
        if prompt_file:
            try:
                Path(prompt_file.name).unlink(missing_ok=True)
            except OSError:
                pass


def analyze_image_cli(
    image_path: str,
    prompt: str,
    providers: Optional[List[str]] = None,
    cli_model_map: Optional[dict] = None,
    cli_effort_map: Optional[dict] = None,
    timeout: int = 900,
) -> str:
    """CLI LLMで画像を解析する。Antigravity CLIには作業ディレクトリ内の画像パスを渡す。"""
    providers = providers or ["antigravity", "claude"]
    cli_model_map = cli_model_map or {}
    cli_effort_map = cli_effort_map or {}
    image_file = Path(image_path).resolve()
    temp_workspace = None
    cli_image_file = image_file

    if "antigravity" in providers:
        temp_workspace = tempfile.TemporaryDirectory(prefix="antigravity-image-")
        suffix = image_file.suffix or ".jpg"
        cli_image_file = Path(temp_workspace.name) / f"image{suffix}"
        shutil.copy2(image_file, cli_image_file)

    cli_image_prompt = (
        "この画像だけを読んで、頒布物をJSON配列だけで返してください。"
        "形式: [{\"name\":string,\"type\":string,\"price\":number|null}]。"
        "Markdownや説明は禁止。"
    )
    full_prompt = (
        f"{prompt}\n\n"
        f"Attached image file: {cli_image_file.name}\n"
        f"{cli_image_prompt}"
    )

    for provider in providers:
        logger.info(f"[{provider}] 画像解析: {image_file.name}")
        provider_cwd = (
            temp_workspace.name
            if provider == "antigravity" and temp_workspace
            else None
        )
        success, output = execute_cli_prompt(
            full_prompt,
            provider=provider,
            cwd=provider_cwd,
            timeout=timeout,
            model=cli_model_map.get(provider),
            effort=cli_effort_map.get(provider),
        )
        if success and output:
            if temp_workspace:
                temp_workspace.cleanup()
            return output
        logger.warning(f"[{provider}] 画像解析失敗。次のプロバイダを試行")

    if temp_workspace:
        temp_workspace.cleanup()
    logger.error("すべてのCLI LLMプロバイダで画像解析に失敗")
    return ""
