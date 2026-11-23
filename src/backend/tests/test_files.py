import pytest

from boady import files


def test_tree_read_write(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("x")
    (tmp_path / "src").mkdir()
    files.write(tmp_path, "src/code.py", "print(1)\n")
    t = files.tree(tmp_path)
    assert [e["path"] for e in t] == ["src", "src/code.py"]
    assert files.read(tmp_path, "src/code.py")["text"] == "print(1)\n"
    (tmp_path / "src" / "b.bin").write_bytes(b"\xff\xfe\x00")
    assert files.read(tmp_path, "src/b.bin")["binary"] is True


@pytest.mark.parametrize("bad", ["../x", "/etc/passwd/../../x/../../..", ".git/config", "src/../../x"])
def test_path_safety(tmp_path, bad):
    with pytest.raises(files.PathError):
        files.write(tmp_path, bad, "x")
