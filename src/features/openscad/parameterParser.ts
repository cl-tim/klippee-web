import type {
  OpenScadParameter,
  OpenScadParameterOption,
  OpenScadParameterValue,
} from "./types";

const assignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(true|false|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|"(?:[^"\\]|\\.)*")\s*;\s*(?:\/\/\s*(.*))?$/;
const groupPattern = /^\s*\/\*\s*\[([^\]]+)]\s*\*\/\s*$/;
const lineCommentPattern = /^\s*\/\/\s*(.*?)\s*$/;
const blockCommentPattern = /^\s*\/\*\s*(.*?)\s*\*\/\s*$/;
const rangePattern = /^\[\s*([-+]?\d*\.?\d+)\s*:\s*(?:(\d*\.?\d+)\s*:\s*)?([-+]?\d*\.?\d+)\s*]$/;
const optionsPattern = /^\[([^\]]+)]$/;

function humanize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function parseValue(value: string): OpenScadParameterValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return Number(value);
}

function parseOptionValue(value: string): OpenScadParameterValue {
  const trimmed = value.trim();
  if (/^(?:true|false)$/.test(trimmed)) return trimmed === "true";
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^"|"$/g, "");
}

function parseOptions(metadata: string): OpenScadParameterOption[] | undefined {
  const match = metadata.match(optionsPattern);
  if (!match || metadata.match(rangePattern)) return undefined;
  const options = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 0) {
        const value = parseOptionValue(entry);
        return { label: String(value), value };
      }
      const value = parseOptionValue(entry.slice(0, separator));
      return { label: entry.slice(separator + 1).trim(), value };
    });
  return options.length ? options : undefined;
}

export function parseOpenScadParameters(source: string): OpenScadParameter[] {
  const parameters: OpenScadParameter[] = [];
  let group = "Parameters";
  let pendingDescription: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const groupMatch = line.match(groupPattern);
    if (groupMatch) {
      group = groupMatch[1].trim();
      pendingDescription = [];
      continue;
    }
    if (group.toLowerCase() === "hidden") {
      pendingDescription = [];
      continue;
    }

    const comment = line.match(lineCommentPattern)?.[1] ?? line.match(blockCommentPattern)?.[1];
    if (comment !== undefined) {
      if (comment.trim()) pendingDescription.push(comment.trim());
      continue;
    }

    if (!line.trim()) {
      pendingDescription = [];
      continue;
    }

    const assignment = line.match(assignmentPattern);
    if (!assignment) {
      pendingDescription = [];
      continue;
    }
    const [, key, rawDefault, rawMetadata = ""] = assignment;
    const defaultValue = parseValue(rawDefault);
    const metadata = rawMetadata.trim();
    const range = metadata.match(rangePattern);
    const options = parseOptions(metadata);
    const inlineDescription = metadata && !range && !options ? metadata : "";
    const description = [...pendingDescription, inlineDescription].filter(Boolean).join(" ") || undefined;
    pendingDescription = [];

    if (typeof defaultValue === "boolean") {
      parameters.push({ defaultValue, description, group, key, label: humanize(key), type: "boolean" });
    } else if (options) {
      parameters.push({ defaultValue, description, group, key, label: humanize(key), options, type: "select" });
    } else if (typeof defaultValue === "number") {
      const min = range ? Number(range[1]) : undefined;
      const max = range ? Number(range[3]) : undefined;
      const step = range ? Number(range[2] || Math.max((Number(range[3]) - Number(range[1])) / 100, 0.01)) : undefined;
      parameters.push({ defaultValue, description, group, key, label: humanize(key), max, min, step, type: "number" });
    } else {
      parameters.push({ defaultValue, description, group, key, label: humanize(key), type: "text" });
    }
  }
  return parameters;
}

export function defaultOpenScadParameterValues(parameters: OpenScadParameter[]) {
  return Object.fromEntries(parameters.map((parameter) => [parameter.key, parameter.defaultValue]));
}

export function openScadDefinition(key: string, value: OpenScadParameterValue) {
  return `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`;
}
