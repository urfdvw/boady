import { describe, expect, it } from "vitest";
import { initialTabs, sanitize, selectOne, selectTwo, selectWithModifier, visibleOpen } from "./tabs";

describe("tab rules", () => {
  it("single click opens only that tab and leaves split", () => {
    let s = selectTwo(initialTabs(), "chat", "serial");
    s = selectOne(s, "files");
    expect(s.open).toEqual(["files"]);
    expect(s.recent[0]).toBe("files");
  });

  it("two-finger press opens both in tab order", () => {
    const s = selectTwo(initialTabs(), "serial", "chat");
    expect(s.open).toEqual(["chat", "serial"]);
    expect(s.recent.slice(0, 2).sort()).toEqual(["chat", "serial"]);
  });

  it("ctrl click opens the two most recently selected tabs", () => {
    let s = selectOne(initialTabs(), "files"); // recent: files, chat, ...
    s = selectOne(s, "serial"); // recent: serial, files, chat
    s = selectWithModifier(s, "chat"); // recent: chat, serial
    expect(s.open).toEqual(["chat", "serial"]);
    s = selectWithModifier(s, "version"); // recent: version, chat
    expect(s.open).toEqual(["chat", "version"]);
  });

  it("ctrl click on the tab already open alone changes nothing", () => {
    const s = selectOne(initialTabs(), "files");
    expect(selectWithModifier(s, "files")).toBe(s);
  });

  it("ctrl click on a tab of the open pair keeps a pair", () => {
    let s = selectTwo(initialTabs(), "chat", "serial");
    s = selectWithModifier(s, "chat");
    expect(s.open).toEqual(["chat", "serial"]);
  });

  it("order follows tab order, never selection order", () => {
    const s = selectTwo(initialTabs(), "settings", "files");
    expect(s.open).toEqual(["files", "settings"]);
  });

  it("sanitize restores bad persisted state", () => {
    expect(sanitize(null)).toEqual(initialTabs());
    const s = sanitize({ open: ["plot", "bogus", "chat"], recent: ["plot"] });
    expect(s.open).toEqual(["chat", "plot"]);
    expect(s.recent).toHaveLength(9);
  });

  it("hides the Emulator tab outside test projects (D42)", () => {
    let s = selectTwo(initialTabs(), "serial", "emulator");
    expect(s.open).toEqual(["serial", "emulator"]);
    expect(visibleOpen(s, ["emulator"])).toEqual(["serial"]);
    expect(visibleOpen(selectOne(s, "emulator"), ["emulator"])).toEqual(["chat"]);
    // Ctrl-click never opens a hidden tab even if it was selected recently
    s = selectWithModifier(s, "files", ["emulator"]);
    expect(s.open).toEqual(["files", "serial"]);
  });
});
