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


async def test_clone_with_src_symlink_is_unfit(tmp_path):
    """Review 2, finding 2: cloned repos keep symlinks; a src link is refused."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "src").symlink_to("/tmp")
    (src / "boady.json").write_text('{"type": "circuitpython"}')
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=src, check=True)
    subprocess.run(["git", "add", "-A"], cwd=src, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=src, check=True)
    pdir = tmp_path / "projects"
    pdir.mkdir()
    with pytest.raises(projects.ProjectError, match="repo_unfit"):
        await projects.clone(pdir, str(src), set(), None)
    assert not (pdir / "source").exists()



async def test_reset_untracked_symlink_removes_the_link_only(tmp_path):
    """Review 6, finding 3: resetting src/alias.py -> main.py deleted main.py."""
    root = await projects.create(tmp_path, "lnk", "micropython")
    main = root / "src" / "main.py"
    main.write_text("uncommitted edit\n")
    (root / "src" / "alias.py").symlink_to("main.py")
    await gitops.reset_file(root, "src/alias.py")
    assert not (root / "src" / "alias.py").is_symlink()
    assert main.read_text() == "uncommitted edit\n"


async def test_reset_untracked_link_pointing_outside(tmp_path):
    root = await projects.create(tmp_path / "p", "lnk2", "circuitpython")
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    (root / "src" / "out.txt").symlink_to(outside)
    await gitops.reset_file(root, "src/out.txt")
    assert not (root / "src" / "out.txt").is_symlink()
    assert outside.read_text() == "keep"


async def test_boady_json_through_a_link_is_neither_read_nor_written(tmp_path):
    """Review 9, finding 1: the first connection must not rewrite a file outside the project."""
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"type": "circuitpython"}))
    (root / "boady.json").symlink_to(outside)
    assert projects.read_type(root) is None and projects.read_board(root) is None
    with pytest.raises(projects.ProjectError, match="unsafe_project_file"):
        projects.write_board(root, "rp2040js")
    with pytest.raises(projects.ProjectError, match="unsafe_project_file"):
        projects.write_type(root, "micropython")
    assert json.loads(outside.read_text()) == {"type": "circuitpython"}
    (root / "boady.json").unlink()
    (root / "boady.json").symlink_to(tmp_path / "dangling.json")  # a write would create it
    with pytest.raises(projects.ProjectError):
        projects.write_type(root, "micropython")
    assert not (tmp_path / "dangling.json").exists()


async def test_clone_refuses_linked_metadata(tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("SECRET")
    src = tmp_path / "linked"
    (src / "src").mkdir(parents=True)
    (src / "src" / "code.py").write_text("x")
    (src / "boady.json").write_text(json.dumps({"type": "circuitpython"}))
    (src / "CLAUDE.md").symlink_to(outside)
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "commit", "-qm", "init"]):
        subprocess.run(cmd, cwd=src, check=True)
    pdir = tmp_path / "projects"
    pdir.mkdir()

    async def never(_root):
        raise AssertionError("classifier must not run")

    with pytest.raises(projects.ProjectError, match="CLAUDE.md is a symbolic link"):
        await projects.clone(pdir, str(src), set(), never)
    assert not (pdir / "linked").exists()


async def test_clone_adds_only_the_missing_project_documents(tmp_path):
    """Master 2026-11-25 (D44): a clone gets the documents a new project has, never
    overwriting what the repository has (any spelling), never through a link, no code."""
    src = tmp_path / "docs"
    (src / "src").mkdir(parents=True)
    (src / "src" / "main.py").write_text("print(1)\n")
    (src / "boady.json").write_text('{"type": "micropython"}')
    (src / "readme.md").write_text("their readme\n")  # README.md under another spelling
    (src / "CLAUDE.md").write_text("their rules\n")
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "commit", "-qm", "init"]):
        subprocess.run(cmd, cwd=src, check=True)
    pdir = tmp_path / "projects"
    pdir.mkdir()

    async def never(_root):
        raise AssertionError("classifier must not run")

    root, name, t = await projects.clone(pdir, str(src), set(), never)
    assert (root / "CLAUDE.md").read_text() == "their rules\n"
    assert (root / "readme.md").read_text() == "their readme\n"
    assert sorted(p.name for p in root.iterdir() if p.name.lower() == "readme.md") == ["readme.md"]
    assert (root / "DESIGN.md").read_text().strip()  # the new-project template
    assert (root / "src" / "CIRCUIT.md").is_file()
    assert sorted(p.name for p in (root / "src").iterdir()) == ["CIRCUIT.md", "main.py"]  # no code added
    status = {f["path"]: f["status"] for f in await gitops.status(root)}
    assert status == {"DESIGN.md": "added", "src/CIRCUIT.md": "added"}  # uncommitted: the user decides


def test_fill_missing_docs_skips_links(tmp_path):
    root = tmp_path / "p"
    (root / "src").mkdir(parents=True)
    (root / "DESIGN.md").symlink_to(tmp_path / "nowhere.md")  # dangling: a write would create it
    (root / "lib").mkdir()
    added = projects.fill_missing_docs(root, "p", "circuitpython")
    assert sorted(added) == ["CLAUDE.md", "README.md", "src/CIRCUIT.md"]
    assert not (tmp_path / "nowhere.md").exists()
    (root / "src" / "CIRCUIT.md").unlink()
    (root / "src").rename(root / "real_src")
    (root / "src").symlink_to(root / "real_src", target_is_directory=True)
    assert projects.fill_missing_docs(root, "p", "circuitpython") == []  # src/ is a link: left alone


async def test_file_names_are_never_pathspecs(tmp_path):
    """Review 15: ':code.py' restored code.py (losing its edit), ':!x' everything but x,
    and an untracked '[ab].py' took a.py and b.py out of the index."""
    repo = tmp_path / "r"
    repo.mkdir()
    await gitops.init(repo)
    for n in ("code.py", ":code.py", "a.py", "b.py", "x", ":!x"):
        (repo / n).write_text("v1\n")
    await gitops.commit(repo, "init")
    for n in ("code.py", ":code.py", "a.py", "b.py", "x", ":!x"):
        (repo / n).write_text("edited\n")
    (repo / "[ab].py").write_text("untracked\n")

    await gitops.reset_file(repo, ":code.py")
    assert (repo / ":code.py").read_text() == "v1\n" and (repo / "code.py").read_text() == "edited\n"
    await gitops.reset_file(repo, ":!x")
    assert (repo / ":!x").read_text() == "v1\n"
    assert all((repo / n).read_text() == "edited\n" for n in ("code.py", "a.py", "b.py", "x"))
    await gitops.reset_file(repo, "[ab].py")
    assert not (repo / "[ab].py").exists()
    st = {f["path"]: f["status"] for f in await gitops.status(repo)}
    assert st == {"code.py": "modified", "a.py": "modified", "b.py": "modified", "x": "modified"}
    d = await gitops.diff(repo, "a.py")
    assert "a.py" in d and "b.py" not in d
    assert ":code.py" not in await gitops.diff(repo, "code.py")
