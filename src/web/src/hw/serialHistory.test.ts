import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import { SerialHistory } from "./serialHistory";

describe("SerialHistory", () => {
  it("replays everything and follows new chunks", () => {
    const h = new SerialHistory();
    h.push(utf8("a"));
    const seen: (string | null)[] = [];
    const off = h.subscribe((b) => seen.push(b && new TextDecoder().decode(b)));
    h.push(utf8("b"));
    expect(h.text()).toBe("ab");
    h.clear();
    expect(seen).toEqual(["b", null]);
    expect(h.text()).toBe("");
    off();
    h.push(utf8("c"));
    expect(seen).toEqual(["b", null]);
  });

  it("drops the oldest chunks beyond the limit", () => {
    const h = new SerialHistory(5);
    h.push(utf8("123"));
    h.push(utf8("456"));
    expect(h.text()).toBe("456");
  });
});
