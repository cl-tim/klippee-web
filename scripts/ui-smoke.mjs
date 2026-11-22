import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createDiagnosticBundleFixture } from "./ui-smoke-diagnostics.mjs";

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(process.env.UI_SMOKE_OUTPUT_DIR || path.join("output", "playwright", "ui-smoke", runId));
const screenshotDir = path.join(outputDir, "screenshots");
const allowErrors = process.env.UI_SMOKE_ALLOW_ERRORS === "1";
const headless = process.env.UI_SMOKE_HEADLESS !== "0";
const axeSource = process.env.UI_SMOKE_AXE_PATH ? await readFile(process.env.UI_SMOKE_AXE_PATH, "utf8") : null;
const defaultViewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];
const responsiveViewports = [
  { name: "phone-small", width: 320, height: 568 },
  { name: "phone", width: 360, height: 800 },
  { name: "mobile", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "compact", width: 640, height: 800 },
  { name: "before-sidebar", width: 767, height: 1024 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "tablet-wide", width: 1024, height: 768 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1440, height: 1000 },
  { name: "wide", width: 1920, height: 1080 },
  { name: "ultrawide", width: 2560, height: 1440 },
  // The CSS viewport and pixel density of a 1440x1000 window at 200% zoom.
  { name: "zoom-200", width: 720, height: 500, deviceScaleFactor: 2 },
];
const selectedViewports = process.env.UI_SMOKE_VIEWPORTS?.split(",");
const viewports = (process.env.UI_SMOKE_RESPONSIVE === "1" ? responsiveViewports : defaultViewports)
  .filter((viewport) => !selectedViewports || selectedViewports.includes(viewport.name));
if (viewports.length === 0) throw new Error("No UI smoke viewports selected");
const tabLabels = [
  "Klipper Workspace",
  "Orca Workspace",
  "Printers",
  "Shared Configs",
  "Log Diagnostics",
  "Gridfinity Editor",
  "OpenGrid Editor",
  "OpenGrid Underware Editor",
];
const report = {
  allowErrors,
  baseUrl: "",
  finishedAt: "",
  issues: [],
  runId,
  screenshots: [],
  startedAt: new Date().toISOString(),
  summary: {},
  viewports,
};

let viteServer;
let browser;

function relativeOutput(filePath) {
  return path.relative(outputDir, filePath).replaceAll(path.sep, "/");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function addIssue({ detail, kind, persona, scenario, severity, url, viewport }) {
  report.issues.push({
    detail: String(detail).slice(0, 2_000),
    kind,
    persona,
    scenario,
    severity,
    url,
    viewport,
  });
}

function jsonResponse(route, payload, status = 200) {
  return route.fulfill({
    body: JSON.stringify(payload),
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    status,
  });
}

function stlResponse(route) {
  const body = Buffer.alloc(134);
  body.write("Klippee UI smoke STL", 0, "ascii");
  body.writeUInt32LE(1, 80);
  body.writeFloatLE(1, 96);
  body.writeFloatLE(1, 112);
  return route.fulfill({
    body,
    contentType: "model/stl",
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="model.stl"',
      "x-cad-duration-ms": "12.5",
    },
    status: 200,
  });
}

function createApiFixture(authenticated, registryState) {
  const timestamp = "2026-10-01T12:00:00.000Z";
  const files = [
    { content: "[include macros.cfg]\n\n[printer]\nkinematics: corexy\nmax_velocity: 200\nmax_accel: 3000\n", path: "printer.cfg", public: false, role: "printer" },
    { content: "[gcode_macro SMOKE_TEST]\ngcode:\n  G28\n", path: "macros.cfg", public: false, role: "macros" },
  ];
  const printer = {
    appliedAt: timestamp, appliedVersionId: 1, createdAt: timestamp,
    description: "Deterministic browser test printer", id: "ui-smoke-printer",
    latestVersionId: 1, make: "Voron", model: "2.4", name: "Smoke bench printer",
    packageIds: ["ui-smoke-package"], repositoryId: "ui-smoke-repo", source: "manual",
    updatedAt: timestamp, variableValues: {},
  };
  const pkg = {
    description: "Browser smoke configuration", files, hardware: ["corexy"],
    id: "ui-smoke-package", name: "ui-smoke-package", printer: "Voron 2.4",
    tags: ["smoke"], title: "Smoke bench configuration", variables: [], version: "1", warnings: [],
  };
  const assets = ["filament", "machine", "process"].map((kind) => ({
    content: JSON.stringify({ type: kind, name: `Smoke ${kind} preset`, layer_height: "0.2" }),
    createdAt: timestamp, description: "Browser smoke Orca preset", id: `ui-smoke-${kind}`,
    kind, printerId: printer.id, public: false, tags: [], title: `Smoke ${kind} preset`,
    updatedAt: timestamp, version: "1",
  }));
  const history = [{ id: 1, previousId: null, message: "Captured configuration", source: "capture", createdAt: timestamp, files }];
  const fixture = {
    registryState,
    appState: authenticated ? {
      history, printer: { name: printer.name, latestVersionId: 1, appliedVersionId: 1, lastSeen: timestamp },
      printers: [printer], repositoryId: printer.repositoryId, selectedPrinterId: printer.id,
      selectedFilePath: "printer.cfg", selectedPackageId: pkg.id, workspaceContent: files[0].content,
      workspaceFilePath: "printer.cfg",
    } : null,
    assets: authenticated ? assets : [], files, history, packages: authenticated ? [pkg] : [],
    printers: authenticated ? [printer] : [], publicPackage: { ...pkg, id: "ui-smoke-public-package", sourcePackageId: pkg.id, files: files.map((file) => ({ ...file, public: true })) },
    timestamp,
  };
  return (route) => mockApi(route, authenticated, fixture);
}

async function mockApi(route, authenticated, fixture) {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  const method = request.method();
  const body = () => request.postDataJSON();
  if (pathname === "/api/cad/render") return stlResponse(route);
  if (pathname === "/api/cad/convert-scad") return jsonResponse(route, {
    convertedNodes: 2, coverage: 1, duration: 0.02, filename: "model.py", nodeCount: 2,
    source: "from build123d import *\n\nwith BuildPart() as model:\n    Box(40, 40, 12)\n\nresult = model.part\n", unsupported: [],
  });
  if (pathname === "/api/auth/me") {
    return jsonResponse(route, {
      user: authenticated
        ? {
            avatarUrl: null,
            displayName: process.env.UI_SMOKE_ACCOUNT_NAME || "UI Smoke Tester",
            id: "ui-smoke-user",
            providers: process.env.UI_SMOKE_ACCOUNT_PROVIDERS === undefined
              ? ["github", "discord"]
              : process.env.UI_SMOKE_ACCOUNT_PROVIDERS.split(",").filter(Boolean),
          }
        : null,
    });
  }
  if (pathname === "/api/packages") return jsonResponse(route, { packages: fixture.registryState === "first-publication" ? [] : [fixture.publicPackage] });
  if (pathname === `/api/packages/${fixture.publicPackage.id}`) return jsonResponse(route, { package: fixture.publicPackage });
  if (pathname === "/api/repos") return jsonResponse(route, { repositories: authenticated ? [{ id: "ui-smoke-repo", name: "Smoke bench printer", updated_at: fixture.timestamp }] : [] });
  if (pathname === "/api/repos/ui-smoke-repo/versions") return jsonResponse(route, {
    desired: null,
    versions: fixture.history.map((version) => ({
      created_at: version.createdAt, files: version.files, id: "ui-smoke-version", message: version.message,
      previous_version_id: null, source: version.source, version_number: version.id,
    })),
  });
  if (pathname === "/api/repos/ui-smoke-repo/sync-tokens") return jsonResponse(route, { tokens: [] });
  if (pathname === "/api/repos/ui-smoke-repo/sync-status") return jsonResponse(route, {
    appliedVersion: { version_number: 1 }, latestVersion: { version_number: 1, message: "Captured configuration" },
    printer: fixture.printers[0], updateAvailable: false,
  });
  if (pathname.endsWith("/publication-candidate")) return jsonResponse(route, {
    candidate: { appliedAt: fixture.timestamp, files: fixture.files, repositoryId: "ui-smoke-repo", versionId: "ui-smoke-version", versionNumber: 1 },
  });
  if (pathname === "/api/printers") {
    if (method === "POST") {
      const printer = body().printer;
      fixture.printers = [...fixture.printers.filter((entry) => entry.id !== printer.id), printer];
      return jsonResponse(route, { printer });
    }
    return jsonResponse(route, { printers: fixture.printers });
  }
  if (pathname === "/api/private-packages") {
    if (method === "POST") {
      const pkg = body().package;
      fixture.packages = [...fixture.packages.filter((entry) => entry.id !== pkg.id), pkg];
      return jsonResponse(route, { package: pkg });
    }
    return jsonResponse(route, { packages: fixture.packages });
  }
  if (pathname === "/api/companion-assets") return jsonResponse(route, { assets: fixture.assets });
  if (pathname === "/api/orca/devices") return jsonResponse(route, { devices: [] });
  if (pathname === "/api/orca/setups") return jsonResponse(route, { setups: [] });
  if (pathname === "/api/orca/library") {
    const root = "_local/klippee-restore-701648225c90";
    const dependency = `${root}-d1/saved-43f13e10cc2362a93c46`;
    const entry = (name, nozzle, custom = false) => ({ id: `machine:${name}`, name, nozzle, custom,
      kind: "machine", enabled: true, parent: null, printerIds: [] });
    const tagged = (kind, name, nozzleSizes, extra) => ({ ...entry(name, "", true), id: `${kind}:${name}`, kind,
      tags: { nozzleSizes, nozzleScope: "specific", materials: [], layerHeights: [], printerModels: ["QIDI Plus 4"], hasCompatibilityRule: false, ...extra } });
    return jsonResponse(route, { library: ["orca-library", "orca-publishing"].includes(process.env.UI_SMOKE_FEATURE) ? {
      id: "orca-library-preview", updatedAt: fixture.timestamp, hostVersion: "2.5.0-alpha",
      profiles: [
        entry("Qidi X-Plus 4 0.4 nozzle", "0.4"), entry("Qidi X-Plus 4 0.6 nozzle", "0.6"),
        entry(`${root}-d0/saved-f76a0fdafad87fd5d887`, "0.4"), entry(dependency, "0.6"),
        { ...entry(`${root}-d2/restored-0-example1-0.6mm`, "0.6"), parent: dependency },
        entry("_local/klippee-restore-79c071b78ba3-d0/saved-df18d3873148f47a3899", "0.2"),
        entry("_local/klippee-restore-79c071b78ba3-d1/saved-cc36cd416f80ad8c9bc0", "0.2"),
        entry("_local/klippee-restore-79c071b78ba3-d2/restored-0-example1-0.2mm", "0.2"),
        entry("example1", "0.4", true),
        tagged("filament", "Fine PLA", ["0.2"], { materials: ["PLA"] }),
        tagged("filament", "Rapid PETG", ["0.4"], { materials: ["PETG"] }),
        tagged("process", "Fine detail", ["0.2"], { layerHeights: ["0.08"] }),
        tagged("process", "Gridfinity", ["0.4"], { layerHeights: ["0.2"] }),
      ],
    } : null });
  }
  if (pathname.endsWith("/orca-setups")) return jsonResponse(route, { setups: process.env.UI_SMOKE_FEATURE === "orca" ? [{
    id: "ui-smoke-saved-setup", title: "Smoke captured setup", createdAt: fixture.timestamp,
    hostVersion: "2.5.0-alpha", nodes: 8, omittedKeys: ["print_host"],
    selections: [
      { kind: "machine", name: "Smoke machine preset", slot: null, dirty: false },
      { kind: "process", name: "Smoke process preset", slot: null, dirty: false },
      ...["PLA", "PETG", "Translucent PETG", "Rapid PETG"].map((name, slot) => ({ kind: "filament", name, slot, dirty: false })),
    ],
  }] : [] });
  if (pathname.endsWith("/orca-connection") || ["/api/orca/connection", "/api/orca/setup-connection", "/api/orca/pair-connection"].includes(pathname)) return jsonResponse(route, {
    id: "ui-smoke-orca-grant", code: "https://klippee.test/#klorca_" + "x".repeat(43),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }, 201);
  if (pathname === "/api/orca/connections/ui-smoke-orca-grant" && method === "DELETE") return jsonResponse(route, { ok: true });
  if (pathname === "/api/public-companion-assets/ui-smoke-filament") return jsonResponse(route, {
    asset: { ...fixture.assets[0], id: "ui-smoke-filament", kind: "filament", title: "Smoke filament preset", content: JSON.stringify({ type: "filament", name: "Smoke filament preset", filament_type: "PLA" }), public: true, version: "1", tags: ["PLA"] },
  });
  const sharedProfile = { ...fixture.assets[1], id: "ui-smoke-native", title: "QIDI fine detail", kind: "machine", public: true,
    publicSlug: "qidi-fine-detail", publicUrl: `${url.origin}/assets/qidi-fine-detail`, description: "Tuned for small details on a QIDI Plus 4.",
    tags: ["0.2 mm nozzle", "QIDI Plus 4"], publishedAt: fixture.timestamp, version: "1",
    printerConfig: { slug: fixture.publicPackage.id, title: fixture.publicPackage.title },
    content: JSON.stringify({ snapshot: { format: "klippee-orca-profile/v1", nodes: {
      "machine:QIDI fine detail": { kind: "machine", name: "QIDI fine detail", parent: null, saved: { inherits: "", nozzle_diameter: "0.2", machine_start_gcode: "G28\nSTART_PRINT" }, source_json: null },
    }, selections: [{ node: "machine:QIDI fine detail", slot: null, dirty: false, effective: { inherits: "", nozzle_diameter: "0.2", machine_start_gcode: "G28\nSTART_PRINT" }, changes: {} }] } }, null, 2) };
  if (pathname === "/api/orca/library/publication" && method === "PATCH") return jsonResponse(route, { publication: {
    autoUpdateEnabled: body().autoUpdateEnabled, autoUpdateError: null, printerConfig: body().printerConfigSlug ? sharedProfile.printerConfig : null,
  } });
  if (pathname === "/api/orca/library/publication") return jsonResponse(route, method === "GET" ? { review: {
    importId: "orca-library-preview", candidateHash: "smoke-candidate", title: sharedProfile.title, description: sharedProfile.description,
    kind: sharedProfile.kind, content: sharedProfile.content, tags: sharedProfile.tags, findings: [], publicUrl: null,
    autoUpdateEnabled: false, autoUpdateError: null, printerConfig: null, printerConfigs: [sharedProfile.printerConfig],
  } } : { asset: sharedProfile }, method === "POST" ? 201 : 200);
  if (pathname === "/api/public-companion-assets") return jsonResponse(route, { assets: [sharedProfile], nextOffset: null, nozzleSizes: ["0.2", "0.4"] });
  if (pathname === "/api/public-companion-assets/qidi-fine-detail") return jsonResponse(route, { asset: sharedProfile });
  if (/^\/api\/public-packages\/[^/]+\/orca-profiles$/.test(pathname)) return jsonResponse(route, { assets: [sharedProfile] });
  if (pathname === "/api/diagnostic-uploads" && method === "GET") return jsonResponse(route, { uploads: [] });
  if (pathname === "/api/app-state") {
    if (method === "PUT") fixture.appState = body().state;
    return jsonResponse(route, { state: fixture.appState, updatedAt: fixture.timestamp });
  }
  if (/^\/api\/public-packages\/[^/]+\/status$/.test(pathname)) return jsonResponse(route, {
    status: {
      approvedVersionId: fixture.registryState === "current" ? "ui-smoke-version" : null,
      currentAppliedVersionId: "ui-smoke-version",
      hasUnpublishedAppliedVersion: fixture.registryState !== "current",
      linked: true,
      autoUpdateEnabled: ["current", "paused"].includes(fixture.registryState),
      autoUpdateError: fixture.registryState === "paused"
        ? "Automatic update needs review: resolve the safety findings or approve and republish manually."
        : null,
    },
  });
  if (pathname === "/api/auth/logout") return jsonResponse(route, { ok: true });
  return jsonResponse(route, { error: `Missing UI smoke fixture: ${method} ${pathname}` }, 501);
}

function attachDiagnostics(page, state) {
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    addIssue({
      detail: message.text(),
      kind: `console-${message.type()}`,
      persona: state.persona,
      scenario: state.scenario,
      severity: message.type() === "error" ? "error" : "warning",
      url: page.url(),
      viewport: state.viewport,
    });
  });
  page.on("pageerror", (error) => {
    addIssue({
      detail: error.stack || error.message,
      kind: "page-error",
      persona: state.persona,
      scenario: state.scenario,
      severity: "error",
      url: page.url(),
      viewport: state.viewport,
    });
  });
  page.on("requestfailed", (request) => {
    // React aborts an obsolete fetch when route effects unmount or remount.
    const cancelled = request.failure()?.errorText === "net::ERR_ABORTED" && request.resourceType() === "fetch";
    addIssue({
      detail: `${request.method()} ${request.url()} - ${request.failure()?.errorText || "request failed"}`,
      kind: "request-failed",
      persona: state.persona,
      scenario: state.scenario,
      severity: cancelled ? "warning" : "error",
      url: request.url(),
      viewport: state.viewport,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    addIssue({
      detail: `${response.status()} ${response.request().method()} ${response.url()}`,
      kind: "http-error",
      persona: state.persona,
      scenario: state.scenario,
      severity: "error",
      url: response.url(),
      viewport: state.viewport,
    });
  });
}

async function settle(page, selector = "main") {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(350);
}

async function snapshot(page, state, name, selector, preserveScroll = false) {
  state.scenario = name;
  if (!await page.evaluate(() => Boolean(globalThis.document.getElementById("ui-smoke-no-motion")))) {
    const style = await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}" });
    await style.evaluate(element => { element.id = "ui-smoke-no-motion"; });
  }
  if (axeSource && !selector) {
    if (!await page.evaluate(() => Boolean(globalThis.axe))) await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => (await globalThis.axe.run(globalThis.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    })).violations.map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })) })));
    for (const violation of violations) addIssue({ detail: JSON.stringify(violation), kind: "accessibility", persona: state.persona, scenario: name, severity: "error", url: page.url(), viewport: state.viewport });
  }
  const filename = `${state.viewport}-${state.persona}-${slug(name)}.png`;
  const filePath = path.join(screenshotDir, filename);
  const target = selector ? page.locator(selector).first() : page;
  if (!selector && !preserveScroll) await page.locator("main.workbench").evaluate((element) => { element.scrollTop = 0; });
  if (selector) {
    await target.waitFor({ state: "visible", timeout: 10_000 });
    await target.scrollIntoViewIfNeeded();
  }
  await target.screenshot(
    selector
      ? { animations: "disabled", path: filePath }
      : { animations: "disabled", fullPage: true, path: filePath },
  );
  report.screenshots.push({
    file: relativeOutput(filePath),
    name,
    persona: state.persona,
    selector: selector || null,
    viewport: state.viewport,
  });
  if (!selector && !preserveScroll) {
    const overflow = await page.evaluate(() => {
      const root = globalThis.document.documentElement;
      const main = globalThis.document.querySelector("main.workbench");
      return {
        document: root.scrollWidth - globalThis.innerWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
      };
    });
    if (overflow.document > 2 || overflow.main > 2) {
      addIssue({ detail: `Horizontal page overflow: document ${overflow.document}px, main ${overflow.main}px`, kind: "layout-overflow", persona: state.persona, scenario: name, severity: "error", url: page.url(), viewport: state.viewport });
    }
    const main = page.locator("main.workbench");
    const hasMore = await main.evaluate((element) => element.scrollHeight > element.clientHeight + 48);
    if (hasMore) {
      await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const bottomPath = path.join(screenshotDir, `${state.viewport}-${state.persona}-${slug(name)}-bottom.png`);
      await page.screenshot({ animations: "disabled", fullPage: true, path: bottomPath });
      report.screenshots.push({ file: relativeOutput(bottomPath), name: `${name}-bottom`, persona: state.persona, selector: null, viewport: state.viewport });
      await main.evaluate((element) => { element.scrollTop = 0; });
    }
    const modalScroll = page.getByRole("dialog").first();
    if (await modalScroll.count() && await modalScroll.isVisible()) {
      // Mantine dialogs and drawers scroll on short windows; capture their footer.
      if (await modalScroll.evaluate((element) => element.scrollHeight > element.clientHeight + 48)) {
        await modalScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        const bottomPath = path.join(screenshotDir, `${state.viewport}-${state.persona}-${slug(name)}-dialog-bottom.png`);
        await page.screenshot({ animations: "disabled", path: bottomPath });
        report.screenshots.push({ file: relativeOutput(bottomPath), name: `${name}-dialog-bottom`, persona: state.persona, selector: null, viewport: state.viewport });
        await modalScroll.evaluate((element) => { element.scrollTop = 0; });
      }
    }
  }
}

async function clickTab(page, label) {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { exact: true, name: label }).click();
  await settle(page);
}

async function openNavigation(page) {
  const menu = page.getByRole("button", { name: "Open navigation menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("navigation", { name: "Primary", exact: true }).waitFor({ state: "visible" });
}

async function runStep(state, label, action) {
  state.scenario = label;
  try {
    await action();
  } catch (error) {
    addIssue({
      detail: error instanceof Error ? error.stack || error.message : String(error),
      kind: "harness-error",
      persona: state.persona,
      scenario: label,
      severity: "error",
      url: state.page.url(),
      viewport: state.viewport,
    });
  }
}

async function capturePublicDetail(page, state) {
  await runStep(state, "registry-package-detail", async () => {
    await clickTab(page, "Shared Configs");
    await page.locator(".package-card").first().click();
    await settle(page, ".public-config-workspace");
    await snapshot(page, state, "registry-package-detail");
    await snapshot(page, state, "registry-package-detail-component", ".public-config-workspace");
    await page.locator(".public-config-back").click();
  });
}

async function captureAnonymous(page, state) {
  await runStep(state, "anonymous-klipper-workspace", async () => {
    await clickTab(page, "Klipper Workspace");
    await snapshot(page, state, "anonymous-klipper-workspace");
  });
  await runStep(state, "login-modal", async () => {
    await openNavigation(page);
    await page.getByRole("button", { name: "Login" }).click();
    await settle(page, '[role="dialog"]');
    const dialog = page.getByRole("dialog");
    if (!await dialog.evaluate((element) => element.contains(globalThis.document.activeElement))) {
      throw new Error("Login dialog did not receive keyboard focus");
    }
    await page.keyboard.press("Shift+Tab");
    if (!await dialog.evaluate((element) => element.contains(globalThis.document.activeElement))) {
      throw new Error("Login dialog did not trap backward keyboard navigation");
    }
    await snapshot(page, state, "login-modal");
    await snapshot(page, state, "login-modal-component", '[role="dialog"]');
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await settle(page);
    if (!await page.getByRole("button", { name: "Login" }).evaluate((element) => element === globalThis.document.activeElement)) {
      throw new Error("Login dialog did not return focus after Escape");
    }
  });
  if (state.viewport === "desktop") {
    await runStep(state, "collapsed-navigation", async () => {
      await page.getByRole("button", { name: "Collapse app menu" }).click();
      await settle(page);
      await snapshot(page, state, "collapsed-navigation");
      await page.getByRole("button", { name: "Expand app menu" }).click();
    });
  }
  for (const label of tabLabels.slice(1)) {
    await runStep(state, `anonymous-${label}`, async () => {
      await clickTab(page, label);
      await snapshot(page, state, `anonymous-${label}`);
    });
  }
  await capturePublicDetail(page, state);
  await runStep(state, "log-diagnostics-component", async () => {
    await clickTab(page, "Log Diagnostics");
    await settle(page, ".log-diagnostics");
    await snapshot(page, state, "log-diagnostics-component", ".log-diagnostics");
  });
  for (const [label, name] of [
    ["Gridfinity Editor", "gridfinity-editor-component"],
    ["OpenGrid Editor", "opengrid-editor-component"],
    ["OpenGrid Underware Editor", "underware-editor-component"],
  ]) {
    await runStep(state, name, async () => {
      await clickTab(page, label);
      await settle(page, ".cad-editor-workspace");
      await snapshot(page, state, name, ".cad-editor-workspace");
      await snapshot(page, state, `${name}-actions`, ".openscad-actionbar");
    });
  }
  if (state.viewport === "desktop") {
    await runStep(state, "gridfinity-rendered-model", async () => {
      await clickTab(page, "Gridfinity Editor");
      await page.getByRole("button", { name: "Generate preview", exact: true }).click();
      await page.getByRole("status").filter({ hasText: /^Preview ready/ }).waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForTimeout(1_200);
      await snapshot(page, state, "gridfinity-rendered-model");
      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      await page.getByRole("button", { name: "Export STL" }).click();
      const download = await downloadPromise;
      if (!download.suggestedFilename().endsWith(".stl")) {
        throw new Error(`CAD export used unexpected filename ${download.suggestedFilename()}`);
      }
      await page.getByText("STL exported", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    });
  }
  await capturePopulatedDiagnostics(page, state);
  await captureToolRoutes(page, state);
}

async function captureAccount(page, state, authenticated) {
  await runStep(state, "sidebar-account", async () => {
    await openNavigation(page);
    await snapshot(page, state, "sidebar-account");
    await snapshot(page, state, "sidebar-account-component", ".sidebar-auth-slot");
    if (!authenticated) {
      await page.getByRole("button", { name: "Login", exact: true }).click();
      await settle(page, '[role="dialog"]');
      await snapshot(page, state, "account-login", '[role="dialog"]');
      await page.keyboard.press("Escape");
      await settle(page);
      return;
    }

    const account = page.getByRole("button", { name: /^Account menu for / });
    const menu = page.getByRole("menu", { name: /^Account menu for / });
    await account.focus();
    await page.keyboard.press("Enter");
    await settle(page, '[role="menu"]');
    await snapshot(page, state, "account-menu");
    await snapshot(page, state, "account-menu-component", '[role="menu"]');
    const bounds = await menu.boundingBox();
    const viewport = page.viewportSize();
    if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > viewport.width || bounds.y + bounds.height > viewport.height) {
      throw new Error("Account menu extends beyond the viewport");
    }
    await page.keyboard.press("ArrowDown");
    if (!await menu.evaluate((element) => element.contains(globalThis.document.activeElement))) {
      throw new Error("Account menu did not receive keyboard focus");
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await settle(page);
    if (!await account.evaluate((element) => element === globalThis.document.activeElement)) {
      throw new Error("Account menu did not return focus after Escape");
    }
    if (!await account.isVisible()) throw new Error("Escape closed the mobile navigation with the account menu");

    const collapse = page.getByRole("button", { name: "Collapse app menu", exact: true });
    if (await collapse.isVisible()) {
      await collapse.click();
      await settle(page);
      await snapshot(page, state, "account-collapsed-sidebar");
      await account.click();
      await settle(page, '[role="menu"]');
      await snapshot(page, state, "account-collapsed-menu");
      await page.keyboard.press("Escape");
    }
  });
}

async function capturePopulatedDiagnostics(page, state) {
  await runStep(state, "diagnostics-populated", async () => {
    await clickTab(page, "Log Diagnostics");
    await page.getByLabel("Choose diagnostic log files").setInputFiles({
      name: "klippee-diagnostics.zip", mimeType: "application/zip", buffer: createDiagnosticBundleFixture(),
    });
    await page.getByRole("tab", { name: "Snapshot", exact: true }).waitFor({ timeout: 20_000 });
    await snapshot(page, state, "diagnostics-tabs", ".diagnostics-tabs");
    await checkActionMenu(page, state, "More diagnostic actions", ["Replace logs", "Submit for improvements", "Clear analysis"], "diagnostic-actions");
    for (const name of ["Findings", "Snapshot", "Config", "Shutdowns", "Incidents", "Prints", "Timeline", "MCUs", "Thermals", "Compare"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await settle(page, ".log-diagnostics");
      await snapshot(page, state, `diagnostics-${slug(name)}`);
      if (name === "Config") await checkFieldHelp(page, state, "Diagnostic configuration", "diagnostics-config-help");
      if (name === "Thermals") await checkFieldHelp(page, state, "Temperature graph", "diagnostics-thermal-help");
    }
  });
}

async function checkActionMenu(page, state, label, items, name) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const menu = page.getByRole("menu");
  await menu.waitFor();
  for (const item of items) await menu.getByRole("menuitem", { name: item, exact: true }).waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute("role") === "menuitem");
  const enabledItems = menu.locator('[role="menuitem"]:not([disabled]):not([data-disabled])');
  if (await enabledItems.count() > 1) {
    await page.keyboard.press("ArrowDown");
    if (!await enabledItems.nth(1).evaluate(element => element === element.ownerDocument.activeElement)) throw new Error(`${label} does not support arrow key navigation`);
    await page.keyboard.press("ArrowUp");
  }
  await snapshot(page, state, name, undefined, true);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(name => globalThis.document.activeElement?.getAttribute("aria-label") === name, label);
}

async function checkRegistryWarning(page, state) {
  await clickTab(page, "Shared Configs");
  const warning = page.locator(".risk-warning-disclosure");
  const summary = warning.locator("summary");
  const content = warning.locator("ul");
  await summary.waitFor();
  if (await warning.getAttribute("open") !== null || await content.isVisible()) throw new Error("Registry warning should start collapsed");
  await snapshot(page, state, "registry-warning-collapsed");
  await summary.focus();
  await summary.press("Enter");
  await content.waitFor({ state: "visible" });
  const titleBox = await summary.locator("span").boundingBox();
  const textBox = await content.locator("li").first().boundingBox();
  if (!titleBox || !textBox || Math.abs(titleBox.x - textBox.x) > 1) throw new Error("Registry warning text should align with its title");
  await snapshot(page, state, "registry-warning-expanded");
  await summary.press("Space");
  await content.waitFor({ state: "hidden" });
}

async function checkFieldHelp(page, state, label, name) {
  const trigger = page.getByRole("button", { name: `Help for ${label}`, exact: true });
  const panel = page.getByRole("dialog", { name: `Help for ${label}`, exact: true });
  if (await panel.isVisible()) throw new Error(`${label} help should start hidden`);
  await trigger.focus();
  await trigger.press("Enter");
  await panel.waitFor();
  await page.waitForFunction(name => globalThis.document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-label") === name, `Help for ${label}`);
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    if (!await panel.evaluate(element => element.contains(element.ownerDocument.activeElement))) throw new Error(`${label} help lost keyboard focus`);
  }
  if (!(await panel.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const point = globalThis.document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 4);
    return bounds.left >= 0 && bounds.right <= globalThis.innerWidth && bounds.top >= 0 && bounds.bottom <= globalThis.innerHeight && !!point && element.contains(point);
  }))) throw new Error(`${label} help is clipped or covered`);
  await snapshot(page, state, name, undefined, true);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  if (!(await trigger.isVisible())) throw new Error(`Closing ${label} help also closed its screen`);
  await page.waitForFunction(name => globalThis.document.activeElement?.getAttribute("aria-label") === name, `Help for ${label}`);
  await trigger.press("Space");
  await panel.waitFor();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
}

async function tabTo(page, target) {
  for (let count = 0; count < 50; count += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(element => element === element.ownerDocument.activeElement)) return;
  }
  throw new Error("A control could not be reached with Tab");
}

async function captureKeyboardAccess(page, state) {
  await runStep(state, "keyboard-navigation", async () => {
    const skip = page.getByRole("link", { name: "Skip to content", exact: true });
    await page.keyboard.press("Tab");
    if (!await skip.evaluate(element => element === element.ownerDocument.activeElement)) throw new Error("Skip link is not the first keyboard stop");
    await skip.press("Enter");
    if (!await page.locator("main").evaluate(element => element === element.ownerDocument.activeElement)) throw new Error("Skip link did not focus main content");
    const toggle = page.getByRole("button", { name: "Open navigation menu", exact: true });
    if (await toggle.isVisible()) {
      await toggle.focus();
      await toggle.press("Enter");
      await tabTo(page, page.getByRole("link", { name: "Printers", exact: true }));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute("aria-label") === "Open navigation menu");
      await toggle.press("Enter");
    }
    const registry = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Shared Configs", exact: true });
    await tabTo(page, registry);
    await registry.press("Enter");
    await page.waitForFunction(() => globalThis.document.activeElement?.id === "main-content");
    const search = page.getByRole("searchbox", { name: "Search packages", exact: true });
    await tabTo(page, search);
    const contrast = await search.evaluate(element => {
      const style = globalThis.getComputedStyle(element);
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const ratio = (first, second) => (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);
      return { boundary: ratio(style.borderTopColor, style.backgroundColor), placeholder: ratio(globalThis.getComputedStyle(element, "::placeholder").color, style.backgroundColor), focus: ratio(style.outlineColor, style.backgroundColor), outline: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle };
    });
    if (contrast.boundary < 3 || contrast.placeholder < 4.5 || contrast.focus < 3 || contrast.outline < 2 || contrast.outlineStyle === "none") throw new Error(`Input contrast or focus failed: ${JSON.stringify(contrast)}`);
    await snapshot(page, state, "keyboard-search-focus", undefined, true);
    await page.emulateMedia({ forcedColors: "active" });
    await snapshot(page, state, "keyboard-forced-colors", undefined, true);
    await page.emulateMedia({ forcedColors: "none" });
  });
  await captureFieldHelp(page, state);
  await captureKeyboardPreview(page, state);
}

async function captureKeyboardPreview(page, state) {
  await runStep(state, "keyboard-3d-preview", async () => {
    await page.goto(new URL("/openscad-studio", report.baseUrl).href);
    await settle(page, ".openscad-workspace");
    await page.getByRole("button", { name: "Generate preview", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /^Draft preview ready/ }).waitFor();
    const canvas = page.getByRole("img", { name: "3D model preview", exact: true });
    await tabTo(page, canvas);
    if (!await canvas.evaluate(element => element.matches(":focus-visible") && parseFloat(globalThis.getComputedStyle(element).outlineWidth) >= 2)) throw new Error("3D preview has no visible keyboard focus");
    await page.waitForTimeout(1_000);
    const original = await canvas.evaluate(element => {
      const image = element.ownerDocument.createElement("canvas");
      image.width = element.width;
      image.height = element.height;
      const context = image.getContext("2d");
      context.drawImage(element, 0, 0);
      element.uiSmokeOriginalPixels = context.getImageData(0, 0, image.width, image.height);
      return element.toDataURL();
    });
    for (const key of ["+", "ArrowRight", "Shift+ArrowLeft"]) {
      await canvas.press(key);
      await page.waitForTimeout(400);
      if (await canvas.evaluate(element => element.toDataURL()) === original) throw new Error(`3D preview did not respond to ${key}`);
      await canvas.press("Home");
      await page.waitForTimeout(800);
      const resetDifference = await canvas.evaluate(element => {
        const before = element.uiSmokeOriginalPixels;
        if (before.width !== element.width || before.height !== element.height) return Infinity;
        const image = element.ownerDocument.createElement("canvas");
        image.width = element.width;
        image.height = element.height;
        const context = image.getContext("2d");
        context.drawImage(element, 0, 0);
        const after = context.getImageData(0, 0, image.width, image.height).data;
        let difference = 0;
        for (let index = 0; index < after.length; index += 1) difference += Math.abs(after[index] - before.data[index]);
        return difference / after.length;
      });
      if (resetDifference > 0.5) throw new Error(`Home did not restore the original 3D view (pixel difference ${resetDifference})`);
    }
    if (!await canvas.evaluate(element => element.matches(":focus-visible") && parseFloat(globalThis.getComputedStyle(element).outlineWidth) >= 2)) throw new Error("3D keyboard controls lost visible focus");
    await snapshot(page, state, "keyboard-3d-preview-focus", undefined, true);
    if (!await canvas.evaluate(element => element === element.ownerDocument.activeElement)) throw new Error("3D preview lost focus during inspection");
  });
}

async function captureFieldHelp(page, state) {
  for (const title of ["Gridfinity Editor", "OpenGrid Editor", "OpenGrid Underware Editor"]) {
    await clickTab(page, title);
    await settle(page, ".cad-editor-workspace");
    await checkFieldHelp(page, state, title, `${slug(title)}-library-help`);
    const trigger = page.locator(".openscad-parameter-field").getByRole("button", { name: /^Help for / }).first();
    if (await trigger.count()) {
      const label = (await trigger.getAttribute("aria-label")).slice("Help for ".length);
      await checkFieldHelp(page, state, label, `${slug(title)}-parameter-help`);
    }
    if (!(await page.getByText("Fit depends on printer, material, and tolerances. Test a small component first.", { exact: true }).isVisible())) throw new Error("CAD fit warning was hidden");
  }
  await captureToolRoutes(page, state);
  await capturePopulatedDiagnostics(page, state);
}

async function captureToolRoutes(page, state) {
  for (const [route, name, selector] of [
    ["/openscad-studio", "openscad-studio", ".openscad-workspace"],
    ["/scad-to-build123d", "scad-converter", ".scad-converter-panes"],
    ["/assets/ui-smoke-filament", "public-filament-preset", ".public-asset-view"],
  ]) {
    if (process.env.UI_SMOKE_TOOL_ROUTE && name !== process.env.UI_SMOKE_TOOL_ROUTE) continue;
    await runStep(state, name, async () => {
      await page.goto(new URL(route, report.baseUrl).href);
      await settle(page, selector);
      if (name === "public-filament-preset") await page.getByRole("heading", { name: "Smoke filament preset", exact: true }).waitFor();
      await snapshot(page, state, name);
      if (name === "openscad-studio") {
        if (await page.getByRole("button", { name: "Generate preview", exact: true }).count() !== 1) throw new Error("CAD should have one preview action");
        await snapshot(page, state, "cad-primary-actions", ".openscad-actionbar");
        await checkActionMenu(page, state, "More CAD actions", ["Download SCAD", "Reset workspace"], "cad-secondary-actions");
        await checkFieldHelp(page, state, "Source — paste or edit SCAD", "openscad-source-help");
      }
      if (name === "scad-converter") {
        await checkFieldHelp(page, state, "OpenSCAD to build123d", "converter-help");
        await page.getByRole("button", { name: "Convert to build123d", exact: true }).click();
        await page.getByText(/^Converted all 2 operations(?: ·|$)/).waitFor();
        await snapshot(page, state, "scad-converter-result");
        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        if ((await downloadPromise).suggestedFilename() !== "model.py") throw new Error("Converter export filename is incorrect");
      }
    });
  }
}

async function captureWorkspace(page, state) {
  await runStep(state, "klipper-workspace", async () => {
    await clickTab(page, "Klipper Workspace");
    await settle(page, ".slicer-layout");
    const openFiles = page.getByRole("button", { name: "Files & printer", exact: true });
    const compactWorkspace = await openFiles.isVisible();
    if (compactWorkspace) await openFiles.click();
    await page.locator(".slicer-printer-card").getByText("Smoke bench printer", { exact: true }).waitFor();
    await page.locator(".slicer-file-card").getByText("macros.cfg", { exact: true }).waitFor();
    if (compactWorkspace) {
      const dialog = page.getByRole("dialog");
      await settle(page, '[role="dialog"]');
      if (!await dialog.evaluate((element) => element.contains(globalThis.document.activeElement))) throw new Error("Workspace drawer did not receive keyboard focus");
      await page.keyboard.press("Shift+Tab");
      if (!await dialog.evaluate((element) => element.contains(globalThis.document.activeElement))) throw new Error("Workspace drawer did not trap keyboard focus");
      if (await page.locator("#slicer-workspace-navigation").count() !== 1) throw new Error("Workspace drawer navigation relationship is invalid");
      await snapshot(page, state, "workspace-file-drawer");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await settle(page);
      if (!await openFiles.evaluate((element) => element === globalThis.document.activeElement)) throw new Error("Workspace drawer did not return focus after Escape");
      await openFiles.click();
      await page.locator(".slicer-file-card").getByText("macros.cfg", { exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await openFiles.click();
      await page.locator(".slicer-file-card").getByText("printer.cfg", { exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    await page.locator(".slicer-editor").getByText("max_velocity: 200", { exact: false }).waitFor();
    await snapshot(page, state, "klipper-workspace");
    await checkFieldHelp(page, state, "Configuration autosave", "workspace-autosave-help");
  });
  if (state.viewport === "desktop") {
    for (const [name, selector] of [
      ["printer-card-component", ".slicer-printer-card"],
      ["file-browser-component", ".slicer-file-card"],
      ["workspace-editor-component", ".slicer-editor"],
    ]) {
      await runStep(state, name, () => snapshot(page, state, name, selector));
    }
  }
    await runStep(state, "registry-publisher", async () => {
      await page.getByRole("button", { name: "Publish to Shared Configs" }).click();
      await settle(page, ".registry-publisher-modal");
      await snapshot(page, state, "registry-publisher");
      await snapshot(page, state, "registry-publisher-component", ".registry-publisher-modal");
      await page.getByText("Listing details", { exact: true }).click();
      await checkFieldHelp(page, state, "Hardware", "registry-hardware-help");
      await page.getByRole("button", { name: "Close Shared Configs publisher" }).click();
    });
    await runStep(state, "workspace-recovery", async () => {
      const openFiles = page.getByRole("button", { name: "Files & printer", exact: true });
      if (await openFiles.isVisible()) await openFiles.click();
      await page.getByRole("button", { name: /^Recovery/ }).click();
      await settle(page, ".workspace-recovery-modal");
      await snapshot(page, state, "workspace-recovery");
      await checkFieldHelp(page, state, "Configuration recovery", "recovery-help");
      await page.keyboard.press("Escape");
    });
    await runStep(state, "printer-cli-instructions", async () => {
      const openFiles = page.getByRole("button", { name: "Files & printer", exact: true });
      if (await openFiles.isVisible()) await openFiles.click();
      await page.getByRole("button", { name: /^Install/ }).click();
      await settle(page, ".printer-management-shell");
      await snapshot(page, state, "printer-cli-instructions");
      await clickTab(page, "Klipper Workspace");
      await settle(page, ".slicer-layout");
    });
}

async function captureOrcaConnection(page, state, authenticated = true) {
  await runStep(state, "orca-connection", async () => {
    await clickTab(page, "Orca Workspace");
    if (await page.getByRole("button", { name: "Back to profile library", exact: true }).count()) await page.getByRole("button", { name: "Back to profile library", exact: true }).click();
    if (!authenticated) {
      await page.getByText("Sign in required", { exact: true }).waitFor();
      await snapshot(page, state, "orca-connection-sign-in");
      return;
    }
    if (await page.getByLabel("Preset name", { exact: true }).count()) throw new Error("Preset editor should not appear in saved setups");
    await snapshot(page, state, "orca-saved-setups");
    await page.getByText("Plugin installation and help", { exact: true }).click();
    const labelBounds = await page.getByRole("link", { name: "Download Orca plugin", exact: true }).evaluate((button) => {
      const label = button.querySelector(".mantine-Button-label");
      const range = button.ownerDocument.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      const box = label.getBoundingClientRect();
      return { top: text.top - box.top, bottom: box.bottom - text.bottom };
    });
    if (labelBounds.top < -1 || labelBounds.bottom < -1) {
      throw new Error(`Download label clips its glyphs: ${JSON.stringify(labelBounds)}`);
    }
    await page.getByText("Saved setups (0)", { exact: true }).click();
    await page.getByRole("button", { name: "Save current setup from OrcaSlicer", exact: true }).click();
    await page.getByLabel("Import code", { exact: true }).waitFor();
    await snapshot(page, state, "orca-connection-code");
    await page.getByRole("button", { name: "Cancel code", exact: true }).click();
    await page.getByLabel("Import code", { exact: true }).waitFor({ state: "detached" });
    await checkActionMenu(page, state, "Library actions", ["Reload library"], "orca-library-actions");
  });
}

async function captureOrcaLibrary(page, state, authenticated) {
  await clickTab(page, "Orca Workspace");
  if (!authenticated) {
    await page.getByText("Sign in required", { exact: true }).waitFor();
    return;
  }
  await page.getByRole("tab", { name: "Printer profiles (5)", exact: true }).waitFor();
  await checkActionMenu(page, state, "Library actions", ["Reload library", "Export library backup"], "orca-library-backup-actions");
  if (await page.locator("summary > strong").filter({ hasText: "_local/" }).count()) throw new Error("Internal restore presets leaked into the library list");
  await page.getByText("example1 0.6mm", { exact: true }).waitFor();
  const restored = page.locator("summary").filter({ hasText: "example1 0.6mm" });
  if (!(await restored.innerText()).includes("Restored")) throw new Error("Restored profile has the wrong source label");
  await snapshot(page, state, "orca-library-restored-profiles");
  await page.getByRole("textbox", { name: "Search profiles" }).fill("example1 0.6mm");
  await restored.click();
  const download = page.getByRole("link", { name: "Export profile for OrcaSlicer: example1 0.6mm" });
  const expectedId = "machine:_local/klippee-restore-701648225c90-d2/restored-0-example1-0.6mm";
  if (await download.getAttribute("href") !== `/api/orca/library/profile-export?profileId=${encodeURIComponent(expectedId)}`) throw new Error("Restored export lost its preset identity");
  await snapshot(page, state, "orca-library-restored-profile-details");
  await page.getByRole("textbox", { name: "Search profiles" }).fill("");
  await page.getByRole("combobox", { name: "Nozzle size" }).selectOption("0.2");
  await page.getByRole("tab", { name: "Custom filaments (1)", exact: true }).click();
  await page.getByText("Fine PLA", { exact: true }).waitFor();
  if (await page.getByText("Rapid PETG", { exact: true }).count()) throw new Error("Nozzle filter included a filament for a different nozzle");
  await snapshot(page, state, "orca-nozzle-filter-filaments");
  await page.getByRole("combobox", { name: "Nozzle size" }).selectOption("0.4");
  await page.getByRole("tab", { name: "Custom processes (1)", exact: true }).click();
  await page.getByText("Gridfinity", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search profiles" }).fill("0.2 mm layer");
  await page.getByText("Gridfinity", { exact: true }).waitFor();
  await snapshot(page, state, "orca-nozzle-and-layer-tags");
}

async function captureOrcaPublishing(page, state, authenticated) {
  if (authenticated) {
    await clickTab(page, "Orca Workspace");
    await page.getByRole("tab", { name: "Printer profiles (5)", exact: true }).waitFor();
    await page.getByText("example1", { exact: true }).click();
    await page.getByRole("button", { name: "Publish to Shared Configs: example1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Publish Orca profile" });
    await dialog.getByRole("textbox", { name: "Public name", exact: true }).waitFor();
    const help = dialog.getByRole("button", { name: "Help for Automatically update after Orca re-imports", exact: true });
    const helpPanel = dialog.getByRole("dialog", { name: "Help for Automatically update after Orca re-imports", exact: true });
    if (await helpPanel.isVisible()) throw new Error("Field help should start hidden");
    await help.click();
    await helpPanel.waitFor();
    await snapshot(page, state, "orca-publish-field-help");
    await page.keyboard.press("Escape");
    await helpPanel.waitFor({ state: "hidden" });
    if (!(await dialog.isVisible())) throw new Error("Closing field help also closed the publication form");
    if (await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).isChecked()) throw new Error("Opening field help changed the setting");
    if (!(await dialog.getByRole("button", { name: "Publish to Shared Configs", exact: true }).isDisabled())) throw new Error("Publication did not require review");
    await dialog.getByRole("combobox", { name: "Related printer config", exact: true }).selectOption("ui-smoke-public-package");
    await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).check();
    await snapshot(page, state, "orca-publish-review");
    await dialog.getByRole("checkbox", { name: /want anyone/ }).check();
    await dialog.getByRole("button", { name: "Publish to Shared Configs", exact: true }).click();
    await dialog.getByRole("link", { name: "View public listing" }).waitFor();
    await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).click();
    await dialog.getByText("Publication settings saved.", { exact: true }).waitFor();
    if (await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).isChecked()) throw new Error("Disabling automatic updates was not saved");
    await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).click();
    await dialog.getByText("Publication settings saved.", { exact: true }).waitFor();
    if (!(await dialog.getByRole("switch", { name: "Automatically update after Orca re-imports", exact: true }).isChecked())) throw new Error("Enabling automatic updates was not saved");
    await snapshot(page, state, "orca-published-link");
    await dialog.getByRole("button", { name: "Close publication review", exact: true }).click();
  }
  await clickTab(page, "Shared Configs");
  await page.getByRole("link", { name: "Orca profiles", exact: true }).click();
  await page.getByRole("heading", { name: "QIDI fine detail", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Nozzle size", exact: true }).selectOption("0.2");
  await snapshot(page, state, "orca-registry-catalog");
  await page.getByRole("link", { name: "View profile", exact: true }).click();
  await page.getByRole("button", { name: "Download profile for OrcaSlicer", exact: true }).waitFor();
  await checkFieldHelp(page, state, "Download profile for OrcaSlicer", "public-orca-restore-help");
  await snapshot(page, state, "orca-public-profile");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download profile for OrcaSlicer", exact: true }).click();
  const download = await downloadPromise;
  if (download.suggestedFilename() !== "qidi-fine-detail.json") throw new Error("Incorrect public profile filename");
  await page.getByRole("link", { name: "Smoke bench configuration", exact: true }).click();
  await page.getByRole("region", { name: "Related Orca profiles", exact: true }).waitFor();
  await page.getByRole("link", { name: "QIDI fine detail", exact: true }).waitFor();
  await snapshot(page, state, "printer-config-related-orca-profiles");
}

async function captureAuthenticated(page, state) {
  await captureWorkspace(page, state);
    await runStep(state, "printer-picker-modal", async () => {
      await clickTab(page, "Printers");
      await page.getByRole("button", { name: "Add printer" }).click();
      await settle(page, ".printer-picker-modal");
      await snapshot(page, state, "printer-picker-modal");
      await snapshot(page, state, "printer-picker-modal-component", ".printer-picker-modal");
      await page.locator(".printer-picker-option").first().click();
      await page.getByPlaceholder("Workshop printer").fill("Smoke test printer");
      await page.locator(".printer-picker-modal").getByRole("button", { name: "Add printer" }).click();
      await page.locator(".printer-fleet-select").filter({ hasText: "Smoke test printer" }).waitFor();
      await page.locator(".printer-secondary-details summary").click();
      await page.getByPlaceholder("Printer name").waitFor();
      await snapshot(page, state, "printer-details");
      await snapshot(page, state, "printer-details-component", ".sync-setup-card");
      await page.locator(".printer-fleet-select").filter({ hasText: "Smoke bench printer" }).click();
    });
  for (const label of tabLabels.slice(1)) {
    await runStep(state, label, async () => {
      await clickTab(page, label);
      if (label === "Orca Workspace") {
        if (await page.getByRole("button", { name: "Open preset editor", exact: true }).count()) await page.getByRole("button", { name: "Open preset editor", exact: true }).click();
        await page.getByRole("button", { name: /Smoke filament preset/ }).click();
        if (await page.getByLabel("Preset name", { exact: true }).inputValue() !== "Smoke filament preset") throw new Error("The selected printer's preset was not loaded");
        await captureOrcaConnection(page, state);
      }
      await snapshot(page, state, label);
      if (label === "Shared Configs") await checkRegistryWarning(page, state);
      if (label === "Printers") await checkFieldHelp(page, state, "Printers", "printers-help");
      if (label.endsWith("Editor")) await checkFieldHelp(page, state, label, `${slug(label)}-help`);
    });
  }
  await runStep(state, "printer-management-tabs", async () => {
    await clickTab(page, "Printers");
    for (const label of ["CLI", "Integrations", "Settings"]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await settle(page);
      await snapshot(page, state, `printer-${label}`);
    }
  });
  for (const kind of ["machine", "process"]) {
    await runStep(state, `orca-${kind}-preset`, async () => {
      await clickTab(page, "Orca Workspace");
      if (await page.getByRole("button", { name: "Open preset editor", exact: true }).count()) await page.getByRole("button", { name: "Open preset editor", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`Smoke ${kind} preset`) }).click();
      if (await page.getByLabel("Preset name", { exact: true }).inputValue() !== `Smoke ${kind} preset`) throw new Error(`The ${kind} preset was not loaded`);
      await snapshot(page, state, `orca-${kind}-preset`);
    });
  }
  if (state.viewport === "desktop") {
    await runStep(state, "filament-components", async () => {
      await clickTab(page, "Orca Workspace");
      if (await page.getByRole("button", { name: "Open preset editor", exact: true }).count()) await page.getByRole("button", { name: "Open preset editor", exact: true }).click();
      await page.getByRole("button", { name: /Smoke filament preset/ }).click();
      await page.getByLabel("Preset name", { exact: true }).filter({ visible: true }).waitFor();
      if (await page.getByLabel("Preset name", { exact: true }).inputValue() !== "Smoke filament preset") throw new Error("Filament fixture was not loaded into the editor");
      await snapshot(page, state, "filament-profile-list-component", ".profile-sidebar");
      await snapshot(page, state, "filament-profile-editor-component", ".profile-edit-panel");
    });
    await runStep(state, "slicer-components", async () => {
      await clickTab(page, "Orca Workspace");
      if (await page.getByRole("button", { name: "Open preset editor", exact: true }).count()) await page.getByRole("button", { name: "Open preset editor", exact: true }).click();
      await page.getByRole("button", { name: /Smoke machine preset/ }).click();
      if (await page.getByLabel("Preset name", { exact: true }).inputValue() !== "Smoke machine preset") throw new Error("Machine fixture was not loaded into the editor");
      await snapshot(page, state, "slicer-profile-list-component", ".profile-sidebar");
      await snapshot(page, state, "slicer-profile-editor-component", ".profile-edit-panel");
    });
    await runStep(state, "printers-component", async () => {
      await clickTab(page, "Printers");
      await snapshot(page, state, "printer-fleet-component", ".printers-layout");
    });
    await runStep(state, "registry-package-detail", async () => {
      await clickTab(page, "Shared Configs");
      await page.locator(".package-card").first().click();
      await settle(page, ".public-config-workspace");
      await snapshot(page, state, "registry-package-detail");
      await page.locator(".public-config-back").click();
    });
    await runStep(state, "log-diagnostics-component", async () => {
      await clickTab(page, "Log Diagnostics");
      await settle(page, ".log-diagnostics");
      await snapshot(page, state, "log-diagnostics-component", ".log-diagnostics");
    });
    await runStep(state, "gridfinity-editor-component", async () => {
      await clickTab(page, "Gridfinity Editor");
      await settle(page, ".cad-editor-workspace");
      await snapshot(page, state, "gridfinity-editor-component", ".cad-editor-workspace");
    });
  }
}

async function captureRegistryPublisher(page, state, registryState) {
  await clickTab(page, "Klipper Workspace");
  await settle(page, ".slicer-layout");
  await page.getByRole("button", { name: "Publish to Shared Configs" }).click();
  await settle(page, ".registry-publisher-modal");
  const dialog = page.getByRole("dialog");
  // Collapsed source should keep the status and useful actions in view, even
  // when a printer has large configuration files.
  if (await dialog.locator("pre:visible").count()) throw new Error("Publisher source previews should start collapsed");
  const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth);
  if (overflow > 2) throw new Error(`Publisher has ${overflow}px of horizontal overflow`);
  if (registryState === "current") await dialog.getByRole("heading", { name: "Public listing is up to date" }).waitFor();
  if (registryState === "paused") {
    await dialog.getByRole("heading", { name: "Automatic updates paused" }).waitFor();
    if (await dialog.getByText("Automatic update needs review: resolve the safety findings or approve and republish manually.", { exact: true }).count() !== 1) {
      throw new Error("Publisher should show the automatic update problem once");
    }
  }
  await snapshot(page, state, `registry-${registryState}`);
  await dialog.getByText("Applied configuration", { exact: true }).click();
  await dialog.locator(".registry-publication-candidate-files summary").first().click();
  await dialog.getByLabel("Applied candidate source for printer.cfg").waitFor({ state: "visible" });
  await dialog.getByText("Listing details", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Listing title", exact: true }).waitFor({ state: "visible" });
  if (registryState === "paused") {
    await dialog.getByRole("button", { name: "Approve and republish", exact: true }).click();
    await dialog.getByRole("group", { name: /^Confirm public publication of/ }).waitFor({ state: "visible" });
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => globalThis.document.activeElement?.textContent?.trim() === "Publish to Shared Configs");
}

async function runPersona({ authenticated, baseUrl, persona, registryState, viewport }) {
  const context = await browser.newContext({
    colorScheme: "dark",
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
    reducedMotion: "reduce",
    viewport: { height: viewport.height, width: viewport.width },
  });
  await context.addInitScript(() => {
    globalThis.localStorage.clear();
    globalThis.sessionStorage.clear();
  });
  await context.route("**/api/**", createApiFixture(authenticated, registryState));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const state = { page, persona, scenario: "startup", viewport: viewport.name };
  attachDiagnostics(page, state);
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.addStyleTag({
      content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}",
    });
    if (process.env.UI_SMOKE_FEATURE === "registry-warning") await checkRegistryWarning(page, state);
    else if (process.env.UI_SMOKE_FEATURE === "keyboard-preview") await captureKeyboardPreview(page, state);
    else if (process.env.UI_SMOKE_FEATURE === "accessibility") await captureKeyboardAccess(page, state);
    else if (process.env.UI_SMOKE_FEATURE === "registry") await captureRegistryPublisher(page, state, registryState);
    else if (process.env.UI_SMOKE_FEATURE === "field-help") await captureFieldHelp(page, state);
    else if (process.env.UI_SMOKE_FEATURE === "orca-publishing") await captureOrcaPublishing(page, state, authenticated);
    else if (process.env.UI_SMOKE_FEATURE === "orca-library") await captureOrcaLibrary(page, state, authenticated);
    else if (process.env.UI_SMOKE_FEATURE === "orca") await captureOrcaConnection(page, state, authenticated);
    else if (process.env.UI_SMOKE_FEATURE === "account") await captureAccount(page, state, authenticated);
    else if (process.env.UI_SMOKE_FEATURE === "diagnostics") await capturePopulatedDiagnostics(page, state);
    else if (process.env.UI_SMOKE_FEATURE === "workspace" && authenticated) await captureWorkspace(page, state);
    else if (["workspace", "public-config"].includes(process.env.UI_SMOKE_FEATURE)) await capturePublicDetail(page, state);
    else if (process.env.UI_SMOKE_TOOL_ROUTE) await captureToolRoutes(page, state);
    else if (authenticated) await captureAuthenticated(page, state);
    else await captureAnonymous(page, state);
  } finally {
    await context.close();
  }
}

function markdownReport() {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  const lines = [
    "# Klippee UI smoke report",
    "",
    `- Run: ${report.runId}`,
    `- Base URL: ${report.baseUrl}`,
    `- Screenshots: ${report.screenshots.length}`,
    `- Browser errors: ${errors.length}`,
    `- Browser warnings: ${warnings.length}`,
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((item) => `- [${item.viewport} / ${item.persona} / ${item.name}](${item.file})`),
    "",
    "## Browser diagnostics",
    "",
  ];
  if (report.issues.length === 0) {
    lines.push("No console errors, page errors, failed requests, or HTTP errors were captured.");
  } else {
    lines.push("| Severity | Kind | Viewport | Persona | Scenario | Detail |", "| --- | --- | --- | --- | --- | --- |");
    for (const issue of report.issues) {
      const detail = issue.detail.replaceAll("|", "\\|").replaceAll("\n", " ");
      lines.push(`| ${issue.severity} | ${issue.kind} | ${issue.viewport} | ${issue.persona} | ${issue.scenario} | ${detail} |`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });
  let baseUrl = process.env.UI_SMOKE_BASE_URL;
  if (!baseUrl) {
    viteServer = await createServer({
      // Every API request has a browser fixture. No Worker or credentials are
      // needed to validate the frontend, including CAD previews and exports.
      configFile: false,
      logLevel: "warn",
      plugins: [react(), tailwindcss()],
      resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
      server: { host: "127.0.0.1", port: 4173, strictPort: false },
    });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a local TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  report.baseUrl = baseUrl;
  browser = await chromium.launch({ headless });
  const concurrency = 1;
  for (let index = 0; index < viewports.length; index += concurrency) {
    const batch = viewports.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map(async (viewport) => {
      if (process.env.UI_SMOKE_FEATURE === "registry") {
        for (const registryState of ["first-publication", "manual-update", "paused", "current"]) {
          await runPersona({ authenticated: true, baseUrl, persona: "authenticated", registryState, viewport });
        }
      } else {
        await runPersona({ authenticated: false, baseUrl, persona: "anonymous", viewport });
        await runPersona({ authenticated: true, baseUrl, persona: "authenticated", viewport });
      }
      console.log(`Completed ${viewport.name} (${viewport.width}x${viewport.height})`);
    }));
    results.forEach((result, offset) => {
      if (result.status === "rejected") addIssue({ detail: String(result.reason), kind: "harness-error", persona: "startup", scenario: "viewport-startup", severity: "error", url: baseUrl, viewport: batch[offset].name });
    });
    await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  report.finishedAt = new Date().toISOString();
  const errors = report.issues.filter((issue) => issue.severity === "error").length;
  const warnings = report.issues.filter((issue) => issue.severity === "warning").length;
  report.summary = { errors, screenshots: report.screenshots.length, warnings };
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "report.md"), markdownReport(), "utf8");
  console.log(`UI smoke artifacts: ${outputDir}`);
  console.log(`Screenshots: ${report.screenshots.length}; errors: ${errors}; warnings: ${warnings}`);
  if (errors > 0 && !allowErrors) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await viteServer?.close();
}
