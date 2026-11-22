import { renderTemplateContent } from "../src/templateRendering";
import type { StoredConfigFile, VariableValues } from "./types";

const variablePlaceholderPattern = /\$\{KLIPPEE:[a-z][a-z0-9_]*\}/;
const variablePlaceholderNamesPattern = /\$\{KLIPPEE:([a-z][a-z0-9_]*)\}/g;
const likelySecretVariableNamePattern = /(?:^|_)(?:api_?key|bearer|pass(?:word|wd)?|secret|token)(?:_|$)/i;
const sectionHeaderPattern = /^\s*(\[[^\]\r\n]+\])\s*(?:#.*)?$/;
const optionLinePattern = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*[:=]/;
const commandLinePattern = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\b/;
const rootScope = "<root>";

type ContentLine = {
  body: string;
  ending: string;
};

type SemanticContentLine = ContentLine & {
  anchor: string;
  group: string;
  scope: string;
};

type CaptureProtectionOptions = {
  protectAllPlaceholders?: boolean;
};

function contentLines(content: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "\r" && character !== "\n") {
      continue;
    }
    const ending = character === "\r" && content[index + 1] === "\n" ? "\r\n" : character;
    lines.push({ body: content.slice(start, index), ending });
    if (ending === "\r\n") {
      index += 1;
    }
    start = index + 1;
  }
  if (start < content.length || content.length === 0) {
    lines.push({ body: content.slice(start), ending: "" });
  }
  return lines;
}

function semanticToken(body: string) {
  const option = body.match(optionLinePattern)?.[1];
  if (option) {
    return `option:${option.toLowerCase()}`;
  }
  if (!body.trim() || body.trimStart().startsWith("#")) {
    return "layout";
  }
  const command = body.match(commandLinePattern)?.[1];
  return command ? `command:${command.toLowerCase()}` : "layout";
}

/**
 * Give every meaningful line a stable slot inside its Klipper section. The
 * occurrence number distinguishes repeated options/commands, while callers
 * also compare the total number of lines in the semantic group. Consequently
 * an identical rendered line added later in the same section cannot receive a
 * placeholder that belonged to an earlier, edited line.
 */
function semanticContentLines(content: string): SemanticContentLine[] {
  let scope = rootScope;
  const sectionCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  return contentLines(content).map((line) => {
    const token = semanticToken(line.body);
    const group = `${scope}\u0001${token}`;
    const occurrence = (groupCounts.get(group) ?? 0) + 1;
    groupCounts.set(group, occurrence);
    const semanticLine = {
      ...line,
      anchor: `${group}\u0002${occurrence}`,
      group,
      scope,
    };
    const section = line.body.match(sectionHeaderPattern)?.[1];
    if (section) {
      const sectionOccurrence = (sectionCounts.get(section) ?? 0) + 1;
      sectionCounts.set(section, sectionOccurrence);
      scope = `${section}\u0000${sectionOccurrence}`;
    }
    return semanticLine;
  });
}

function groupCounts(lines: SemanticContentLine[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line.group, (counts.get(line.group) ?? 0) + 1);
  }
  return counts;
}

function sectionCounts(content: string) {
  const counts = new Map<string, number>();
  for (const line of contentLines(content)) {
    const section = line.body.match(sectionHeaderPattern)?.[1];
    if (section) {
      counts.set(section, (counts.get(section) ?? 0) + 1);
    }
  }
  return counts;
}

function hasAuthoritativeSectionCardinality(
  templateContent: string,
  capturedContent: string,
) {
  const capturedSectionCounts = sectionCounts(capturedContent);
  for (const [section, count] of sectionCounts(templateContent)) {
    if (capturedSectionCounts.get(section) !== count) {
      return false;
    }
  }
  return true;
}

function preserveFileVariableTemplates(
  templateContent: string,
  capturedContent: string,
  values: VariableValues,
) {
  const templateLines = semanticContentLines(templateContent);
  const renderedTemplateContent = renderTemplateContent(templateContent, values);
  if (!hasAuthoritativeSectionCardinality(renderedTemplateContent, capturedContent)) {
    return capturedContent;
  }
  const renderedTemplateLines = semanticContentLines(renderedTemplateContent);
  if (renderedTemplateLines.length !== templateLines.length) {
    // A value containing a newline has no safe one-line correspondence.
    return capturedContent;
  }

  const capturedLines = semanticContentLines(capturedContent);
  const capturedByAnchor = new Map(capturedLines.map((line) => [line.anchor, line]));
  const capturedGroupCounts = groupCounts(capturedLines);
  const renderedGroupCounts = groupCounts(renderedTemplateLines);
  let changed = false;

  templateLines.forEach((templateLine, index) => {
    if (!variablePlaceholderPattern.test(templateLine.body)) {
      return;
    }
    const renderedLine = renderedTemplateLines[index];
    if (renderedLine.body === templateLine.body) {
      return;
    }
    const capturedLine = capturedByAnchor.get(renderedLine.anchor);
    if (
      !capturedLine
      || capturedLine.body !== renderedLine.body
      || capturedGroupCounts.get(renderedLine.group) !== renderedGroupCounts.get(renderedLine.group)
    ) {
      return;
    }
    capturedLine.body = templateLine.body;
    changed = true;
  });

  return changed
    ? capturedLines.map((line) => `${line.body}${line.ending}`).join("")
    : capturedContent;
}

function hasRenderableValue(values: VariableValues, name: string) {
  return Object.prototype.hasOwnProperty.call(values, name)
    && values[name] !== null
    && values[name] !== undefined;
}

function isProtectedVariable(
  values: VariableValues,
  name: string,
  protectAllPlaceholders: boolean,
) {
  return protectAllPlaceholders
    || !hasRenderableValue(values, name)
    || likelySecretVariableNamePattern.test(name);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the exact safe shapes of a line that contains a protected marker. */
function protectedLinePattern(
  templateBody: string,
  values: VariableValues,
  protectAllPlaceholders: boolean,
) {
  let source = "^";
  let cursor = 0;
  for (const match of templateBody.matchAll(variablePlaceholderNamesPattern)) {
    source += escapeRegExp(templateBody.slice(cursor, match.index));
    const name = match[1];
    const placeholder = match[0];
    if (isProtectedVariable(values, name, protectAllPlaceholders)) {
      source += escapeRegExp(placeholder);
    } else {
      source += `(?:${escapeRegExp(placeholder)}|${escapeRegExp(String(values[name]))})`;
    }
    cursor = (match.index ?? 0) + placeholder.length;
  }
  source += `${escapeRegExp(templateBody.slice(cursor))}$`;
  return new RegExp(source);
}

function templateVariableNames(content: string) {
  return Array.from(content.matchAll(variablePlaceholderNamesPattern), (match) => match[1]);
}

/**
 * Identify authoritative variables whose marker is not demonstrably present
 * at every expected file, section, option/command occurrence, and line shape.
 *
 * Missing/renamed authoritative paths and added captured paths are rejected
 * whenever the authority contains variables: without a sidecar, the server
 * cannot prove that a host-local value was not moved into such a file.
 */
export function unprotectedCapturedVariableNames(
  capturedFiles: StoredConfigFile[],
  templateFiles: StoredConfigFile[],
  values: VariableValues,
  options: CaptureProtectionOptions = {},
) {
  const protectAllPlaceholders = options.protectAllPlaceholders === true;
  const capturedByPath = new Map(capturedFiles.map((file) => [file.path, file]));
  const templateByPath = new Map(templateFiles.map((file) => [file.path, file]));
  const allTemplateVariableNames = new Set(
    templateFiles.flatMap((file) => templateVariableNames(file.content)),
  );
  const unprotected = new Set<string>();

  if (
    capturedByPath.size !== capturedFiles.length
    || templateByPath.size !== templateFiles.length
  ) {
    allTemplateVariableNames.forEach((name) => unprotected.add(name));
  }

  if (
    allTemplateVariableNames.size > 0
    && capturedFiles.some((file) => !templateByPath.has(file.path))
  ) {
    allTemplateVariableNames.forEach((name) => unprotected.add(name));
  }

  for (const template of templateFiles) {
    const allNamesInFile = templateVariableNames(template.content);
    if (allNamesInFile.length === 0) {
      continue;
    }
    const captured = capturedByPath.get(template.path);
    if (!captured) {
      allNamesInFile.forEach((name) => unprotected.add(name));
      continue;
    }

    if (!hasAuthoritativeSectionCardinality(template.content, captured.content)) {
      allNamesInFile.forEach((name) => unprotected.add(name));
      continue;
    }

    const safeValues = Object.fromEntries(
      Object.entries(values).filter(([name]) => !isProtectedVariable(
        values,
        name,
        protectAllPlaceholders,
      )),
    );
    const templateLines = semanticContentLines(template.content);
    const anchorLines = semanticContentLines(renderTemplateContent(template.content, safeValues));
    const capturedLines = semanticContentLines(captured.content);
    if (anchorLines.length !== templateLines.length) {
      allNamesInFile.forEach((name) => unprotected.add(name));
      continue;
    }
    const capturedByAnchor = new Map(capturedLines.map((line) => [line.anchor, line]));
    const capturedGroupCounts = groupCounts(capturedLines);
    const anchorGroupCounts = groupCounts(anchorLines);

    templateLines.forEach((templateLine, index) => {
      const authoritativeNames = templateVariableNames(templateLine.body);
      if (authoritativeNames.length === 0) {
        return;
      }
      const anchorLine = anchorLines[index];
      const capturedLine = capturedByAnchor.get(anchorLine.anchor);
      if (
        !capturedLine
        || capturedGroupCounts.get(anchorLine.group) !== anchorGroupCounts.get(anchorLine.group)
        || !protectedLinePattern(
          templateLine.body,
          values,
          protectAllPlaceholders,
        ).test(capturedLine.body)
      ) {
        // A known non-secret value is still part of the variable declaration.
        // If its exact marker-or-rendered line cannot be proven at the same
        // semantic occurrence, accepting the literal would silently flatten
        // the declaration (the original Beacon persistence failure). Require
        // an explicit desired edit that removes the marker instead.
        authoritativeNames.forEach((name) => unprotected.add(name));
      }
    });
  }
  return Array.from(unprotected).sort();
}

/**
 * Preserve variable declarations when a desktop or printer sync client
 * captures rendered configuration files without its local template sidecar.
 *
 * The caller supplies a proven template authority: either the client's exact
 * synchronized desired revision or the printer's applied immutable snapshot.
 * A placeholder-bearing line is restored only when its rendering with stored,
 * non-secret printer values exactly occupies the same semantic occurrence in
 * the same Klipper section. Changed or structurally ambiguous lines pass
 * through untouched. Callers must separately reject unprotected host-local
 * values before storing the result.
 */
export function preserveCapturedVariableTemplates(
  capturedFiles: StoredConfigFile[],
  templateFiles: StoredConfigFile[],
  values: VariableValues,
) {
  const templatesByPath = new Map(templateFiles.map((file) => [file.path, file]));
  return capturedFiles.map((file) => {
    const template = templatesByPath.get(file.path);
    if (!template || !variablePlaceholderPattern.test(template.content)) {
      return file;
    }
    return {
      ...file,
      content: preserveFileVariableTemplates(template.content, file.content, values),
    };
  });
}
