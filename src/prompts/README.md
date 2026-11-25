# Prompts

All prompt text used by boady. Code references these files; no inline prompt strings.

- `system/common.md` + `system/<type>.md` (+ `system/rp2040js.md` for a test project on the emulator) — system prompt appended to Claude Code's preset when a project session starts.
- `project_claude_md/<type>.md` — CLAUDE.md template for new projects (`{{name}}` is replaced).
- `tasks/*.md` — one-shot agent calls (clone classification; board identification comes in phase 2).
