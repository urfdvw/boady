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
        # review finding 1: options must not turn "read-only" git into a writer
        ("Bash", {"command": "git diff --output=../outside.txt"}, "ask"),
        ("Bash", {"command": "git log -p --output ../x"}, "ask"),
        ("Bash", {"command": "git diff -O/etc/passwd"}, "ask"),
        ("Bash", {"command": "git diff --no-index a b"}, "ask"),
        ("Bash", {"command": "git log --format=%H -n5 --stat"}, "allow"),
        ("Bash", {"command": "git status --porcelain --untracked-files=all"}, "allow"),
        ("Bash", {"command": "git config --file /etc/x --get a"}, "ask"),
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
        # review 6, finding 1: circup uses the last --path; network targets are not the mirror
        ("circup --offline --path src --path alternate uninstall sensor", True),
        ("circup --path=src --path=/tmp uninstall sensor", True),
        ("circup --path src --host 192.168.1.5 uninstall sensor", True),
        ("git filter-branch", True),
        ("git diff --output=../outside.txt", True),
        ("git log --output ../x", True),
        ("git push --receive-pack=evil", True),
        ("git fetch --upload-pack=evil origin", True),
        ("git diff --ext-diff", True),
    ],
)
def test_hard_block_bash(cmd, blocked):
    assert (hard_block("Bash", {"command": cmd}, ROOT) is not None) == blocked


def test_hard_block_git_dir():
    assert hard_block("Write", {"file_path": "/tmp/proj/.git/hooks/pre-commit"}, ROOT)
    assert hard_block("Edit", {"file_path": ".git/config"}, ROOT)
    assert hard_block("Write", {"file_path": "/tmp/proj/src/code.py"}, ROOT) is None


def test_bash_circup_refused_through_linked_lib(tmp_path):
    """Review 5, finding 2: the Bash circup entry needs the library tools' link guard."""
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    cmd = {"command": "circup --offline --path src uninstall sensor"}
    assert hard_block("Bash", cmd, root) is None
    (root / "src" / "lib").symlink_to(outside)
    assert "symlink_in_lib" in hard_block("Bash", cmd, root)


def _case_insensitive(d: Path) -> bool:
    probe = d / "CaseProbe"
    probe.write_text("x")
    try:
        return (d / "caseprobe").exists()
    finally:
        probe.unlink()


def test_git_dir_is_protected_through_a_link(tmp_path):
    """Review 8, finding 1: a link to .git is .git."""
    from boady import files
    from boady.util import in_git_dir

    root = tmp_path / "proj"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "config").write_text("[core]\n")
    (root / "gitlink").symlink_to(root / ".git")
    assert hard_block("Write", {"file_path": str(root / "gitlink" / "config")}, root)
    assert in_git_dir(root, Path("gitlink/hooks/new"))
    with pytest.raises(files.PathError):
        files.write(root, "gitlink/config", "x")
    assert hard_block("Write", {"file_path": "src/code.py"}, root) is None
    assert not in_git_dir(root, Path("src/.gitignore"))


def test_git_dir_is_protected_under_another_spelling(tmp_path):
    """Review 8, finding 1. Only meaningful where the file system ignores case (macOS,
    Windows): reported as skipped elsewhere instead of passing without checking (review 10)."""
    from boady import files

    if not _case_insensitive(tmp_path):
        pytest.skip("case-sensitive file system: .GIT is a different directory here")
    root = tmp_path / "proj"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "config").write_text("[core]\n")
    for p in (".GIT/config", ".Git/hooks/pre-commit", str(root / ".GIT" / "config")):
        assert hard_block("Edit", {"file_path": p}, root), p
    with pytest.raises(files.PathError):
        files.write(root, ".GIT/config", "evil")
    with pytest.raises(files.PathError):
        files.entry(root, ".GIT")
    assert (root / ".git" / "config").read_text() == "[core]\n"


def test_git_literal_pathspecs_is_the_one_global_option(tmp_path):
    """Master (option B, review 17): the agent may name files literally; nothing else changes."""
    def bash(cmd):
        return {"command": cmd}

    lit = "git --literal-pathspecs"
    # allowed, and judged like the same command without it
    for cmd in (f"{lit} diff HEAD -- src/:odd.py", f"{lit} status", f"{lit} log -- 'src/[ab].py'"):
        assert hard_block("Bash", bash(cmd), tmp_path) is None, cmd
        assert classify("Bash", bash(cmd), tmp_path) == "allow", cmd
    # history-changing commands still ask
    for cmd in (f"{lit} commit -m x", f"{lit} reset --hard", f"{lit} checkout -- src/x.py"):
        assert hard_block("Bash", bash(cmd), tmp_path) is None, cmd
        assert classify("Bash", bash(cmd), tmp_path) == "ask", cmd
    # every other global option, or more of them, is still refused
    for cmd in (f"{lit} -c core.pager=x log", f"{lit} -C / status", f"{lit} --literal-pathspecs status",
                "git --glob-pathspecs status", f"{lit} config user.name x", f"{lit} diff --output=/tmp/x", lit):
        assert hard_block("Bash", bash(cmd), tmp_path), cmd


def test_paths_and_shell_expansions_cannot_reach_outside_unasked(tmp_path):
    """Review 18, finding 1: a link in the project to an outside file, installed by circup
    as a local module, was auto-allowed; so was anything hidden behind $VAR."""
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    outside = tmp_path / "secret.py"
    outside.write_text("SECRET = 1\n")
    (root / "sensor.py").symlink_to(outside)
    (root / "local.py").write_text("X = 1\n")

    def bash(cmd):
        return {"command": cmd}

    cmd = "circup --offline --path src install ./sensor.py"
    assert hard_block("Bash", bash(cmd), root) is None and classify("Bash", bash(cmd), root) == "ask"
    assert classify("Bash", bash("circup --offline --path src install -r sensor.py"), root) == "ask"
    assert classify("Bash", bash("circup --offline --path src install ./local.py"), root) == "allow"
    assert classify("Bash", bash("git diff --no-index -- local.py sensor.py"), root) == "ask"
    # expansions the checks cannot see are refused outright; quoted they are literal
    for cmd in ("circup --path src install $HOME/x.py", 'git log -- "$HOME"', "git log -- `pwd`",
                "git diff -- src/*.py", "git diff -- src/?.py", "git diff -- src/[ab].py", "git diff -- {..,src}/x.py",
                "git diff -- src/{a,b}.py"):
        assert hard_block("Bash", bash(cmd), root), cmd
    for cmd in ("git diff -- 'src/*.py'", "git log -1 --format='%H $x'", "git show HEAD@{1}", "git log --oneline -n 3"):
        assert hard_block("Bash", bash(cmd), root) is None, cmd
