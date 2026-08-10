"""子服终端输出与输入规范化。"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, List

EXIT_WORDS = frozenset({"exit", "quit", "q", "退出", "离开"})
CLEAR_WORDS = frozenset({"clear", "清屏"})


def strip_line(line: str) -> str:
    text = (line or "").strip()
    if text.startswith("#"):
        text = text[1:].strip()
    return text


def clear_screen() -> None:
    if os.name == "nt":
        os.system("cls")
    else:
        os.system("clear")


def _step_summary(steps: list) -> str:
    parts = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        label = step.get("action") or step.get("skipped") or "step"
        if step.get("skipped"):
            parts.append(f"{label}(skip)")
        elif step.get("ok"):
            parts.append(f"{label}(ok)")
        else:
            parts.append(f"{label}(fail)")
    return ", ".join(parts) if parts else "无步骤"


def _format_update_all(payload: dict) -> str:
    results = payload.get("results") or {}
    lines = []
    ok_count = 0
    for name in payload.get("groups") or []:
        item = results.get(name) or {}
        if item.get("ok"):
            ok_count += 1
            lines.append(f"  ✓ {name}: {_step_summary(item.get('steps') or [])}")
        else:
            lines.append(f"  ✗ {name}: 更新失败")
    total = len(payload.get("groups") or [])
    head = "✓ 全部更新完成" if payload.get("ok") else f"⚠ 更新完成 {ok_count}/{total}"
    out = [head, *lines]
    if payload.get("hint"):
        out.append(str(payload["hint"]))
    return "\n".join(out)


def format_result(payload: Any) -> str:
    if not isinstance(payload, dict):
        return str(payload)
    if payload.get("ok") is False:
        err = payload.get("error") or payload.get("detail") or "失败"
        extra = payload.get("available") or payload.get("commands")
        if extra:
            return f"✗ {err}\n  可用: {', '.join(extra)}"
        return f"✗ {err}"
    if payload.get("action") == "update-all":
        return _format_update_all(payload)
    if payload.get("action") == "update-one" or (
        payload.get("group") and isinstance(payload.get("result"), dict)
    ):
        group = payload.get("group", "")
        steps = _step_summary((payload.get("result") or {}).get("steps") or [])
        mark = "✓" if payload.get("ok") else "✗"
        return f"{mark} {group}: {steps}"
    if "groups" in payload and "count" in payload:
        lines = ["插件组:"]
        for item in payload.get("groups", []):
            if not isinstance(item, dict):
                continue
            cmds = ", ".join(item.get("commands", []))
            lines.append(f"  · {item['group']} — {item.get('description', '')} [{cmds}]")
        if payload.get("hint"):
            lines.append(str(payload["hint"]))
        return "\n".join(lines)
    if "groups" in payload and isinstance(payload["groups"], list):
        names = payload["groups"]
        if names and isinstance(names[0], str):
            return "已注册: " + ", ".join(str(x) for x in names)
    return json.dumps(payload, ensure_ascii=False, indent=2)


def completion_words(groups_fn: Callable[[], List[str]]) -> List[str]:
    words = [
        "帮助",
        "列表",
        "更新",
        "退出",
        "清屏",
        "help",
        "list",
        "update",
        "exit",
        "clear",
    ]
    for group in groups_fn():
        words.extend([group, f"{group} 状态", f"{group} 更新"])
    return sorted(set(words))
