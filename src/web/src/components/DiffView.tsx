export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diff">
      {lines.map((l, i) => {
        let cls = "";
        if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) cls = "d-meta";
        else if (l.startsWith("@@")) cls = "d-hunk";
        else if (l.startsWith("+")) cls = "d-add";
        else if (l.startsWith("-")) cls = "d-del";
        return (
          <div key={i} className={cls}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
