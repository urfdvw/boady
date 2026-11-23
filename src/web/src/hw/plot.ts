/**
 * Plotter input, Mu editor convention: a line that is a tuple of numbers, e.g.
 * "(1.2, 3.4)", is one data point; position i in the tuple is series i.
 */
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function parsePlotLine(line: string): number[] | null {
  const s = line.trim();
  if (s.length < 3 || s[0] !== "(" || s[s.length - 1] !== ")") return null;
  const parts = s.slice(1, -1).split(",").map((p) => p.trim());
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); // "(1,)"
  if (!parts.length || !parts.every((p) => NUM.test(p))) return null;
  return parts.map(Number);
}

/** Splits a stream into complete lines and keeps the last N points. */
export class PlotBuffer {
  points: number[][] = [];
  private partial = "";
  constructor(private max = 500) {}

  feed(text: string): boolean {
    const chunks = (this.partial + text).split(/\r?\n|\r/);
    this.partial = chunks.pop() ?? "";
    let added = false;
    for (const line of chunks) {
      const v = parsePlotLine(line);
      if (v) {
        this.points.push(v);
        added = true;
      }
    }
    if (this.points.length > this.max) this.points.splice(0, this.points.length - this.max);
    return added;
  }

  clear(): void {
    this.points = [];
    this.partial = "";
  }
}
