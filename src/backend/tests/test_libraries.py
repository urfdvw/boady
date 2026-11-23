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
    with pytest.raises(libraries.LibraryError, match="not_available"):
        await libraries.install("micropython", src, ["x"])
