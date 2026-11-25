import pytest
import base64

from boady import sync


def b64(s: bytes) -> str:
    return base64.b64encode(s).decode()


def test_excluded():
    """Same cases as the frontend (src/shared/sync_exclude_cases.json, D47)."""
    import json

    from boady.config import SHARED_DIR

    cases = json.loads((SHARED_DIR / "sync_exclude_cases.json").read_text())
    for p in cases["excluded"]:
        assert sync.excluded(p), p
    for p in cases["kept"]:
        assert not sync.excluded(p), p


def test_junk_never_crosses_in_either_direction(tmp_path):
    """Master 2026-11-25: .Trash-1000 and .metadata_never_index are system junk."""
    src = tmp_path / "src"
    src.mkdir()
    (src / ".Trash-1000" / "files").mkdir(parents=True)
    (src / ".Trash-1000" / "files" / "old.py").write_text("x")
    (src / ".metadata_never_index").write_text("")
    (src / "code.py").write_text("print(1)")
    # upload: the mirror's junk is not part of what is sent
    assert set(sync.manifest(src)) == {"code.py"} and set(sync.snapshot(src)) == {"code.py"}
    # pull: the board's junk is not written, and the mirror's junk is not deleted either
    board = {"code.py": b64(b"print(2)"), ".Trash-1000/files/x.py": b64(b"x"), ".metadata_never_index": b64(b"")}
    res = sync.apply_from_device(src, board)
    assert res == {"added": [], "modified": ["code.py"], "deleted": []}
    assert not (src / ".Trash-1000" / "files" / "x.py").exists()
    assert (src / ".Trash-1000" / "files" / "old.py").exists()


def test_apply_from_device(tmp_path):
    src = tmp_path / "src"
    (src / "lib").mkdir(parents=True)
    (src / "code.py").write_text("old")
    (src / "keep.txt").write_text("same")
    (src / "lib" / "gone.py").write_text("x")
    res = sync.apply_from_device(src, {
        "code.py": b64(b"new"),
        "keep.txt": b64(b"same"),
        "boot_out.txt": b64(b"Adafruit CircuitPython 9"),
        ".boady_id": b64(b"uuid"),
        "._code.py": b64(b"junk"),
    })
    assert res == {"added": ["boot_out.txt"], "modified": ["code.py"], "deleted": ["lib/gone.py"]}
    assert (src / "code.py").read_text() == "new"
    assert not (src / ".boady_id").exists()
    assert not (src / "lib").exists()


def test_unsafe_path_rejected(tmp_path):
    import pytest

    with pytest.raises(ValueError):
        sync.apply_from_device(tmp_path / "src", {"../evil": b64(b"x")})


def test_manifest(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.py").write_bytes(b"abc")
    (src / ".DS_Store").write_bytes(b"x")
    m = sync.manifest(src)
    assert list(m) == ["a.py"]
    assert m["a.py"] == sync.sha256(b"abc")


def test_mirror_src_refuses_symlinks(tmp_path):
    """Review 2, finding 2."""
    import pytest

    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    (root / "src").symlink_to(outside)
    with pytest.raises(sync.MirrorPathError):
        sync.mirror_src(root)


def test_nested_symlinks_are_not_followed_or_deleted(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    src = tmp_path / "src"
    src.mkdir()
    (src / "lib").symlink_to(outside)
    (src / "link.txt").symlink_to(outside / "keep.txt")
    assert sync.mirror_files(src) == {}
    sync.apply_from_device(src, {})  # board is empty: must not delete through the links
    assert (outside / "keep.txt").read_text() == "keep"


def test_text_diffs_never_read_through_directory_links(tmp_path):
    """Review 3, finding 1: a board path must not reach files outside the mirror."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "config.txt").write_text("SECRET outside the project\n")
    src = tmp_path / "src"
    src.mkdir()
    (src / "lib").symlink_to(outside)
    (src / "code.py").write_text("print(1)\n")
    board = {"lib/config.txt": b64(b"board\n"), "../outside/config.txt": b64(b"x\n"), "code.py": b64(b"print(0)\n")}
    d = sync.text_diffs(sync.snapshot(src), board, list(board))
    assert "SECRET" not in "".join(d.values())
    assert "-print(1)" in d["code.py"] and "+print(0)" in d["code.py"]  # mirror -> board
    assert sync.safe_mirror_file(src, "lib/config.txt") is None
    assert sync.safe_mirror_file(src, "code.py") == src / "code.py"


def test_apply_paths_only_touches_given_files_and_refuses_links(tmp_path):
    import pytest

    src = tmp_path / "src"
    src.mkdir()
    (src / "code.py").write_text("local")
    (src / "old.txt").write_text("x")
    res = sync.apply_paths(src, {"data.txt": b64(b"d"), "code.py": b64(b"board")}, ["data.txt", "old.txt"])
    assert res == {"added": ["data.txt"], "modified": [], "deleted": ["old.txt"]}
    assert (src / "code.py").read_text() == "local"
    outside = tmp_path / "outside"
    outside.mkdir()
    (src / "lib").symlink_to(outside)
    with pytest.raises(ValueError):
        sync.apply_paths(src, {"lib/x.py": b64(b"x")}, ["lib/x.py"])
    assert not (outside / "x.py").exists()


def test_canonical_rel():
    for ok in ("code.py", "lib/x.py", "a/b/c.txt", ".hidden"):
        assert sync.canonical_rel(ok) == ok
    for bad in ("", "./x", "x/.", "a//b", "a/../b", "/x", "x/", "a\\b", None, 3):
        assert sync.canonical_rel(bad) is None


def test_case_alias(tmp_path):
    src = tmp_path / "src"
    (src / "lib").mkdir(parents=True)
    (src / "code.py").write_text("x")
    (src / "lib" / "a.py").write_text("x")
    assert sync.case_alias(src, "code.py") is None
    assert sync.case_alias(src, "new.py") is None
    assert sync.case_alias(src, "CODE.PY") == "code.py"
    assert sync.case_alias(src, "LIB/a.py") == "lib"


def test_case_collisions():
    assert sync.case_collisions(["A.txt", "a.txt", "b.txt"]) == [("A.txt", "a.txt")]
    assert sync.case_collisions(["Lib/x.py", "lib/y.py"]) == [("Lib", "lib")]
    assert sync.case_collisions(["lib/x.py", "lib/y.py"]) == []


def test_full_pull_refuses_case_collisions_on_this_file_system(tmp_path, monkeypatch):
    """Review 6, finding 2: A.txt and a.txt from the board must not merge into one mirror file."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "keep.py").write_text("local")
    monkeypatch.setattr(sync, "case_insensitive", lambda d: True)
    with pytest.raises(ValueError, match="case_collision"):
        sync.apply_from_device(src, {"A.txt": b64(b"upper"), "a.txt": b64(b"lower")})
    assert sorted(p.name for p in src.iterdir()) == ["keep.py"]  # nothing changed
    assert (src / "keep.py").read_text() == "local"


def test_full_pull_respelled_file_keeps_board_content(tmp_path):
    """Local Code.py, board code.py: the result is the board's file, not a deleted one."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "Code.py").write_text("old")
    res = sync.apply_from_device(src, {"code.py": b64(b"board")})
    assert [p.name for p in src.iterdir()] == ["code.py"]
    assert (src / "code.py").read_text() == "board"
    assert res == {"added": ["code.py"], "modified": [], "deleted": ["Code.py"]}


def test_case_insensitive_probe(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    expected = (tmp_path / "SRC").exists()
    assert sync.case_insensitive(d) is expected


def test_full_pull_refuses_board_paths_through_mirror_links(tmp_path):
    """Review 9, finding 2: b.py -> a.py locally, a.py=A and b.py=B on the board."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.py").write_text("A0")
    (src / "b.py").symlink_to("a.py")
    (src / "keep.py").write_text("k")
    (src / "shared").mkdir()
    (src / "lib").symlink_to("shared", target_is_directory=True)
    for board in ({"a.py": b64(b"A"), "b.py": b64(b"B")}, {"a.py": b64(b"A"), "lib/x.py": b64(b"X")}):
        with pytest.raises(ValueError, match="symlink"):
            sync.apply_from_device(src, board)
        assert (src / "a.py").read_text() == "A0" and (src / "b.py").is_symlink()  # nothing changed
        assert (src / "keep.py").exists() and not (src / "shared" / "x.py").exists()


NFC, NFD = "café.py", "café.py"


def test_unicode_spellings_are_one_name():
    """Review 13, finding 2: NFC and NFD spellings of a name."""
    assert NFC != NFD and sync.name_key(NFC) == sync.name_key(NFD)
    assert [set(c) for c in sync.case_collisions([NFC, NFD, "x.py"])] == [{NFC, NFD}]
    assert sync.case_collisions([NFC, "CAFÉ.PY"], fold_case=False) == []
    assert sync.case_collisions(["A.txt", "a.txt"], fold_case=False, fold_unicode=True) == []


def test_partial_pull_refuses_another_unicode_spelling(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / NFC).write_text("uncommitted local edit")
    assert sync.case_alias(src, NFD) == NFC
    with pytest.raises(ValueError, match="different spelling"):
        sync.apply_paths(src, {NFD: b64(b"board")}, [NFD])
    assert (src / NFC).read_text() == "uncommitted local edit"


def test_full_pull_refuses_two_board_files_one_name_here(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    if not sync.normalization_insensitive(src):
        pytest.skip("this file system keeps NFC and NFD names apart")
    (src / "keep.py").write_text("k")
    with pytest.raises(ValueError, match="case_collision"):
        sync.apply_from_device(src, {NFC: b64(b"1"), NFD: b64(b"2")})
    assert sorted(p.name for p in src.iterdir()) == ["keep.py"]  # nothing changed


def test_partial_pull_refuses_two_new_paths_that_are_one_file_here(tmp_path):
    """Review 14, finding 2: NFC and NFD into an empty mirror both 'succeeded' into one file."""
    src = tmp_path / "src"
    src.mkdir()
    fold_unicode, fold_case = sync.normalization_insensitive(src), sync.case_insensitive(src)
    if not (fold_unicode or fold_case):
        pytest.skip("this file system keeps every spelling apart")
    pairs = ([NFC, NFD] if fold_unicode else []) + (["A.txt", "a.txt"] if fold_case else [])
    for a, b in zip(pairs[::2], pairs[1::2]):
        with pytest.raises(ValueError, match="case_collision"):
            sync.apply_paths(src, {a: b64(b"1"), b: b64(b"2")}, [a, b])
        assert list(src.iterdir()) == []  # nothing written


def test_partial_pull_turns_a_directory_into_a_file_and_back(tmp_path):
    """Review 14, finding 3: mirror data/old.txt, board file data: IsADirectoryError."""
    src = tmp_path / "src"
    (src / "data").mkdir(parents=True)
    (src / "data" / "old.txt").write_text("old")
    (src / "keep.py").write_text("k")
    res = sync.apply_paths(src, {"data": b64(b"now a file")}, ["data", "data/old.txt"])
    assert res == {"added": ["data"], "modified": [], "deleted": ["data/old.txt"]}
    assert (src / "data").read_text() == "now a file" and (src / "keep.py").exists()
    res = sync.apply_paths(src, {"data/new.txt": b64(b"n")}, ["data", "data/new.txt"])
    assert res == {"added": ["data/new.txt"], "modified": [], "deleted": ["data"]}
    assert (src / "data" / "new.txt").read_text() == "n"


def test_partial_pull_will_not_replace_a_directory_holding_unselected_files(tmp_path):
    src = tmp_path / "src"
    (src / "data").mkdir(parents=True)
    (src / "data" / "a.txt").write_text("a")
    (src / "data" / "b.txt").write_text("b")
    with pytest.raises(ValueError, match="still holds 'data/b.txt'"):
        sync.apply_paths(src, {"data": b64(b"file")}, ["data", "data/a.txt"])
    assert (src / "data" / "a.txt").read_text() == "a"  # checked before anything changed
    (src / "f").write_text("file")
    with pytest.raises(ValueError, match="'f' is a file"):
        sync.apply_paths(src, {"f/x.txt": b64(b"x")}, ["f/x.txt"])
    assert (src / "f").read_text() == "file"
