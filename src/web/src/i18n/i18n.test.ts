import { describe, expect, it } from "vitest";
import en from "./en.json";
import zh from "./zh.json";
import { translate, translateError, translateNotice } from "./index";

describe("i18n", () => {
  it("both languages define the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("placeholders match between languages", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) || []).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(vars((zh as any)[k]), k).toEqual(vars(en[k]));
    }
  });

  it("substitutes variables and translates errors", () => {
    expect(translate("en", "chat.permTitle", { tool: "Write" })).toBe("Claude wants to use Write");
    expect(translateError("zh", "name_taken")).toBe("已有同名项目。");
    expect(translateError("en", "boom")).toBe("Error: boom");
  });

  it("keeps the detail after a known error code", () => {
    // the device label shows this: Claude's answer must not be swallowed
    expect(translateError("en", "identify_failed: You've hit your 5-hour limit")).toBe(
      "Could not identify the board. (You've hit your 5-hour limit)",
    );
    expect(translateError("zh", "case_collision: the board has both 'a.py' and 'A.py'")).toContain("'a.py' and 'A.py'");
  });

  it("translates backend notices (review 10, coverage)", () => {
    const pulled = 'pulled: {"added": ["a.py"], "modified": [], "deleted": ["b.py", "c.py"], "channel": "serial", "program_stopped": true}';
    expect(translateNotice("en", pulled)).toBe("Pulled the board files into src/: 1 added, 0 modified, 2 deleted.");
    expect(translateNotice("en", "pulled: not json")).toBe("pulled: not json");
    expect(translateNotice("en", "pull_failed: Device not connected.")).toBe("Could not pull from the board: Device not connected.");
    expect(translateNotice("zh", "pull_declined")).toBe(translate("zh", "notice.pull_declined"));
    expect(translateNotice("en", "Claude Code could not start: boom")).toBe("Claude Code could not start: boom"); // unknown: as is
  });
});
