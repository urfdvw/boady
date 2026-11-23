import { useEffect, useState } from "react";

/**
 * Orientation and soft-keyboard detection.
 *
 * Landscape = layout viewport wider than tall. The decision is made from the
 * window size before the keyboard opens and is only re-evaluated on rotation
 * or a real window resize — never because the keyboard shrank the height.
 */
export interface ViewportInfo {
  landscape: boolean;
  keyboard: boolean;
}

const isEditable = (el: Element | null): boolean =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

/**
 * Pure decision used by the hook (exported for tests). ``prev`` is the last
 * size measured without the keyboard; it stays the reference while the
 * keyboard is open.
 */
export function nextViewport(
  prev: { w: number; h: number },
  w: number,
  h: number,
  opts: { editableFocused: boolean; touch: boolean; rotated: boolean },
): { ref: { w: number; h: number }; info: ViewportInfo } {
  // Width unchanged but height shrunk on a touch device: the soft keyboard (or
  // its close animation). Keep the pre-keyboard orientation.
  if (!opts.rotated && w === prev.w && opts.touch && h < prev.h - 120) {
    return { ref: prev, info: { landscape: prev.w > prev.h, keyboard: opts.editableFocused } };
  }
  return { ref: { w, h }, info: { landscape: w > h, keyboard: false } };
}

export function useViewport(): ViewportInfo {
  const [info, setInfo] = useState<ViewportInfo>(() => ({ landscape: window.innerWidth > window.innerHeight, keyboard: false }));

  useEffect(() => {
    let ref = { w: window.innerWidth, h: window.innerHeight };
    let rotated = false;
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const update = () => {
      const nxt = nextViewport(ref, window.innerWidth, window.innerHeight, {
        editableFocused: isEditable(document.activeElement),
        touch,
        rotated,
      });
      rotated = false;
      ref = nxt.ref;
      setInfo((old) => (old.landscape === nxt.info.landscape && old.keyboard === nxt.info.keyboard ? old : nxt.info));
    };
    const onRotate = () => {
      rotated = true;
      setTimeout(update, 50);
    };
    const onFocusOut = () => setTimeout(update, 100);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", onRotate);
    screen.orientation?.addEventListener?.("change", onRotate);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", onRotate);
      screen.orientation?.removeEventListener?.("change", onRotate);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  return info;
}
