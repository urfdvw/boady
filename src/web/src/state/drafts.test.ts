import { describe, expect, it } from "vitest";
import { getOpen, hasUnsaved, isDirty, setOpen } from "./drafts";

describe("drafts (review finding 4)", () => {
  it("keeps the unsaved text per project after the Files tab unmounts", () => {
    setOpen("p1", { path: "src/code.py", file: { text: "a" }, text: "a edited", saved: "a" });
    setOpen("p2", null);
    expect(getOpen("p1")?.text).toBe("a edited");
    expect(isDirty(getOpen("p1"))).toBe(true);
    expect(getOpen("p2")).toBeNull();
    expect(hasUnsaved()).toBe(true);
    setOpen("p1", { path: "src/code.py", file: { text: "a edited" }, text: "a edited", saved: "a edited" });
    expect(hasUnsaved()).toBe(false);
  });
});
