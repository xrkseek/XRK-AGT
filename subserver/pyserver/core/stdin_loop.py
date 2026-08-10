"""子服务端交互终端。"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Optional

from xrk_readline import Readline, backend_name

from .cli_ui import (
    CLEAR_WORDS,
    EXIT_WORDS,
    clear_screen,
    completion_words,
    format_result,
    strip_line,
)
from .command_registry import CommandRegistry
from .config import get_data_root

logger = logging.getLogger(__name__)

_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None
_io_lock = threading.Lock()
_rl: Optional[Readline] = None


def _history_path() -> Path:
    return get_data_root() / "stdin_history"


def _build_readline() -> Readline:
    rl = Readline(history_size=500)
    history = _history_path()
    history.parent.mkdir(parents=True, exist_ok=True)
    rl.read_history_file(history)
    rl.set_stop_check(_stop_event.is_set)

    cache: dict[str, list[str]] = {"words": []}

    def _completer(text: str, state: int) -> Optional[str]:
        if state == 0:
            cache["words"] = [
                w for w in completion_words(CommandRegistry.groups) if w.startswith(text)
            ]
        return cache["words"][state] if state < len(cache["words"]) else None

    rl.set_completer(_completer)
    rl.set_completer_delims(" \t\n;")
    return rl


def _request_shutdown() -> None:
    _stop_event.set()
    try:
        signal.raise_signal(signal.SIGINT)
    except (OSError, ValueError, AttributeError):
        try:
            os.kill(os.getpid(), signal.SIGINT)
        except Exception:
            pass


def _stdin_reader_loop(prompt: str) -> None:
    global _rl
    rl = _build_readline()
    _rl = rl
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    with _io_lock:
        print("\n[子服] 帮助 · 列表 · 更新 · 清屏 · 退出", flush=True)
        print(f"      backend={backend_name()} · Ctrl+C 停服 · Ctrl+D/退出 关终端", flush=True)

    try:
        while not _stop_event.is_set():
            try:
                line = rl.readline(prompt)
            except KeyboardInterrupt:
                with _io_lock:
                    print("正在停止子服…", flush=True)
                _request_shutdown()
                break
            except EOFError:
                with _io_lock:
                    print("终端已关闭（HTTP 继续运行）", flush=True)
                break
            except Exception as exc:
                logger.error("stdin 读行失败: %s", exc, exc_info=True)
                with _io_lock:
                    print(f"✗ 终端读行失败: {exc}", flush=True)
                break

            text = strip_line(line)
            if not text:
                continue

            lower = text.lower()
            if lower in EXIT_WORDS or text in EXIT_WORDS:
                with _io_lock:
                    print("终端已关闭（HTTP 继续运行）", flush=True)
                break

            if lower in CLEAR_WORDS or text in CLEAR_WORDS:
                clear_screen()
                continue

            try:
                if text in ("更新", "update", "同步"):
                    with _io_lock:
                        print("正在更新 apis/ 下全部插件…", flush=True)
                result = loop.run_until_complete(CommandRegistry.run_line(text))
                with _io_lock:
                    print(format_result(result), flush=True)
            except Exception as exc:
                logger.error("命令执行失败: %s", exc, exc_info=True)
                with _io_lock:
                    print(f"✗ {exc}", flush=True)
    finally:
        try:
            rl.write_history_file(_history_path())
        except OSError:
            pass
        _rl = None
        loop.close()


def start_stdin_loop(*, enabled: bool = True, prompt: str = "子服> "):
    global _thread
    if not enabled:
        return
    if not sys.stdin.isatty():
        logger.debug("非交互终端，跳过 stdin 命令行")
        return
    if _thread and _thread.is_alive():
        return

    _stop_event.clear()
    _thread = threading.Thread(
        target=_stdin_reader_loop,
        args=(prompt,),
        name="subserver-stdin",
        daemon=True,
    )
    _thread.start()


def stop_stdin_loop() -> None:
    _stop_event.set()
