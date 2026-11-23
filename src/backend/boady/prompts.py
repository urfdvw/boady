"""All prompt text lives in ``src/prompts/*.md``; code only references files."""

from __future__ import annotations

from pathlib import Path

from .config import PROMPTS_DIR


def load(rel: str, root: Path = PROMPTS_DIR) -> str:
    return (root / rel).read_text(encoding="utf-8")


def system_prompt(project_type: str) -> str:
    """Boady system prompt for a project type: common rules + type specifics."""
    return load("system/common.md") + "\n\n" + load(f"system/{project_type}.md")


def project_claude_md(project_type: str) -> str:
    return load(f"project_claude_md/{project_type}.md")


def task(name: str, **fmt: str) -> str:
    text = load(f"tasks/{name}.md")
    for k, v in fmt.items():
        text = text.replace("{{" + k + "}}", v)
    return text
