/**
 * Minimal terminal model for the serial console: handles \r\n, lone \r
 * (return to line start), \b (cursor left, as REPL echo uses), and strips
 * ANSI CSI sequences and OSC sequences (CircuitPython writes its status bar
 * as an OSC window title).
 */
export class Terminal {
  lines: string[] = [""];
  private col = 0;
  private esc = ""; // pending escape sequence
  constructor(private maxLines = 2000) {}

  write(text: string): void {
    for (const ch of text) {
      if (this.esc) {
        this.esc += ch;
        if (this.escDone()) this.esc = "";
        continue;
      }
      const last = this.lines.length - 1;
      switch (ch) {
        case "\x1b":
          this.esc = ch;
          break;
        case "\n":
          this.lines.push("");
          this.col = 0;
          break;
        case "\r":
          this.col = 0;
          break;
        case "\b":
          this.col = Math.max(0, this.col - 1);
          break;
        default: {
          if (ch < " " && ch !== "\t") break;
          const line = this.lines[last];
          this.lines[last] = line.slice(0, this.col).padEnd(this.col, " ") + ch + line.slice(this.col + 1);
          this.col++;
        }
      }
    }
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  private escDone(): boolean {
    const s = this.esc;
    if (s.length < 2) return false;
    if (s[1] === "[") {
      // CSI: ESC [ params final(0x40-0x7e); handle "erase to end of line"
      const last = s[s.length - 1];
      if (s.length > 2 && last >= "@" && last <= "~") {
        if (last === "K") {
          const i = this.lines.length - 1;
          this.lines[i] = this.lines[i].slice(0, this.col);
        }
        return true;
      }
      return false;
    }
    if (s[1] === "]") return s.endsWith("\x07") || s.endsWith("\x1b\\");
    return true; // two-byte escape
  }

  clear(): void {
    this.lines = [""];
    this.col = 0;
  }

  text(): string {
    return this.lines.join("\n");
  }
}
