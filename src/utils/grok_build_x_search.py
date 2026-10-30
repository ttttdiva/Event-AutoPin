"""Grok Build CLI (grok.exe) によるX上のお品書き探索。

twscrapeで拾えなかったサークルを、Grokのweb検索で救済するための薄い層。
xAIの有料API(XAI_API_KEY)は使わない。ログイン済みのGrok Build CLIを
非対話(--prompt-file / --output-format json)で呼ぶ。

重要な前提:
- Grokはweb上の本文テキストを根拠にするだけで、画像の中身は信用しない。
  返ってきたURLは呼び出し側が画像モデルで解析し直す。
- 送信後に結果が確認できない(タイムアウト等)場合は再送しない。
- 未ログイン・exe無し等は GrokBuildError で呼び出し側へ知らせ、本処理は続行させる。
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .grok_build import GrokBuildError, classify_grok_build_failure, resolve_grok_bin

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 12
DEFAULT_TIMEOUT_SECONDS = 900.0
DISABLE_ENV = "EVENT_AUTOPIN_DISABLE_GROK_RESCUE"

_HANDLE_RE = re.compile(r"@([A-Za-z0-9_]{1,15})")
_POST_URL_RE = re.compile(
    r"https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d+)",
    re.IGNORECASE,
)
_EXISTS_RE = re.compile(r"存在\s*[:：]\s*(あり|なし|不明)")
_SUSPENDED_RE = re.compile(r"凍結|suspend|アカウント(?:が)?停止", re.IGNORECASE)
_NOT_FOUND_RE = re.compile(r"お品書き\s*[:：]\s*未発見")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


@dataclass
class GrokFinding:
    """Grokの1アカウント分の回答(信用せず、状態の候補として扱う)。"""

    handle: str
    exists: str = "不明"  # あり / なし / 不明
    suspended: bool = False
    post_url: Optional[str] = None
    post_id: Optional[str] = None
    not_found: bool = False
    note: str = ""
    raw: str = ""


@dataclass
class GrokReply:
    text: str
    model: str = ""
    findings: Dict[str, GrokFinding] = field(default_factory=dict)


def build_prompt(handles: Iterable[str], event_name: str, event_date: datetime) -> str:
    """手作業で実績のあったプロンプト(アカウント一覧付き)。"""
    date_text = f"{event_date.year}年{event_date.month}月{event_date.day}日"
    lines = "\n".join(f"@{h}" for h in handles)
    return (
        f"Xで次のアカウントについて、{date_text}開催の同人イベント（{event_name}）向けの"
        "『お品書き』ポストを探してください。各アカウントについて "
        "(a)アカウントが存在するか (b)今回のイベントのお品書きポストがあればURLと投稿日 "
        "(c)なければ未発見、を正直に。推測・捏造しない。別イベントや古い投稿は含めない。"
        "出力は各アカウント1行: @handle | 存在:あり/なし/不明 | お品書き:URL または 未発見 | 備考\n"
        "アカウントが凍結されている場合は備考に『凍結』と書いてください。\n\n"
        f"{lines}\n"
    )


def _safe_note(text: str, limit: int = 200) -> str:
    return _CONTROL_RE.sub("", text).strip()[:limit]


def parse_reply(text: str, handles: Iterable[str]) -> Dict[str, GrokFinding]:
    """回答から要求したハンドルの行を探してパースする。

    CLIはエージェントの途中経過(前置き)と最終結果を改行なしで連結することがあるため、
    行頭ではなく「@handle |」の出現位置を起点にする。要求していないハンドルは無視する。
    """
    wanted = {h.lower(): h for h in handles}
    if not wanted:
        return {}
    body = str(text or "").replace("｜", "|").replace("`", "")
    names = "|".join(re.escape(h) for h in wanted)
    row_start = re.compile(
        rf"(?<![A-Za-z0-9_])@({names})(?![A-Za-z0-9_])(?:\*\*)?\s*\|", re.IGNORECASE
    )
    starts = [(m.start(), m.group(1).lower()) for m in row_start.finditer(body)]
    findings: Dict[str, GrokFinding] = {}
    for position, (start, key) in enumerate(starts):
        if key in findings:
            continue
        end = starts[position + 1][0] if position + 1 < len(starts) else len(body)
        line = body[start:end].split("\n", 1)[0].replace("**", "").strip()
        handle = wanted[key]
        fields = [part.strip() for part in line.split("|")]
        exists_match = _EXISTS_RE.search(line)
        finding = GrokFinding(
            handle=handle,
            exists=exists_match.group(1) if exists_match else "不明",
            suspended=bool(_SUSPENDED_RE.search(line)),
            raw=_safe_note(line, 400),
        )
        # URLは依頼したハンドル本人のポストだけ採用する(他人のRTや引用は採らない)。
        for url_match in _POST_URL_RE.finditer(line):
            if url_match.group(1).lower() == handle.lower():
                finding.post_id = url_match.group(2)
                finding.post_url = f"https://x.com/{handle}/status/{finding.post_id}"
                break
        finding.not_found = bool(_NOT_FOUND_RE.search(line)) and not finding.post_url
        finding.note = _safe_note(fields[-1] if len(fields) >= 4 else "")
        findings[key] = finding
    return findings


def disabled_by_environment() -> bool:
    return os.environ.get(DISABLE_ENV, "").strip().lower() in {"1", "true", "yes"}


def _kill_tree(proc: "subprocess.Popen[str]") -> None:
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True, timeout=10, check=False,
            )
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def check_available(timeout: float = 30.0) -> Tuple[bool, str]:
    """課金されないコマンド(grok models)で、exeの有無とログイン状態を調べる。"""
    try:
        executable = resolve_grok_bin()
    except GrokBuildError as exc:
        return False, f"grok.exe not found ({exc.code})"
    try:
        completed = subprocess.run(
            [executable, "--no-auto-update", "models"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, stdin=subprocess.DEVNULL, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        return False, "grok models timed out"
    except OSError as exc:
        return False, f"grok.exe could not start ({type(exc).__name__})"
    output = f"{completed.stdout}\n{completed.stderr}"
    if completed.returncode != 0 or re.search(
        r"not (?:authenticated|logged)|unauthenticated|please (?:log|sign) ?in", output, re.IGNORECASE
    ):
        return False, "grok is not logged in"
    return True, ""


def run_headless_prompt(
    prompt: str,
    *,
    model: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_turns: int = 12,
) -> Tuple[str, str]:
    """web検索を有効、ツール(ファイル/シェル)を無効にして1回だけ送る。

    Returns:
        (回答テキスト, 使用モデル名)
    Raises:
        GrokBuildError: unknown_delivery は送信後に確認できなかった(再送禁止)ことを示す。
    """
    executable = resolve_grok_bin()
    with tempfile.TemporaryDirectory(prefix="event-autopin-grok-x-") as work_dir:
        prompt_file = os.path.join(work_dir, "prompt.txt")
        with open(prompt_file, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(prompt)
        command = [
            executable, "--no-auto-update", "--cwd", work_dir,
            "--prompt-file", prompt_file, "--output-format", "json",
            "--tools", "", "--no-subagents", "--no-memory",
            "--max-turns", str(max_turns), "--permission-mode", "dontAsk",
        ]
        if model:
            command.extend(["--model", model])
        popen_kwargs: Dict[str, Any] = {
            "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
            "text": True, "encoding": "utf-8", "errors": "replace", "cwd": work_dir,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            proc = subprocess.Popen(command, **popen_kwargs)
        except OSError as exc:
            raise GrokBuildError("not_installed", type(exc).__name__) from exc
        try:
            stdout, stderr = proc.communicate(timeout=max(1.0, timeout))
        except subprocess.TimeoutExpired as exc:
            _kill_tree(proc)
            # 送信済みで結果が不明。二重送信を避けるため再送しない。
            raise GrokBuildError(
                "unknown_delivery", "prompt was sent; no response before timeout; not resent"
            ) from exc

    if proc.returncode != 0:
        code = classify_grok_build_failure(f"{stderr}\n{stdout}", prompt_sent=False)
        raise GrokBuildError(code, (stderr or stdout)[:300])
    start = stdout.find("{")
    try:
        payload = json.loads(stdout[start:]) if start >= 0 else None
    except json.JSONDecodeError:
        payload = None
    if not isinstance(payload, dict) or not str(payload.get("text") or "").strip():
        raise GrokBuildError("empty_response", "grok returned no text")
    usage = payload.get("modelUsage")
    model_name = next(iter(usage), "") if isinstance(usage, dict) and usage else (model or "")
    return str(payload["text"]), str(model_name)


Runner = Callable[..., Tuple[str, str]]


class GrokBuildXSearch:
    """12件ずつ逐次でGrokへ問い合わせる。runner/availabilityは差し替え可能(テスト用)。"""

    def __init__(
        self,
        *,
        runner: Optional[Runner] = None,
        availability: Optional[Callable[[], Tuple[bool, str]]] = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        model: Optional[str] = None,
    ) -> None:
        self.runner = runner or run_headless_prompt
        self._availability = availability or check_available
        self.batch_size = max(1, int(batch_size or DEFAULT_BATCH_SIZE))
        self.timeout = timeout
        self.model = model or None

    def availability(self) -> Tuple[bool, str]:
        if disabled_by_environment():
            return False, f"disabled by {DISABLE_ENV}"
        return self._availability()

    def batches(self, handles: List[str]) -> List[List[str]]:
        return [handles[i:i + self.batch_size] for i in range(0, len(handles), self.batch_size)]

    def ask_batch(self, handles: List[str], event_name: str, event_date: datetime) -> GrokReply:
        """1バッチ送信。例外時は呼び出し側で再送しないこと。"""
        text, model = self.runner(
            build_prompt(handles, event_name, event_date), model=self.model, timeout=self.timeout
        )
        return GrokReply(text=text, model=model, findings=parse_reply(text, handles))
