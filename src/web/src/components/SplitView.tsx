import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  panes: ReactNode[]; // 1 or 2, already in tab order
  landscape: boolean;
  keyboard: boolean;
}

/**
 * Two equal halves: top/bottom in portrait, left/right in landscape. In a
 * portrait split with the soft keyboard open only the half holding the
 * focused input is shown.
 */
export function SplitView({ panes, landscape, keyboard }: Props) {
  const refs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const [focusPane, setFocusPane] = useState<number | null>(null);

  useEffect(() => {
    const onFocus = () => {
      const el = document.activeElement;
      const idx = refs.findIndex((r) => r.current && el && r.current.contains(el));
      setFocusPane(idx >= 0 ? idx : null);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const split = panes.length === 2;
  const collapse = split && !landscape && keyboard && focusPane !== null;

  return (
    <div className={`split ${landscape ? "split-row" : "split-col"}`}>
      {panes.map((p, i) => (
        <div key={i} ref={refs[i]} className="pane" style={collapse && focusPane !== i ? { display: "none" } : undefined}>
          {p}
        </div>
      ))}
    </div>
  );
}
