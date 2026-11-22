import { readFile } from "node:fs/promises";

// String-aware JSONC comment stripper: walks the source once so that "//" or
// "/*" inside string values (URLs, paths) are never treated as comments. The
// previous regex approach corrupted any string containing "//" not preceded
// by ":".
function stripJsonComments(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      output += char;
      index += 1;
      while (index < source.length) {
        const stringChar = source[index];
        output += stringChar;
        index += 1;
        if (stringChar === "\\") {
          output += source[index] ?? "";
          index += 1;
        } else if (stringChar === '"') {
          break;
        }
      }
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
    } else if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

export async function readWranglerTemplate() {
  const source = await readFile("wrangler.jsonc", "utf8");
  return JSON.parse(stripJsonComments(source));
}

export async function readWranglerConfig() {
  try {
    return JSON.parse(await readFile("wrangler.json", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return readWranglerTemplate();
  }
}
