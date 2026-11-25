import json
import subprocess

import pytest

from boady import gitops, projects
from boady.project_table import ProjectTable


async def test_create_skeleton(tmp_path):
    root = await projects.create(tmp_path, "blinky", "circuitpython")
    for f in ["boady.json", "CLAUDE.md", "DESIGN.md", "README.md", "src/CIRCUIT.md", "src/code.py"]:
        assert (root / f).is_file(), f
    assert json.loads((root / "boady.json").read_text()) == {"type": "circuitpython"}
    assert "blinky" in (root / "CLAUDE.md").read_text()
    assert not (root / ".gitignore").exists()
    assert await gitops.status(root) == []
    assert len(await gitops.log(root)) == 1


async def test_create_micropython_and_errors(tmp_path):
    root = await projects.create(tmp_path, "mp", "micropython")
    assert (root / "src" / "main.py").is_file()
    with pytest.raises(projects.ProjectError, match="name_taken"):
        await projects.create(tmp_path, "mp", "micropython")
    with pytest.raises(projects.ProjectError, match="invalid_name"):
        await projects.create(tmp_path, "../x", "micropython")
    with pytest.raises(projects.ProjectError, match="invalid_type"):
        await projects.create(tmp_path, "y", "arduino")


async def test_git_status_diff_commit_reset(tmp_path):
    root = await projects.create(tmp_path, "p", "circuitpython")
    (root / "src" / "code.py").write_text("print('changed')\n")
    (root / "src" / "new.py").write_text("x = 1\n")
    (root / "DESIGN.md").unlink()
    st = {e["path"]: e["status"] for e in await gitops.status(root)}
    assert st == {"src/code.py": "modified", "src/new.py": "added", "DESIGN.md": "deleted"}
    d = await gitops.diff(root)
    assert "+print('changed')" in d and "+x = 1" in d and "DESIGN.md" in d
    assert "+x = 1" in await gitops.diff(root, "src/new.py")
    await gitops.reset_file(root, "src/new.py")
    assert not (root / "src" / "new.py").exists()
    await gitops.reset_file(root, "DESIGN.md")
    assert (root / "DESIGN.md").exists()
    h = await gitops.commit(root, "change code")
    assert len(h) == 40
    log = await gitops.log(root)
    assert [c["subject"] for c in log] == ["change code", "Create boady project"]
    (root / "src" / "code.py").write_text("again")
    (root / "src" / "tmp.py").write_text("t")
    await gitops.reset_all(root)
    assert await gitops.status(root) == []
    assert not (root / "src" / "tmp.py").exists()


async def test_push_without_remote(tmp_path):
    root = await projects.create(tmp_path, "p", "circuitpython")
    with pytest.raises(Exception, match="no remote"):
        await gitops.push(root)


async def test_push_to_bare_remote(tmp_path):
    root = await projects.create(tmp_path / "w", "p", "circuitpython")
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=root, check=True)
    await gitops.push(root)
    out = subprocess.run(["git", "log", "--oneline", "main"], cwd=bare, capture_output=True, text=True).stdout
    assert "Create boady project" in out


async def _make_source_repo(tmp_path, with_type: bool):
    src = tmp_path / "source"
    (src / "src").mkdir(parents=True)
    (src / "src" / "code.py").write_text("import board\n")
    if with_type:
        (src / "boady.json").write_text('{"type": "circuitpython"}')
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=src, check=True)
    subprocess.run(["git", "add", "-A"], cwd=src, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=src, check=True)
    return src


async def test_clone_with_boady_json(tmp_path):
    src = await _make_source_repo(tmp_path, True)
    pdir = tmp_path / "projects"
    pdir.mkdir()

    async def never(_root):
        raise AssertionError("classifier must not run")

    root, name, t = await projects.clone(pdir, str(src), set(), never)
    assert (name, t) == ("source", "circuitpython")


async def test_clone_classified_and_rejected(tmp_path):
    src = await _make_source_repo(tmp_path, False)
    pdir = tmp_path / "projects"
    pdir.mkdir()

    async def cp(_root):
        return {"type": "circuitpython", "reason": "imports board"}

    root, name, t = await projects.clone(pdir, str(src), {"source"}, cp)
    assert name == "source-2" and t == "circuitpython"
    assert json.loads((root / "boady.json").read_text())["type"] == "circuitpython"
    # boady.json is left uncommitted (git is manual)
    assert {"path": "boady.json", "status": "added"} in await gitops.status(root)

    async def reject(_root):
        return {"type": "reject", "reason": "not a microcontroller project"}

    with pytest.raises(projects.ProjectError, match="repo_unfit"):
        await projects.clone(pdir, str(src), set(), reject)
    assert not (pdir / "source").exists()


async def test_clone_bad_url(tmp_path):
    with pytest.raises(projects.ProjectError):
        await projects.clone(tmp_path, "--upload-pack=evil", set(), None)
    with pytest.raises(projects.ProjectError, match="clone_failed"):
        await projects.clone(tmp_path, str(tmp_path / "nope"), set(), None)


def test_parse_verdict():
    assert projects.parse_verdict('blah\n{"type": "micropython", "reason": "machine"}')["type"] == "micropython"
    assert projects.parse_verdict("no json")["type"] == "reject"


def test_name_from_url():
    assert projects.name_from_url("https://github.com/a/b-c.git") == "b-c"
    assert projects.name_from_url("git@github.com:a/foo.git") == "foo"


def test_project_table_persistence(tmp_path):
    f = tmp_path / "projects.json"
    t = ProjectTable(f)
    p = t.add("a", tmp_path / "a", "circuitpython")
    t.update(p.id, board_uid="4150325537323115")
    t2 = ProjectTable(f)
    q = t2.get(p.id)
    assert q.session_id == p.session_id and q.board_uid == "4150325537323115"
    assert [x.id for x in t2.by_uid("4150325537323115")] == [p.id]
    with pytest.raises(ValueError):
        t2.update(p.id, session_id="other")
    assert oct(f.stat().st_mode & 0o777) == "0o600"


def test_delete_dir_guard(tmp_path):
    with pytest.raises(projects.ProjectError):
        projects.delete_dir(tmp_path / "projects", tmp_path / "elsewhere")


async def test_reset_file_refuses_outside_paths(tmp_path):
    """Review finding 8: 'demo' must not treat 'demo-other' as inside."""
    from boady import files

    root = await projects.create(tmp_path, "demo", "circuitpython")
    other = tmp_path / "demo-other"
    other.mkdir()
    (other / "keep.txt").write_text("keep")
    for bad in ("../demo-other/keep.txt", ".git/config", "src/../../demo-other/keep.txt"):
        with pytest.raises(files.PathError):
            await gitops.reset_file(root, bad)
    assert (other / "keep.txt").read_text() == "keep"


async def test_reset_renamed_file(tmp_path):
    """Review finding 9: resetting a rename restores the source."""
    root = await projects.create(tmp_path, "r", "circuitpython")
    subprocess.run(["git", "mv", "src/code.py", "src/renamed.py"], cwd=root, check=True)
    st = await gitops.status(root)
    assert st == [{"path": "src/renamed.py", "status": "renamed", "from": "src/code.py"}]
    await gitops.reset_file(root, "src/renamed.py")
    assert (root / "src" / "code.py").exists() and not (root / "src" / "renamed.py").exists()
    assert await gitops.status(root) == []
