import sys
import textwrap

import pytest

from boady import libraries

LIST_OUT = """Found device adafruit_qtpy_rp2040 at /x, running CircuitPython 9.2.1.
The following modules are out of date or probably need an update.
Major Updates may include breaking changes. Review before updating.
MPY Format changes from Circuitpython 8 to 9 require an update.

Module             Version  Latest  Update Reason
----------------- -------- ------- -------------
adafruit_bme280    2.6.0    2.6.27  Minor Version
"""


def test_parsers():
    assert libraries.parse_freeze("Found device x\nadafruit_bme280==2.6.0\nneopixel==6.3.1\n") == {
        "adafruit_bme280": "2.6.0", "neopixel": "6.3.1"}
    assert libraries.parse_outdated(LIST_OUT) == {"adafruit_bme280": {"latest": "2.6.27", "reason": "Minor Version"}}
    assert libraries.parse_outdated("All modules found on the device are up to date.") == {}
    assert libraries.parse_show("adafruit_bme280\nadafruit_bme680\n2 shown of 400 packages.") == ["adafruit_bme280", "adafruit_bme680"]


@pytest.fixture
def fake_circup(tmp_path, monkeypatch):
    script = tmp_path / "fake_circup.py"
    log = tmp_path / "calls.txt"
    script.write_text(textwrap.dedent(f"""
        import sys
        args = sys.argv[1:]
        open({str(log)!r}, "a").write(" ".join(args) + "\\n")
        cmd = args[2]
        if cmd == "freeze":
            print("adafruit_bme280==2.6.0")
        elif cmd == "list":
            print({LIST_OUT!r})
        elif cmd == "show":
            print("adafruit_bme280\\n1 shown of 400 packages.")
        else:
            print("ok", cmd)
    """))
    monkeypatch.setattr(libraries, "_circup", lambda: [sys.executable, str(script)])
    return log


async def test_circup_calls(tmp_path, fake_circup):
    src = tmp_path / "proj" / "src"
    src.mkdir(parents=True)
    with pytest.raises(libraries.LibraryError, match="no_boot_out"):
        await libraries.list_installed("circuitpython", src)
    (src / "boot_out.txt").write_text("Adafruit CircuitPython 9.2.1\n")
    libs = await libraries.list_installed("circuitpython", src)
    assert libs == [{"name": "adafruit_bme280", "version": "2.6.0", "latest": "2.6.27", "outdated": True, "reason": "Minor Version"}]
    assert await libraries.search("circuitpython", src, "bme") == ["adafruit_bme280"]
    await libraries.install("circuitpython", src, ["adafruit_bme280"])
    await libraries.update("circuitpython", src)
    await libraries.uninstall("circuitpython", src, ["adafruit_bme280"])
    calls = fake_circup.read_text().splitlines()
    assert all(c.startswith(f"--path {src} ") for c in calls)
    assert calls[-3:] == [f"--path {src} install adafruit_bme280", f"--path {src} update --all", f"--path {src} uninstall adafruit_bme280"]
    with pytest.raises(libraries.LibraryError, match="invalid_name"):
        await libraries.install("circuitpython", src, ["--evil"])


async def test_mip_into_mirror(tmp_path):
    """mpremote's own mip code with the mirror transport, offline via a local package.json."""
    import json

    from boady import mip_mirror

    pkg = tmp_path / "pkgsrc"
    (pkg / "mypkg").mkdir(parents=True)
    (pkg / "mypkg" / "__init__.py").write_text("X = 1\n")
    (pkg / "single.py").write_text("Y = 2\n")
    (pkg / "package.json").write_text(json.dumps({"urls": [["mypkg/__init__.py", "mypkg/__init__.py"], ["single.py", "single.py"]], "version": "0.1"}))
    src = tmp_path / "proj" / "src"
    src.mkdir(parents=True)
    with pytest.raises(libraries.LibraryError, match="invalid_name"):  # local files are refused
        await libraries.install("micropython", src, [str(pkg / "package.json")], None)
    res = await mip_mirror.install(src, str(pkg / "package.json"), None, None)
    assert "Installing" in res["log"] and sorted(res["written"]) == ["lib/mypkg/__init__.py", "lib/single.py"]
    assert (src / "lib" / "mypkg" / "__init__.py").read_text() == "X = 1\n"
    assert (src / "lib" / "single.py").read_text() == "Y = 2\n"
    names = [e["name"] for e in await libraries.list_installed("micropython", src)]
    assert names == ["mypkg", "single"]
    await libraries.uninstall("micropython", src, ["mypkg"])
    assert not (src / "lib" / "mypkg").exists()
    with pytest.raises(libraries.LibraryError, match="not_available"):
        await libraries.update("micropython", src)


def test_mirror_transport(tmp_path):
    from boady.mip_mirror import MirrorTransport
    from mpremote.commands import CommandError

    t = MirrorTransport(tmp_path, 0x0A06)
    assert t.eval("getattr(sys.implementation, '_mpy', 0) & 0xFF") == 6
    assert MirrorTransport(tmp_path, None).eval("x") == 0
    t.fs_writefile("lib/a.py", b"abc")
    import hashlib

    assert t.fs_hashfile("lib/a.py", "sha256") == hashlib.sha256(b"abc").digest()
    with pytest.raises(FileNotFoundError):
        t.fs_hashfile("lib/none.py", "sha256")
    with pytest.raises(CommandError):
        t.fs_writefile("../escape.py", b"x")



async def test_library_work_refuses_a_linked_lib(tmp_path, fake_circup):
    """Review 4, finding 4: uninstalling through a linked src/lib deleted a file outside the project."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "sensor.py").write_text("keep")
    src = tmp_path / "proj" / "src"
    src.mkdir(parents=True)
    (src / "boot_out.txt").write_text("Adafruit CircuitPython 9.2.1\n")
    (src / "lib").symlink_to(outside)
    for call in (
        libraries.uninstall("micropython", src, ["sensor"]),
        libraries.list_installed("micropython", src),
        libraries.install("micropython", src, ["aioble"], None),
        libraries.install("circuitpython", src, ["adafruit_bme280"]),
        libraries.update("circuitpython", src),
        libraries.uninstall("circuitpython", src, ["sensor"]),
    ):
        with pytest.raises(libraries.LibraryError, match="symlink_in_lib"):
            await call
    assert (outside / "sensor.py").read_text() == "keep"
    assert not fake_circup.exists() or "install" not in fake_circup.read_text()


async def test_library_work_refuses_a_link_inside_lib(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.py").write_text("keep")
    src = tmp_path / "proj" / "src"
    (src / "lib").mkdir(parents=True)
    (src / "lib" / "pkg").symlink_to(outside)
    with pytest.raises(libraries.LibraryError, match="lib/pkg"):
        await libraries.uninstall("micropython", src, ["pkg"])
    assert (outside / "x.py").exists()
