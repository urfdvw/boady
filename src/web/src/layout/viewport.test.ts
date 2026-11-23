import { describe, expect, it } from "vitest";
import { nextViewport } from "./viewport";

const phone = { w: 400, h: 800 };
const kb = { editableFocused: true, touch: true, rotated: false };

describe("viewport", () => {
  it("keyboard does not flip portrait into landscape", () => {
    const r = nextViewport(phone, 400, 350, kb); // now wider than tall
    expect(r.info).toEqual({ landscape: false, keyboard: true });
    expect(r.ref).toEqual(phone);
  });

  it("keyboard closing restores split", () => {
    const r = nextViewport(phone, 400, 800, { ...kb, editableFocused: false });
    expect(r.info).toEqual({ landscape: false, keyboard: false });
  });

  it("rotation re-evaluates orientation", () => {
    const r = nextViewport(phone, 800, 400, { ...kb, rotated: true });
    expect(r.info).toEqual({ landscape: true, keyboard: false });
  });

  it("desktop window resize uses width > height", () => {
    const r = nextViewport({ w: 1200, h: 800 }, 600, 800, { editableFocused: false, touch: false, rotated: false });
    expect(r.info.landscape).toBe(false);
    const r2 = nextViewport({ w: 1200, h: 800 }, 1200, 300, { editableFocused: true, touch: false, rotated: false });
    expect(r2.info).toEqual({ landscape: true, keyboard: false });
  });
});
