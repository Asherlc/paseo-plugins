export interface Passage {
  firstLine: number;
  lastLine: number;
  quote: string;
}

export interface Selection {
  start: number;
  end: number;
}

export function selectedPassage(source: string, { start, end }: Selection): Passage | undefined {
  if (start < 0 || end > source.length || start >= end) return;
  return {
    firstLine: source.slice(0, start).split("\n").length,
    lastLine: source.slice(0, end - 1).split("\n").length,
    quote: source.slice(start, end),
  };
}

export function linesPassage(lines: string[], range: string): Passage | undefined {
  const match = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/.exec(range);
  if (!match) return;
  const firstLine = Number(match[1]);
  const lastLine = Number(match[2] ?? match[1]);
  if (firstLine < 1 || lastLine < firstLine || lastLine > lines.length) return;
  return { firstLine, lastLine, quote: lines.slice(firstLine - 1, lastLine).join("\n") };
}

export function lineLabel({ firstLine, lastLine }: Passage): string {
  return firstLine === lastLine ? `Line ${firstLine}` : `Lines ${firstLine}–${lastLine}`;
}

export function workspacePath(path: string, directory?: string | null): string {
  if (!directory) return path;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(directory);
  const file = windows ? path.replace(/\\/g, "/") : path;
  const root = (windows ? directory.replace(/\\/g, "/") : directory).replace(/\/+$/, "") + "/";
  const isInside = windows
    ? file.toLowerCase().startsWith(root.toLowerCase())
    : file.startsWith(root);
  return isInside ? file.slice(root.length) : path;
}

export function formatAnnotation(path: string, passage: Passage, comment: string): string {
  const quote = passage.quote.split("\n").map((line) => `> ${line}`).join("\n");
  return `Markdown annotation for ${JSON.stringify(path)} · ${lineLabel(passage)}\n\n${quote}\n\nComment\n${comment.trim()}`;
}
