# boady

Your microcontroller coding buddy.

boady lets you do agent coding for **CircuitPython** and **MicroPython** boards with Claude Code, from a computer or an Android phone. Claude Code runs in a small backend on your own device and signs in with your Claude subscription (no API key). The web frontend shows the conversation and, in later releases, talks to your board over USB.

> Status: phase 3 of 5 — chat, files, git, settings, and CircuitPython and MicroPython boards over USB in desktop Chrome (serial console, sync, plotter, libraries). The Android app comes in phases 4–5. See `Specs/additional_specs.md`.

## Install (computer)

Requirements: Python 3.10+, git, and a working [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI that is logged in (`claude` on your PATH). `gh` is optional, for creating GitHub repositories.

```bash
git clone https://github.com/urfdvw/boady.git
```

```bash
cd boady && pip install -r src/backend/requirements.txt
```

```bash
python run.py
```

`run.py` prints a pairing code and a link like `http://127.0.0.1:8765/#token=…`. Open the link in Chrome; the page remembers the code. To see the code again: `python run.py --show-token`. The backend only listens on 127.0.0.1.

## Using boady

- **Projects page**: create a project (name + CircuitPython or MicroPython, optionally a private GitHub repo), clone an existing repository, open or delete projects. Each project is a git repository under `~/.boady/projects/` with this layout:

  ```
  <project>/
  ├── src/        # goes to the board (code.py / main.py, lib/, CIRCUIT.md)
  ├── boady.json  # project type, fixed at creation
  ├── CLAUDE.md   # references and general way of working
  ├── DESIGN.md   # goals and architecture
  └── README.md
  ```

- **Tabs**: Chat, Files, Version, Serial, Plot, Library, Device, Settings. Click a tab to open it; on a computer Ctrl/Cmd-click opens the two most recently used tabs side by side; on a touch screen press two tabs with two fingers. Landscape puts the tab bar on top and splits left/right; portrait puts it on the left and splits top/bottom.
- **Chat**: Claude edits the project mirror. Reading and editing inside the project is automatic; anything outside the project, git commands that change history, and uploads to the board ask for your approval in the chat. Stop a turn with the stop button.
- **Version**: see changed files and their diff, commit, reset one file or everything, push (or create a GitHub repo). boady never commits or pushes on its own.
- **Connecting a board** (desktop Chrome): Device tab → **Connect board** and pick the board's serial port. boady asks Claude to identify the board (UID, runtime, firmware), opens the project bound to that board (or asks you to choose / create one), and pulls the board's files into `src/` — they show up as changes in the Version tab for you to commit or reset. If `src/` has uncommitted edits you are asked first.
  - CircuitPython data port: after enabling it in `boot.py`, click **Add data port** and pick the second interface.
  - CircuitPython drive: click **Choose CIRCUITPY drive** once; syncs then go through the mounted drive instead of the serial port.
- **Syncing**: editing never touches the board. Use **Sync to board** in the Device tab, or let Claude call `sync_to_device` (it asks for approval). Only changed files are written; files missing from `src/` are deleted on the board.
- **Serial**: REPL (and data) console with Ctrl-C / Ctrl-D; read-only while Claude is using the port or a sync runs.
- **Plot**: prints like `(1.2, 3.4)` on the REPL become live curves (Mu editor convention).
- **Library**: CircuitPython uses circup (bundle names); MicroPython uses mip (micropython-lib names, `github:org/repo` or a URL). Libraries are installed into `src/lib` and reach the board with the next sync.
- **Emulator (testing only)**: no board at hand? Device tab → **Start emulator** runs a virtual Raspberry Pi Pico with the official MicroPython or CircuitPython firmware (matching the project type) in the browser. It behaves like a connected board (identification, sync, console, plot) but has no real pins, no CIRCUITPY drive and runs slower than a real Pico. Its files and UID stay in the browser; **Reset emulator storage** erases its files.
- **Settings**: language (English / 中文), account status, pairing code reset, project list.

Your conversation is tied to the project: closing the browser or restarting the backend resumes the same Claude session.

## Development

See `CLAUDE.md` for build and test commands and `Specs/specs.md` for the architecture.
