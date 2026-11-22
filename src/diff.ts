type DiffableFile = {
  content: string;
  path: string;
};

export type DiffLine = {
  kind: "added" | "removed" | "same";
  text: string;
};

export type FileDiff = {
  addedLines: number;
  lines: DiffLine[];
  path: string;
  removedLines: number;
  status: "added" | "modified" | "removed";
};

export function buildLineDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lengths = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0),
  );

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        beforeLines[i] === afterLines[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      diff.push({ kind: "same", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      diff.push({ kind: "removed", text: beforeLines[i] });
      i += 1;
    } else {
      diff.push({ kind: "added", text: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    diff.push({ kind: "removed", text: beforeLines[i] });
    i += 1;
  }

  while (j < afterLines.length) {
    diff.push({ kind: "added", text: afterLines[j] });
    j += 1;
  }

  return diff;
}

export function buildFileDiff(beforeFiles: DiffableFile[], afterFiles: DiffableFile[]) {
  const beforeByPath = new Map(beforeFiles.map((file) => [file.path, file]));
  const afterByPath = new Map(afterFiles.map((file) => [file.path, file]));
  const paths = Array.from(new Set([...beforeByPath.keys(), ...afterByPath.keys()])).sort();

  return paths.flatMap((path): FileDiff[] => {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);

    if (before?.content === after?.content) {
      return [];
    }

    const lines = buildLineDiff(before?.content ?? "", after?.content ?? "");
    return [
      {
        addedLines: lines.filter((line) => line.kind === "added").length,
        lines,
        path,
        removedLines: lines.filter((line) => line.kind === "removed").length,
        status: before ? (after ? "modified" : "removed") : "added",
      },
    ];
  });
}
