import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const stylesheetPath = "src/styles.css";
const runtimeSourceRoot = "src";

/**
 * Custom properties defined in CSS: `--name:` declarations, including the
 * :root token block and the @theme mapping block.
 */
export function cssDefinedVars(css) {
  const defined = new Set();
  for (const match of css.matchAll(/(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/gm)) {
    defined.add(match[1]);
  }
  return defined;
}

/**
 * Custom properties set at runtime through React inline styles, e.g.
 * `style={{ "--sensor-color": item.color }}`.
 */
export function runtimeDefinedVars(sourceText) {
  const defined = new Set();
  for (const match of sourceText.matchAll(/["'](--[A-Za-z0-9_-]+)["']\s*:/g)) {
    defined.add(match[1]);
  }
  return defined;
}

/**
 * Returns every var(--x) usage in the stylesheet whose custom property is
 * defined neither in the stylesheet nor at runtime. Undefined tokens compute
 * to the guaranteed-invalid value, so backgrounds and color-mix() expressions
 * silently degrade — the --panel class of bug.
 */
export function findUndefinedCssVars(css, extraDefined = new Set()) {
  const defined = cssDefinedVars(css);
  for (const name of extraDefined) {
    defined.add(name);
  }
  const problems = [];
  const lines = css.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const name = match[1];
      if (!defined.has(name)) {
        problems.push({ line: index + 1, name });
      }
    }
  }
  return problems;
}

export async function collectRuntimeDefinedVars(root = runtimeSourceRoot) {
  const defined = new Set();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
    const text = await readFile(filePath, "utf8");
    for (const name of runtimeDefinedVars(text)) {
      defined.add(name);
    }
  }
  return defined;
}

export async function auditStylesheet(cssPath = stylesheetPath) {
  const css = await readFile(cssPath, "utf8");
  const runtimeVars = await collectRuntimeDefinedVars();
  return findUndefinedCssVars(css, runtimeVars);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const problems = await auditStylesheet();
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`not ok - ${stylesheetPath}:${problem.line} uses var(${problem.name}) but ${problem.name} is never defined`);
    }
    console.error(`${problems.length} undefined CSS custom propert${problems.length === 1 ? "y" : "ies"} in ${stylesheetPath}`);
    process.exit(1);
  }
  console.log(`ok - every var(--x) used in ${stylesheetPath} is defined`);
}
