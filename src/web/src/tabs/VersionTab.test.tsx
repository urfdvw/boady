// @vitest-environment happy-dom
/** Version tab: a late diff answer for a file no longer selected is dropped (review 13, finding 4). */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { Backend } from "../backend";
import { I18nContext, translate } from "../i18n";
import { VersionTab } from "./VersionTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows the diff of the selected file even when an older request answers last", async () => {
  const pending: Record<string, (v: { diff: string }) => void> = {};
  const backend = {
    state: { git: { status: [{ path: "src/a.py", status: "modified" }, { path: "src/b.py", status: "modified" }], log: [], remotes: [] } },
    action: (_name: string, p: { path: string }) => new Promise((res) => (pending[p.path] = res)),
  } as unknown as Backend;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <I18nContext.Provider value={{ lang: "en", t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) } as any}>
        <VersionTab backend={backend} />
      </I18nContext.Provider>,
    ),
  );
  const pick = (path: string) => act(() => ([...host.querySelectorAll("button.change")].find((b) => b.textContent?.includes(path)) as HTMLElement).click());
  pick("src/a.py");
  pick("src/b.py");
  await act(async () => pending["src/b.py"]({ diff: "--- b\n+++ b\n@@ -1 +1 @@\n-B0\n+B1\n" }));
  await act(async () => pending["src/a.py"]({ diff: "--- a\n+++ a\n@@ -1 +1 @@\n-A0\n+A1\n" })); // late
  expect(host.textContent).toContain("Diff: src/b.py");
  expect(host.textContent).toContain("B1");
  expect(host.textContent).not.toContain("A1");
  act(() => root.unmount());
  host.remove();
});
