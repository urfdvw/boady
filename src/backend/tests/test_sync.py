import base64

from boady import sync


def b64(s: bytes) -> str:
    return base64.b64encode(s).decode()


def test_excluded():
    for p in [".DS_Store", "lib/._foo.py", ".Trashes", "System Volume Information/x", ".boady_id", ".fseventsd/a"]:
        assert sync.excluded(p), p
    for p in ["code.py", "lib/adafruit_x.mpy", "boot_out.txt", "sub/.boady_id"]:
        assert not sync.excluded(p), p


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
    d = sync.text_diffs(src, board, list(board))
    assert "SECRET" not in "".join(d.values())
    assert "+print(1)" in d["code.py"]
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
