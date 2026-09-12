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
import signal
from pathlib import Path
from typing import List, Optional, Tuple

from .reprocess_deadline import ReprocessDeadlineExceeded

logger = logging.getLogger(__name__)

_MAX_ARG_LENGTH = 8000
_ANTIGRAVITY_MAX_ARG_LENGTH = 24000
_ORIGINAL_SUBPROCESS_RUN = subprocess.run
_ORIGINAL_SUBPROCESS_POPEN = subprocess.Popen
_PROCESS_CLEANUP_TIMEOUT_SECONDS = 5.0


def _terminate_process_tree(proc: subprocess.Popen) -> None:
    """Terminate a timed-out CLI and its descendants, then fall back locally."""

    pid = getattr(proc, "pid", None)
    if pid:
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                    text=True,
                    encoding="utf-8",
                    timeout=_PROCESS_CLEANUP_TIMEOUT_SECONDS,
                )
            else:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (FileNotFoundError, OSError, ValueError, subprocess.SubprocessError) as exc:
            logger.debug("CLI process-tree cleanup failed for pid %s: %s", pid, exc)

    try:
        proc.kill()
    except (OSError, ProcessLookupError, AttributeError):
        pass


def _reap_process(proc: subprocess.Popen) -> None:
    """Drain pipes after termination so a timed-out child cannot keep handles open."""

    try:
        proc.communicate(timeout=_PROCESS_CLEANUP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except (OSError, ProcessLookupError, AttributeError):
            pass
        try:
            proc.communicate(timeout=_PROCESS_CLEANUP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            logger.warning("CLI process pipes did not close during cleanup")
        except (OSError, ValueError, subprocess.SubprocessError):
            pass


def _run_cli_command(
    cmd: List[str],
    *,
    input_data: Optional[str],
    cwd: Optional[str],
    timeout: float,
) -> subprocess.CompletedProcess:
    """Run a CLI with process-tree cleanup while retaining patched-run compatibility."""

    # Existing integrations/tests replace subprocess.run.  Keep that contract
    # intact, while the real subprocess path uses a PID we can terminate.
    if (
        subprocess.run is not _ORIGINAL_SUBPROCESS_RUN
        and subprocess.Popen is _ORIGINAL_SUBPROCESS_POPEN
    ):
        return subprocess.run(
            cmd,
            input=input_data,
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=timeout,
        )

    popen_kwargs = {
        "cwd": cwd,
        "stdin": subprocess.PIPE if input_data is not None else None,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
    }
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if creation_flags:
            popen_kwargs["creationflags"] = creation_flags
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    try:
        stdout, stderr = proc.communicate(input=input_data, timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(proc)
        _reap_process(proc)
        raise
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def _cleanup_antigravity_workspace(workspace_path: Optional[str]) -> None:
    if not workspace_path:
        return
    try:
        shutil.rmtree(workspace_path, ignore_errors=True)
    except RecursionError:
        logger.warning(
            "Antigravity image workspace cleanup hit recursion; ignoring"
        )
    except OSError as exc:
        logger.warning("Antigravity image workspace cleanup failed: %s", exc)


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
            from .antigravity_models import resolve_antigravity_model

            resolved_model = resolve_antigravity_model(effective_model)
            if resolved_model:
                cmd.extend(["--model", resolved_model])
        if effort and str(effort).strip().lower() not in {"", "none", "auto"}:
            normalized_effort = str(effort).strip().lower()
            if normalized_effort in {"low", "medium", "high"}:
                cmd.extend(["--effort", normalized_effort])
        log_file = os.getenv("AGY_LOG_FILE")
        if log_file:
            cmd.extend(["--log-file", log_file])
        print_timeout = os.getenv("AGY_PRINT_TIMEOUT")
        if print_timeout:
            cmd.extend(["--print-timeout", print_timeout.strip()])
        cmd.extend(["--output-format", "json"])
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
        try:
            data = json.loads(output)
        except (json.JSONDecodeError, TypeError):
            return output

        if not isinstance(data, dict):
            return output

        status = str(data.get("status") or "").upper()
        response = str(data.get("response") or "").strip()

        if status and status != "SUCCESS":
            error = str(data.get("error") or "").strip()
            raise RuntimeError(
                f"Antigravity CLI status={status}"
                + (f": {error}" if error else "")
            )

        return response

    return output


def execute_cli_prompt(
    prompt: str,
    provider: str = "antigravity",
    cwd: Optional[str] = None,
    timeout: float = 900,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    auto_approve: Optional[bool] = None,
    raise_on_timeout: bool = False,
    timeout_stage: Optional[str] = None,
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
                result = _run_cli_command(
                    cmd,
                    input_data=prompt if use_stdin else None,
                    cwd=cwd,
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
                    try:
                        output = _parse_output(provider, raw_output)
                    except Exception as exc:
                        stderr = (result.stderr or "").strip()
                        message = str(exc)
                        if stderr:
                            message += f"\nSTDERR: {stderr}"
                        return False, message

                    if not str(output or "").strip():
                        stderr = (result.stderr or "").strip()
                        message = "CLI returned an empty response"
                        if stderr:
                            message += f"\nSTDERR: {stderr}"
                        logger.warning(f"[{provider}] {message}")
                        return False, message

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
                if raise_on_timeout:
                    raise ReprocessDeadlineExceeded(
                        f"CLI timeout ({timeout}s)",
                        stage=timeout_stage,
                    )
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
    timeout: float = 900,
    extra_instructions: Optional[str] = None,
    raise_on_timeout: bool = False,
    timeout_stage: Optional[str] = None,
) -> str:
    """CLI LLMで画像を解析する。Antigravity CLIには作業ディレクトリ内の画像パスを渡す。"""
    providers = providers or ["antigravity", "claude"]
    cli_model_map = cli_model_map or {}
    cli_effort_map = cli_effort_map or {}
    image_file = Path(image_path).resolve()
    workspace_path: Optional[str] = None
    cli_image_file = image_file

    if "antigravity" in providers:
        workspace_path = tempfile.mkdtemp(prefix="antigravity-image-")
        suffix = image_file.suffix or ".jpg"
        cli_image_file = Path(workspace_path) / f"image{suffix}"
        shutil.copy2(image_file, cli_image_file)

    attachment_hint = (
        f"Read this exact image file by its absolute path: {cli_image_file}. "
        "Do not use another file with the same basename or an image from a previous task. "
        "If this file cannot be read, report the error instead of guessing its contents."
    )
    prompt_parts = [
        prompt,
        "",
        f"Attached image file: {cli_image_file}",
        attachment_hint,
    ]
    if extra_instructions:
        prompt_parts.append(str(extra_instructions).strip())
    full_prompt = "\n".join(part for part in prompt_parts if part is not None)

    result = ""
    try:
        for provider in providers:
            logger.info(f"[{provider}] 画像解析: {image_file.name}")
            provider_cwd = (
                workspace_path if provider == "antigravity" and workspace_path else None
            )
            execute_kwargs = {
                "provider": provider,
                "cwd": provider_cwd,
                "timeout": timeout,
                "model": cli_model_map.get(provider),
                "effort": cli_effort_map.get(provider),
                "auto_approve": True if provider == "antigravity" else None,
            }
            if raise_on_timeout:
                execute_kwargs["raise_on_timeout"] = True
                execute_kwargs["timeout_stage"] = timeout_stage
            success, output = execute_cli_prompt(full_prompt, **execute_kwargs)
            if success and output:
                result = output
                break
            logger.warning(f"[{provider}] 画像解析失敗。次のプロバイダを試行")
    finally:
        _cleanup_antigravity_workspace(workspace_path)

    if not result:
        logger.error("すべてのCLI LLMプロバイダで画像解析に失敗")
    return result


def analyze_catalog_image_cli(
    image_path: str,
    prompt: str,
    providers: Optional[List[str]] = None,
    cli_model_map: Optional[dict] = None,
    cli_effort_map: Optional[dict] = None,
    timeout: float = 900,
    raise_on_timeout: bool = False,
    timeout_stage: Optional[str] = None,
) -> str:
    """お品書き画像向け CLI 解析。caller prompt の object schema をそのまま使う。"""
    return analyze_image_cli(
        image_path=image_path,
        prompt=prompt,
        providers=providers,
        cli_model_map=cli_model_map,
        cli_effort_map=cli_effort_map,
        timeout=timeout,
        raise_on_timeout=raise_on_timeout,
        timeout_stage=timeout_stage,
    )
