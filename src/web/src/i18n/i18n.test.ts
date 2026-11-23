import { describe, expect, it } from "vitest";
import en from "./en.json";
import zh from "./zh.json";
import { translate, translateError } from "./index";

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
});
