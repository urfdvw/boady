import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";

interface Props {
  path: string;
  value: string;
  onChange(text: string): void;
}

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches;

/** CodeMirror 6 editor; Python highlighting for .py files. */
export function CodeEditor({ path, value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const extensions = [
      basicSetup,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) changeRef.current(u.state.doc.toString());
      }),
    ];
    if (path.endsWith(".py")) extensions.push(python());
    if (dark()) extensions.push(oneDark);
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current });
    view.current = v;
    return () => v.destroy();
    // re-create only when the file changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="editor" ref={host} />;
}
