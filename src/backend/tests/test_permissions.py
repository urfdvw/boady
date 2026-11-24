from pathlib import Path

import pytest

from boady.permissions import classify, hard_block

ROOT = Path("/tmp/proj")


@pytest.mark.parametrize(
    "tool,inp,expected",
    [
        ("Read", {"file_path": "/tmp/proj/src/code.py"}, "allow"),
        ("Read", {"file_path": "src/code.py"}, "allow"),
        ("Read", {"file_path": "/etc/passwd"}, "ask"),
        ("Read", {"file_path": "/tmp/proj/../other/x"}, "ask"),
        ("Write", {"file_path": "/tmp/proj/src/code.py"}, "allow"),
        ("Edit", {"file_path": "/home/x/.bashrc"}, "ask"),
        ("Glob", {"pattern": "**/*.py"}, "allow"),
        ("Grep", {"pattern": "x", "path": "/"}, "ask"),
        ("Bash", {"command": "git status"}, "allow"),
        ("Bash", {"command": "git diff src/code.py"}, "allow"),
        ("Bash", {"command": "git log --oneline -5"}, "allow"),
        ("Bash", {"command": "git commit -m 'x'"}, "ask"),
        ("Bash", {"command": "git reset --hard"}, "ask"),
        ("Bash", {"command": "git push"}, "ask"),
        ("Bash", {"command": "git diff --no-index /etc/passwd src/x"}, "ask"),
        ("Bash", {"command": "circup --path src install adafruit_bme280"}, "allow"),
        ("Bash", {"command": "circup --path /tmp/proj/src update --all"}, "allow"),
        ("mcp__boady__read_repl", {}, "allow"),
        ("mcp__boady__write_repl", {"data": "\x03"}, "allow"),
        ("mcp__boady__sync_from_device", {}, "allow"),
        ("mcp__boady__sync_to_device", {}, "ask"),
        ("mcp__boady__install_library", {"names": ["aioble"]}, "allow"),
        ("TodoWrite", {}, "allow"),
        ("WebFetch", {"url": "https://x"}, "ask"),
    ],
)
def test_classify(tool, inp, expected):
    assert classify(tool, inp, ROOT) == expected


@pytest.mark.parametrize(
    "cmd,blocked",
    [
        ("git status", False),
        ("git commit -m hi", False),
        ("git config --get user.name", False),
        ("git config user.name evil", True),
        ("git -C /etc status", True),
        ("git -c core.pager=sh log", True),
        ("git status; rm -rf /", True),
        ("git log | head", True),
        ("echo $(whoami)", True),
        ("cat /etc/passwd", True),
        ("rm -rf src", True),
        ("python3 x.py", True),
        ("mpremote mip install aioble", True),
        ("circup install foo", True),
        ("circup --path /tmp other install foo", True),
        ("circup --path src install foo", False),
        ("git filter-branch", True),
    ],
)
def test_hard_block_bash(cmd, blocked):
    assert (hard_block("Bash", {"command": cmd}, ROOT) is not None) == blocked


def test_hard_block_git_dir():
    assert hard_block("Write", {"file_path": "/tmp/proj/.git/hooks/pre-commit"}, ROOT)
    assert hard_block("Edit", {"file_path": ".git/config"}, ROOT)
    assert hard_block("Write", {"file_path": "/tmp/proj/src/code.py"}, ROOT) is None
