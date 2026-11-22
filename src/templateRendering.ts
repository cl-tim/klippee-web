export type TemplateVariableValues = Record<string, string | number | boolean | null | undefined>;

const textEncoder = new TextEncoder();

function templateVariablePattern() {
  return /\$\{KLIPPEE:([a-z][a-z0-9_]*)\}/g;
}

function ownVariableValue(values: TemplateVariableValues, name: string) {
  return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
}

export class TemplateRenderLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Rendered package exceeds the ${limitBytes}-byte limit`);
    this.name = "TemplateRenderLimitError";
  }
}

function renderedContentByteLength(
  content: string,
  values: TemplateVariableValues,
  replacementByteLengths: Map<string, number>,
) {
  let byteLength = textEncoder.encode(content).byteLength;
  for (const match of content.matchAll(templateVariablePattern())) {
    const name = match[1];
    const value = ownVariableValue(values, name);
    if (value === null || value === undefined) {
      continue;
    }

    let replacementByteLength = replacementByteLengths.get(name);
    if (replacementByteLength === undefined) {
      replacementByteLength = textEncoder.encode(String(value)).byteLength;
      replacementByteLengths.set(name, replacementByteLength);
    }
    // Template markers are ASCII, so their character and UTF-8 byte lengths
    // are identical. Only the replacement needs an encoder pass.
    byteLength += replacementByteLength - match[0].length;
  }
  return byteLength;
}

export function renderTemplateContent(content: string, values: TemplateVariableValues) {
  return content.replace(templateVariablePattern(), (placeholder, name: string) => {
    const value = ownVariableValue(values, name);
    return value === null || value === undefined ? placeholder : String(value);
  });
}

export function renderTemplateFiles<T extends { content: string }>(
  files: readonly T[],
  values: TemplateVariableValues,
  limitBytes: number,
) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new RangeError("Template render limit must be a non-negative safe integer");
  }

  const replacementByteLengths = new Map<string, number>();
  let totalBytes = 0;

  // Complete the byte-only preflight for every file before allocating any
  // expanded strings. This also makes the limit aggregate rather than a
  // per-file bound that could be multiplied by the file-count limit.
  for (const file of files) {
    const fileBytes = renderedContentByteLength(file.content, values, replacementByteLengths);
    if (!Number.isSafeInteger(fileBytes) || fileBytes > limitBytes - totalBytes) {
      throw new TemplateRenderLimitError(limitBytes);
    }
    totalBytes += fileBytes;
  }

  return files.map((file) => ({
    ...file,
    content: renderTemplateContent(file.content, values),
  }));
}

export function unresolvedTemplateVariables(content: string) {
  const names = new Set<string>();
  for (const match of content.matchAll(templateVariablePattern())) {
    names.add(match[1]);
  }
  return Array.from(names);
}
