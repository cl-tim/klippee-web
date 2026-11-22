import type { EditorValueSelection, EditorVariableReferenceSelection, VariableType } from "./types";

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function sectionBefore(content: string, offset: number) {
  const lines = content.slice(0, offset).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const section = lines[index].match(/^\s*\[([^\]]+)\]/)?.[1];
    if (section) return slugify(section);
  }
  return "";
}

function trimRange(content: string, from: number, to: number) {
  while (from < to && /\s/.test(content[from])) from += 1;
  while (to > from && /\s/.test(content[to - 1])) to -= 1;
  return { from, to };
}

export function selectionForVariable(content: string, anchor: number, head: number): EditorValueSelection | null {
  let from = Math.max(0, Math.min(anchor, head, content.length));
  let to = Math.max(0, Math.min(Math.max(anchor, head), content.length));
  if (from === to) return null;

  const lineStart = content.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const nextLineBreak = content.indexOf("\n", from);
  const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
  if (to > lineEnd + 1) return null;

  const lineText = content.slice(lineStart, lineEnd);
  if (!lineText.trim() || lineText.trimStart().startsWith("#") || /^\s*\[[^\]]+\]\s*$/.test(lineText)) return null;

  const commentIndex = lineText.indexOf("#");
  const contentEnd = commentIndex === -1 ? lineText.length : commentIndex;
  const separatorMatch = lineText.slice(0, contentEnd).match(/[:=]/);
  const separatorIndex = separatorMatch?.index ?? -1;
  const absoluteContentEnd = lineStart + contentEnd;
  let optionName = "selected_value";

  if (separatorIndex >= 0) {
    optionName = slugify(lineText.slice(0, separatorIndex)) || optionName;
    const valueRange = trimRange(content, lineStart + separatorIndex + 1, absoluteContentEnd);
    if (valueRange.from === valueRange.to) return null;

    if (from <= lineStart + separatorIndex || to > valueRange.to) {
      from = valueRange.from;
      to = valueRange.to;
    } else {
      ({ from, to } = trimRange(content, from, Math.min(to, valueRange.to)));
      if (from < valueRange.from || from === to) return null;
    }
  } else {
    ({ from, to } = trimRange(content, from, Math.min(to, absoluteContentEnd)));
    if (from === to) return null;
  }

  const value = content.slice(from, to);
  if (!value || value.includes("\n") || value.includes("${KLIPPEE:")) return null;
  const section = sectionBefore(content, lineStart);
  const suggestedName = slugify([section, optionName].filter(Boolean).join("_")) || "selected_value";
  const line = content.slice(0, lineStart).split("\n").length;
  return { from, line, suggestedName, to, value };
}

export function variableReferenceForSelection(
  content: string,
  anchor: number,
  head: number,
): EditorVariableReferenceSelection | null {
  const from = Math.max(0, Math.min(anchor, head, content.length));
  const to = Math.max(0, Math.min(Math.max(anchor, head), content.length));
  if (from === to) return null;

  const lineStart = content.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const nextLineBreak = content.indexOf("\n", from);
  const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
  if (to > lineEnd + 1) return null;

  const matches = Array.from(content.slice(lineStart, lineEnd).matchAll(/\$\{KLIPPEE:([a-z][a-z0-9_]*)\}/g))
    .map((match) => {
      const matchFrom = lineStart + (match.index ?? 0);
      return {
        from: matchFrom,
        line: content.slice(0, lineStart).split("\n").length,
        name: match[1],
        to: matchFrom + match[0].length,
      };
    })
    .filter((match) => from < match.to && to > match.from);

  return matches.length === 1 ? matches[0] : null;
}

export function uniqueVariableName(suggestedName: string, existingNames: Iterable<string>) {
  const used = new Set(existingNames);
  const base = slugify(suggestedName) || "selected_value";
  const validBase = /^[a-z]/.test(base) ? base : `value_${base}`;
  let name = validBase;
  let suffix = 2;
  while (used.has(name)) {
    name = `${validBase}_${suffix}`;
    suffix += 1;
  }
  return name;
}

export function inferSelectedVariableType(value: string, name: string): VariableType {
  if (/(?:^|_)(?:password|passwd|token|secret|api_key|bearer)(?:_|$)/.test(name)) return "secret";
  if (/^\/dev\//.test(value)) return "device-path";
  if (/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(value)) return "ip-address";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return "number";
  if (/^(?:true|false)$/i.test(value)) return "boolean";
  return "string";
}
