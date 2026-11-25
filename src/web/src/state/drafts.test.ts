import { describe, expect, it } from "vitest";
import { getOpen, hasUnsaved, isDirty, readApplies, setOpen } from "./drafts";

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

describe("late read answers (review 2, finding 4)", () => {
  const ticket = { seq: 1, path: "src/code.py", text: "v1", opening: false };
  it("never overwrite text typed while the read was pending", () => {
    expect(readApplies(ticket, { seq: 1, path: "src/code.py", text: "v1 typed", saved: "v1" })).toBe(false);
  });
  it("are ignored when a newer read started", () => {
    expect(readApplies(ticket, { seq: 2, path: "src/code.py", text: "v1", saved: "v1" })).toBe(false);
  });
  it("are ignored when another file is open now", () => {
    expect(readApplies(ticket, { seq: 1, path: "src/other.py", text: "v1", saved: "v1" })).toBe(false);
  });
  it("apply to a clean, unchanged editor", () => {
    expect(readApplies(ticket, { seq: 1, path: "src/code.py", text: "v1", saved: "v1" })).toBe(true);
    expect(readApplies({ ...ticket, opening: true, path: "src/new.py" }, { seq: 1, path: "src/code.py", text: "v1", saved: "v1" })).toBe(true);
  });
});
