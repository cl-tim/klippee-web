import { readFile } from "node:fs/promises";
import process from "node:process";
import { collectRuntimeDefinedVars, findUndefinedCssVars } from "./css-var-audit.mjs";

const textSourcePaths = {
  app: "src/App.tsx",
  appConstants: "src/app/constants.ts",
  authPanel: "src/features/workflows/AuthPanel.tsx",
  cadEditorLibraries: "src/features/cadEditors/libraries.ts",
  cadParameterControl: "src/features/cadEditors/ParameterControl.tsx",
  cadService: "server/cad_app.py",
  css: "src/styles.css",
  editor: "src/KlipperEditor.tsx",
  indexHtml: "index.html",
  logDiagnosticsView: "src/features/logDiagnostics/LogDiagnosticsView.tsx",
  modalShell: "src/components/ModalShell.tsx",
  openScadImportsHook: "src/features/openscad/useCadImports.ts",
  openScadView: "src/features/openscad/OpenScadView.tsx",
  openScadWorkspaceStorage: "src/features/openscad/workspaceStorage.ts",
  orcaWorkspaceView: "src/features/workflows/OrcaWorkspaceView.tsx",
  packageActions: "src/app/hooks/usePackageActions.ts",
  parametricCadEditor: "src/features/cadEditors/ParametricCadEditor.tsx",
  printerCatalog: "src/orcaPrinterCatalog.ts",
  printerDetailsModal: "src/features/workflows/PrinterDetailsModal.tsx",
  printerManagement: "src/features/workflows/printerManagement.ts",
  printerManagementComponents: "src/features/workflows/components/PrinterManagementComponents.tsx",
  printerSyncPanel: "src/features/workflows/PrinterSyncPanel.tsx",
  printersHook: "src/app/hooks/usePrinters.ts",
  printersView: "src/features/workflows/PrintersView.tsx",
  publicConfigWorkspace: "src/features/workflows/PublicConfigWorkspace.tsx",
  registryPublisherModal: "src/features/workflows/components/RegistryPublisherModal.tsx",
  registryView: "src/features/workflows/RegistryView.tsx",
  scadConverter: "server/scad_to_build123d.py",
  scadConverterView: "src/features/scadConverter/ScadToBuild123dView.tsx",
  scadImports: "worker/routes/scadImports.ts",
  setupDev: "scripts/setup-dev.mjs",
  slicerConfigImportConfirmModal: "src/features/workflows/components/ConfigImportConfirmModal.tsx",
  slicerPrinterCard: "src/features/workflows/components/PrinterCard.tsx",
  slicerPrinterPickerModal: "src/features/workflows/components/PrinterPickerModal.tsx",
  slicerWorkspaceEditor: "src/features/workflows/components/WorkspaceEditor.tsx",
  slicerWorkspaceFileBrowser: "src/features/workflows/components/WorkspaceFileBrowser.tsx",
  slicerWorkspaceRecoveryModal: "src/features/workflows/components/WorkspaceRecoveryModal.tsx",
  slicerWorkspaceView: "src/features/workflows/SlicerWorkspaceView.tsx",
  starterConfigs: "src/starterConfigs.ts",
  webManifest: "public/site.webmanifest",
  workflowBarrel: "src/features/workflows/WorkflowViews.tsx",
};

const binarySourcePaths = {
  appIcon: "public/icon-512.png",
  favicon: "public/favicon-32x32.png",
  socialPreview: "public/social-preview.png",
};

const sources = {};
await Promise.all([
  ...Object.entries(textSourcePaths).map(async ([name, filePath]) => {
    sources[name] = await readFile(filePath, "utf8");
  }),
  ...Object.entries(binarySourcePaths).map(async ([name, filePath]) => {
    sources[name] = await readFile(filePath);
  }),
]);

const {
  app,
  appConstants,
  appIcon,
  authPanel,
  cadEditorLibraries,
  cadParameterControl,
  cadService,
  css,
  editor,
  favicon,
  indexHtml,
  logDiagnosticsView,
  modalShell,
  openScadImportsHook,
  openScadView,
  openScadWorkspaceStorage,
  orcaWorkspaceView,
  packageActions,
  parametricCadEditor,
  printerCatalog,
  printerDetailsModal,
  printerManagement,
  printerManagementComponents,
  printerSyncPanel,
  printersHook,
  printersView,
  publicConfigWorkspace,
  registryPublisherModal,
  registryView,
  scadConverter,
  scadConverterView,
  scadImports,
  setupDev,
  slicerConfigImportConfirmModal,
  slicerPrinterCard,
  slicerPrinterPickerModal,
  slicerWorkspaceEditor,
  slicerWorkspaceFileBrowser,
  slicerWorkspaceRecoveryModal,
  slicerWorkspaceView,
  socialPreview,
  starterConfigs,
  webManifest,
  workflowBarrel,
} = sources;

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

const workflowViews = [
  workflowBarrel,
  authPanel,
  printersView,
  printerDetailsModal,
  registryView,
  publicConfigWorkspace,
  slicerWorkspaceView,
  printerSyncPanel,
  slicerPrinterCard,
  slicerWorkspaceFileBrowser,
  slicerWorkspaceEditor,
  slicerWorkspaceRecoveryModal,
  registryPublisherModal,
  slicerPrinterPickerModal,
  slicerConfigImportConfirmModal,
].join("\n");
const printerManagementView = `${printerSyncPanel}\n${printerManagementComponents}`;
const normalizedCss = css.replaceAll("\r\n", "\n");
const socialPreviewDimensions = {
  height: socialPreview.readUInt32BE(20),
  width: socialPreview.readUInt32BE(16),
};
const faviconDimensions = {
  height: favicon.readUInt32BE(20),
  width: favicon.readUInt32BE(16),
};
const appIconDimensions = {
  height: appIcon.readUInt32BE(20),
  width: appIcon.readUInt32BE(16),
};

assert(indexHtml.includes('property="og:title"'), "Open Graph title metadata is missing");
assert(indexHtml.includes('property="og:description"'), "Open Graph description metadata is missing");
const canonicalUrl = indexHtml.match(/rel="canonical" href="(https:\/\/[^"]+\/)"\s*\/?\s*>/)?.[1];
assert(canonicalUrl, "Canonical site URL is missing");
assert(
  indexHtml.includes(`property="og:image" content="${new URL("social-preview.png", canonicalUrl).href}"`),
  "Open Graph image must use an absolute URL on the canonical site",
);
assert(indexHtml.includes('content="1200"') && indexHtml.includes('content="630"'), "Social image dimensions are missing");
assert(
  socialPreviewDimensions.width === 1200 && socialPreviewDimensions.height === 630,
  "Open Graph image must be 1200x630",
);
assert(faviconDimensions.width === 32 && faviconDimensions.height === 32, "Favicon must be square at 32x32");
assert(appIconDimensions.width === 512 && appIconDimensions.height === 512, "High-resolution app icon must be 512x512");
assert(indexHtml.includes('name="twitter:card" content="summary_large_image"'), "Large Twitter card metadata is missing");
assert(
  JSON.parse(webManifest).icons.some((icon) => icon.src === "/icon-512.png" && icon.sizes === "512x512"),
  "Web manifest must expose a square high-resolution Klippee icon",
);

assert(
  appConstants.indexOf('"Printers"') < appConstants.indexOf('"Setup"')
    && appConstants.includes('Gridfinity: "Gridfinity Editor"')
    && appConstants.includes('OpenGrid: "OpenGrid Editor"')
    && appConstants.includes('Underware: "OpenGrid Underware Editor"'),
  "Primary navigation should keep Printers first and expose all three focused CAD editors",
);
assert(!appConstants.includes("STL Tools") && !app.includes('/stl-tools'), "Removed STL tools must not remain in navigation or routing");
assert(app.includes('from "./app/constants"'), "App shell should import shared app constants");
assert(app.includes('from "./features/workflows/WorkflowViews"'), "Workflow views should live outside App.tsx");
assert(workflowViews.includes("export function SlicerWorkspaceView"), "Slicer workspace view should live in the workflow feature module");
assert(!app.includes("function WorkflowView"), "Old setup WorkflowView scaffold should stay removed");
assert(appConstants.includes('Setup: "Klipper Workspace"'), "Setup tab should be labeled Klipper Workspace in the sidebar");
assert(app.includes("protectedTabLocked"), "Protected tabs must stay behind the auth gate");
assert(app.includes("AuthRequiredPanel"), "Protected-tab auth gate is missing");
assert(workflowViews.includes('sizeClass="login-modal"') && modalShell.includes("Modal.Content") && modalShell.includes("Modal.Title") && modalShell.includes("returnFocus trapFocus"), "Login modal semantics and focus management are missing");
assert(workflowViews.includes('closeLabel="Close login"'), "Login modal needs an accessible close button");
assert(authPanel.includes('label: "GitHub"') && authPanel.includes('aria-label={`${label} connected`}'), "Linked accounts should render their provider name and connection status");
assert(workflowViews.includes('className="sign-out-button"'), "Sign out action should have a distinct danger style hook");
assert(printersHook.includes("generatedPrinterName"), "New printers should receive generated names instead of requiring inline entry");
assert(app.includes("PrinterDetailsModal"), "Printer name and description editing should happen in a modal");
assert(
  slicerPrinterCard.includes("Manage or switch printer")
    && !slicerPrinterCard.includes("<select")
    && printersView.includes("selectPrinter(printer.id)"),
  "Printer switching should live only in the Printers workflow",
);
assert(workflowViews.includes('"slicer-editor"'), "Workspace editor pane surface is missing");
assert(
  slicerWorkspaceEditor.includes("Publish to Shared Configs")
    && registryPublisherModal.includes('"registry-publisher-modal"')
    && registryPublisherModal.includes("Publish to Shared Configs")
    && registryPublisherModal.includes("Approve and republish")
    && !slicerWorkspaceEditor.includes("registry-publish-card"),
  "Workspace publishing must open from the editor header in a dedicated registry publisher",
);
assert(
  !registryPublisherModal.includes("Use package")
    && !registryPublisherModal.includes("Create package")
    && !registryPublisherModal.includes("Search packages"),
  "Removed package browsing and private-build controls must not return to the workspace",
);
assert(
  registryPublisherModal.includes("Only printer-applied configurations are published. Draft edits stay private.")
    && registryPublisherModal.includes("RegistryAutoUpdateSettings")
    && registryPublisherModal.includes("Automatic updates paused")
    && !registryPublisherModal.includes("updates the public files automatically"),
  "Registry publishing must offer explicit opt-in automatic updates and keep drafts private",
);
assert(
  registryPublisherModal.includes("Applied configuration")
    && registryPublisherModal.includes("Applied candidate source for")
    && registryPublisherModal.includes("scanPublicConfigFiles(publicationCandidate?.files ?? [])")
    && !registryPublisherModal.includes("scanPublicConfigFiles(pendingWorkspaceFiles)")
    && !registryPublisherModal.includes("scanConfigFiles(pendingWorkspaceFiles)"),
  "Registry publishing must visibly review and scan the exact applied candidate",
);
assert(
  packageActions.includes("files: candidate.files")
    && packageActions.includes("variablesFromFiles(candidate.files, [])")
    && packageActions.includes("expectedAppliedVersionId"),
  "Linked publication must save and compare-and-swap the reviewed applied candidate",
);
assert(
  workflowViews.includes('pkg.tracksAppliedConfiguration ? "Community" : pkg.version')
    && workflowViews.includes("Shows the printer configuration last approved by its owner"),
  "Linked public workspace listings must use the Community label and explain their approval behavior",
);
assert(app.includes("<OpenScadView"), "OpenSCAD Studio route is missing");
assert(
  app.includes("<ScadToBuild123dView")
    && app.includes('path="/scad-to-build123d"')
    && scadConverterView.includes('fetch("/api/cad/convert-scad"')
    && scadConverterView.includes('className="scad-converter-workspace"')
    && css.includes(".scad-converter-panes"),
  "The OpenSCAD to build123d converter route, view, and layout must stay wired together",
);
assert(
  cadService.includes('@app.post("/api/convert-scad")')
    && cadService.includes("stage_scad_files(payload.get(\"files\")")
    && scadConverter.includes("def convert_csg")
    && scadConverter.includes("_unsupported"),
  "OpenSCAD to build123d conversion must reuse the validated file staging and report unsupported operations",
);
assert(
  app.includes('<ParametricCadEditor key="gridfinity" kind="gridfinity" />')
    && app.includes('<ParametricCadEditor key="opengrid" kind="opengrid" />')
    && app.includes('<ParametricCadEditor key="underware" kind="underware" />'),
  "Gridfinity, OpenGrid, and OpenGrid Underware routes must use the focused CAD editor",
);
assert(
  parametricCadEditor.includes('className="cad-editor-workspace"')
    && parametricCadEditor.includes('aria-label="Component library"')
    && parametricCadEditor.includes('aria-label="Component parameters"'),
  "Focused CAD editors need distinct component, preview, and parameter panels",
);
assert(
  parametricCadEditor.includes('render("preview")')
    && parametricCadEditor.includes('render("export")')
    && parametricCadEditor.includes('fetch(`/api/cad/render?mode=${mode}`'),
  "Focused CAD editors must preview and export through the transient CAD service",
);
assert(
  cadEditorLibraries.includes('id: "gridfinity-rebuilt-bin"')
    && cadEditorLibraries.includes('id: "gridfinity-rebuilt-lite-bin"')
    && cadEditorLibraries.includes('id: "gridfinity-rebuilt-baseplate"')
    && cadEditorLibraries.includes("Gridfinity Rebuilt in OpenSCAD by kennetek")
    && cadEditorLibraries.includes('id: "opengrid-lite-tile"')
    && cadEditorLibraries.includes('id: "opengrid-full-tile"')
    && cadEditorLibraries.includes("OpenSCAD by BlackjackDuck")
    && cadEditorLibraries.includes('exploredUnderwareModels.map(underwareModel)')
    && cadEditorLibraries.includes('import.meta.glob("./scad/monokini/*.scad"'),
  "Focused CAD libraries must preload Gridfinity, OpenGrid, Underware 2.0, and Monokini components",
);
assert(
  css.includes(".cad-editor-workspace")
    && css.includes("grid-template-columns: minmax(250px, 0.78fr) minmax(420px, 1.55fr) minmax(280px, 0.9fr)")
    && css.includes("@media (max-width: 1040px)"),
  "Focused CAD editors need a three-panel desktop layout and a narrow-screen fallback",
);
assert(app.includes("<LogDiagnosticsView"), "Log Diagnostics route is missing");
assert(logDiagnosticsView.includes('className="log-diagnostics"'), "Log Diagnostics workspace surface is missing");
assert(logDiagnosticsView.includes("downloadKlippyHtmlReport"), "Log Diagnostics HTML export is missing");
assert(openScadView.includes('className="openscad-workspace"'), "OpenSCAD workspace surface is missing");
assert(openScadView.includes("parseOpenScadParameters"), "OpenSCAD Customizer parameter parsing is not wired in");
assert(cadParameterControl.includes("parameter.description"), "OpenSCAD parameter descriptions are not rendered");
assert(openScadView.includes('render("preview")') && openScadView.includes('render("export")'), "OpenSCAD preview and export flows must stay separate");
assert(!openScadView.includes('"Fine"'), "OpenSCAD Studio should not expose selectable render quality");
assert(openScadView.includes('fetch(`/api/cad/${endpoint}?mode=${mode}`'), "CAD rendering must use the transient CAD API");
assert(
  openScadView.includes('`render-${currentEngine}`')
    && cadService.includes('@app.post("/api/render-build123d")'),
  "build123d rendering must use a constrained transient API",
);
assert(
  openScadImportsHook.includes('target=${conversionTarget === "openscad" ? "scad" : conversionTarget}')
    && openScadView.includes('<NativeSelect') && openScadView.includes('aria-label="Reconstruction output"') && openScadView.includes('value: "build123d"') && openScadView.includes('setConversionTarget(value'),
  "CAD reconstruction target selection is missing",
);
assert(
  openScadView.includes('readOnly={currentEngine !== "openscad"}'),
  "Generated Python CAD source must not be executable browser input",
);
assert(openScadView.includes("autosaved only in this browser"), "OpenSCAD must explain its browser-only workspace storage");
assert(openScadImportsHook.includes('fetch("/api/cad/import-scad"'), "OpenSCAD URL import must use the bounded same-origin API");
assert(openScadView.includes("public GitHub repository, folder, or file URL"), "OpenSCAD URL import guidance is missing");
assert(
  openScadWorkspaceStorage.includes("openScadWorkspaceStorageName")
    && openScadWorkspaceStorage.includes("storage.saveStored")
    && openScadView.includes("useAccountStorage"),
  "OpenSCAD workspace persistence must remain account-scoped",
);
assert(scadImports.includes("maxImportTotalBytes") && scadImports.includes("safeRemoteUrl"), "Remote SCAD imports need size and URL safety checks");
assert(!openScadView.includes("Starter template"), "Removed OpenSCAD starter templates must not return");
assert(
  openScadView.includes("BOSL2 is available when rendering")
    && openScadView.includes("include &lt;BOSL2/std.scad&gt;"),
  "OpenSCAD Studio must explain how to use its bundled BOSL2 library",
);
assert(
  css.includes("grid-template-rows: auto minmax(0, 1fr) auto auto auto;"),
  "OpenSCAD preview must shrink within the available browser height",
);
assert(
  normalizedCss.includes(".openscad-source-editor {\n  flex: 1;\n  min-height: 0;"),
  "OpenSCAD source editor must scroll instead of increasing the page height",
);
assert(cadService.includes('"storage": "none"'), "CAD health must explicitly report that storage is disabled");
assert(cadService.includes("TemporaryDirectory"), "CAD processing must use temporary workspaces");
assert(cadService.includes('24 if mode == \'preview\' else 48'), "OpenSCAD previews should use Draft facets and exports should use Normal facets");
assert(app.includes("<OrcaWorkspaceView"), "Orca workspace route is missing");
assert(orcaWorkspaceView.includes("export function OrcaWorkspaceView"), "Orca workspace view should live in the workflow feature module");
assert(!orcaWorkspaceView.includes("usePrinterContext") && !orcaWorkspaceView.includes("assignCompanionAssetsToPrinter"), "Orca profile library must stay independent of the selected physical printer");
assert(app.includes("https://ko-fi.com/tquinn"), "Ko-fi support link is missing");
assert(!app.includes("kofiWidgetOverlay"), "Ko-fi floating widget should stay removed; use the sidebar link instead");
assert(!app.includes("overlay-widget.js"), "Ko-fi overlay script should not load");
assert(printerCatalog.includes("generic-klipper-cartesian"), "Printer catalog should include launch-ready starter choices");
assert(!starterConfigs.includes("export const starterConfigs: StarterConfig[] = [];"), "Starter config onboarding must not be an empty scaffold");
assert(starterConfigs.includes("Generic Cartesian Klipper Starter"), "Starter configs should include a reviewed Cartesian starter");

assert(modalShell.includes("Modal.Overlay") && modalShell.includes("zIndex={200}"), "Modal overlay must sit above app and workspace navigation");
assert(modalShell.includes('"login-modal": 420'), "Login dialog should retain its focused width");
assert(css.includes(".sidebar-auth-slot") && css.includes("margin-top: auto"), "Auth panel should stay anchored low in the sidebar");
assert(authPanel.includes('className="sign-out-button" color="red"'), "Sign out action should use Mantine danger styling");
assert(css.includes(".printer-summary-row"), "Selected printer summary row should support the edit action");
assert(modalShell.includes('"printer-details-modal": 480'), "Printer details dialog should retain its focused width");
assert(workflowViews.includes("<PageHeader"), "Workflow routes should use the shared page header");
assert(workflowViews.includes("<ModalShell"), "Workflow dialogs should use the shared Mantine modal shell");
assert(workflowViews.includes("<SearchField"), "Package search should use the shared search field");
assert(printerManagementView.includes("linkCurrentPrinter"), "Printer sync should support linking an existing printer");
assert(printerManagementView.includes("buildPrinterInstallCommand(configDirectory, true)"), "Printer management should generate a first-capture command");
assert(
  printerManagementView.includes("Run the setup command on the printer host")
    && printerManagementView.includes('command="hlab klippee target"')
    && printerManagementView.includes('command="hlab klippee check --diff"')
    && printerManagementView.includes('command="hlab klippee capture"')
    && printerManagementView.includes('command="hlab klippee apply"'),
  "Printer management should expose target-aware capture and apply commands",
);
assert(
  slicerWorkspaceView.includes('navigate("/printers?section=cli")') && !slicerWorkspaceView.includes("InstallModal"),
  "Workspace Install should route to printer CLI instructions instead of opening a duplicate modal",
);
assert(printerManagementView.includes("Desktop IDE") && printerManagementView.includes("Generate setup command"), "Printer sync should expose the desktop IDE workflow");
assert(
  printerManagementView.includes("desktop-sync-workflow") &&
    !printerManagementView.includes("desktop-setup-steps") &&
    printerManagementView.includes("Create your configuration folder") &&
    printerManagementView.includes("Connect hlab and download the configuration") &&
    printerManagementView.includes("Edit and sync your configuration") &&
    printerManagementView.includes("hlab klippee target") &&
    printerManagementView.includes("<HlabReleaseDownloads platform={desktopPlatform}"),
  "Desktop CLI setup should present exactly three progressive workflow steps",
);
assert(
  printerManagementView.includes('aria-label="Desktop operating system"') &&
    printerManagementView.includes("Windows") &&
    printerManagementView.includes("macOS / Linux") &&
    !printerManagementView.includes("desktopDirectory"),
  "Desktop CLI setup should use the terminal working directory instead of a separate path field",
);
assert(
  printerManagementView.includes("klippee install-moonraker") && printerManagementView.includes("Mainsail and Fluidd"),
  "Printer sync should expose the Moonraker macro installer",
);
assert(printersView.includes("PrinterSyncPanel"), "Printer sync should live on the Printers page");
assert(printerManagementView.includes("Connect hlab") && printerManagementView.includes("Generate setup command"), "Attached printers should offer a regenerated CLI setup command");
assert(
  !printerManagementView.includes("Manage configuration from the printer host") &&
    normalizedCss.includes(".cli-install-card,\n.cli-command-card {\n  width: 100%;\n}"),
  "CLI instructions should avoid a redundant intro and use the full printer detail width",
);
assert(
  printerManagementView.includes("printer-management-tabs") && printerManagementView.includes("Manage CLI access"),
  "Secondary printer tasks should use progressive sections with CLI access collapsed",
);
assert(printerManagementView.includes("hostInfo"), "Attached printers should render reported host details");
assert(
  normalizedCss.includes(".printer-management-shell {\n  display: grid;") &&
    normalizedCss.includes("grid-template-columns: minmax(250px, 300px) minmax(0, 1fr);"),
  "Printers page should use a stable fleet and detail layout",
);
assert(
  css.includes("@media (max-width: 980px)") && css.includes(".printer-management-tabs"),
  "Printer management should provide a compact responsive layout and progressive sections",
);
assert(printersView.includes("No host report") && !printersView.includes("packageIds.length"), "Printer fleet rows should prioritize connection and config state");
assert(printerManagementView.includes('value={!appliedVersion ? "Not reported"') && !printerManagementView.includes("appliedVersion ?? latestVersion"), "Unknown applied state must not fall back to desired configuration");
assert(
  printerManagement.includes("return printer.latestVersionId || 0"),
  "The latest desired pointer should remain the printer configuration target",
);
assert(
  slicerPrinterPickerModal.includes("Name your printer") &&
    !slicerPrinterPickerModal.includes('onClick={() => startPrinterDraftFromCatalog(option)}') &&
    slicerPrinterPickerModal.includes("startPrinterDraftFromCatalog(option, details)"),
  "Adding a printer should confirm its identity before creating the profile",
);
assert(css.includes("--control-height: 2.75rem") && css.includes("--text-body: 1rem") && css.includes("--text-secondary: 0.875rem"), "Readable shared type and control sizing tokens are missing");
assert(registryView.includes('className="panel registry-view"'), "Registry should use its bounded catalog layout");
assert(
  css.includes(".registry-view") && css.includes("width: min(100%, 1180px)"),
  "Registry catalog must stay contained on wide screens",
);
assert(css.includes("@media (max-width: 980px)"), "Tablet responsive breakpoint is missing");
assert(css.includes("@media (max-width: 560px)"), "Mobile responsive breakpoint is missing");
assert(css.includes(".slicer-layout") && css.includes("grid-template-columns"), "Slicer layout grid is missing");
assert(
  slicerWorkspaceView.includes('aria-label="Workspace files and printer"') &&
    slicerWorkspaceView.includes('aria-controls="slicer-workspace-navigation"') &&
    slicerWorkspaceView.includes("Files &amp; printer") &&
    slicerWorkspaceFileBrowser.includes("onFileSelected") &&
    !css.includes("@media (max-width: 1700px)") &&
    slicerWorkspaceView.includes("<Drawer") &&
    slicerWorkspaceView.includes("returnFocus") &&
    slicerWorkspaceView.includes("trapFocus") &&
    css.includes("min-height: clamp(480px, 62dvh, 720px)"),
  "Klipper file navigation must stay visible at desktop widths and use a drawer only below the tablet breakpoint",
);
assert(
  app.includes("appNavigationExpanded") &&
    app.includes("appNavigationPinned") &&
    app.includes("Collapse app menu") &&
    app.includes("Pin app menu") &&
    css.includes(".app-shell.is-navigation-collapsed") &&
    css.includes(".sidebar.is-collapsed .tab"),
  "The desktop app navigation must remain collapsible and pinnable",
);
assert(
  normalizedCss.includes(".workspace-layout > *,\n.slicer-layout > *") &&
    normalizedCss.includes(".workspace-layout,\n  .slicer-layout,") &&
    normalizedCss.includes("grid-template-columns: minmax(0, 1fr)"),
  "Klipper workspace panels must stack and remain contained below the tablet breakpoint",
);
assert(css.includes(".klipper-editor .cm-editor"), "Editor pane styling is missing");
assert(css.includes(".klipper-editor .cm-content"), "Editor content styling is missing");
assert(css.includes("white-space: pre"), "Editor content must remain visible when CodeMirror inline styles are blocked");
assert(
  normalizedCss.includes(".klipper-editor .cm-lineNumbers {") &&
    normalizedCss.includes("flex: 0 0 5ch;") &&
    normalizedCss.includes("width: 5ch;"),
  "CodeMirror line numbers must keep a stable width across files",
);
assert(
  editor.includes("{ dark: true }") &&
    normalizedCss.includes(".cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground") &&
    normalizedCss.includes("rgba(103, 216, 189, 0.18) !important"),
  "CodeMirror selections must use the high-contrast dark-theme highlight",
);
assert(!css.includes(".cm-gutterElement {\n  box-sizing: border-box;\n  min-height"), "CodeMirror gutter elements must not force a fake line row");
assert(!slicerWorkspaceView.includes('className="slicer-right"'), "Klipper tools should no longer be squeezed into a right rail");
assert(
  slicerWorkspaceView.includes('className="slicer-workspace-main"') &&
    !slicerWorkspaceView.includes("<PackagePanel") &&
    slicerWorkspaceView.includes("WorkspaceRecoveryModal") &&
    slicerWorkspaceView.includes('aria-label="Workspace actions"') &&
    slicerWorkspaceRecoveryModal.includes("Delete recovery point") &&
    editor.includes("contextualVariableTooltip") &&
    editor.includes("Set variable value") &&
    editor.includes("Make variable") &&
    css.includes(".cm-variable-tooltip") &&
    !slicerWorkspaceEditor.includes("Select a value first"),
  "Klipper variables must use contextual CodeMirror actions without a persistent bottom dock",
);
assert(
  !slicerWorkspaceEditor.includes("selectedPackage?.variables")
    && !slicerWorkspaceEditor.includes("Package variables appear here"),
  "Registry package variables must not leak into the current printer workspace",
);
assert(!editor.includes('return "section"'), "CodeMirror stream language should not emit an unsupported section highlight token");
assert(css.includes(".support-link"), "Ko-fi support link styling is missing");
assert(
  setupDev.includes('"wrangler"') &&
    setupDev.includes('"d1"') &&
    setupDev.includes('"migrations"') &&
    setupDev.includes('"apply"') &&
    setupDev.includes('"DB"') &&
    setupDev.includes('"--local"'),
  "setup:dev must apply local D1 migrations so localhost testing has a schema",
);

const runtimeDefinedVars = await collectRuntimeDefinedVars();
for (const problem of findUndefinedCssVars(css, runtimeDefinedVars)) {
  failures.push(`src/styles.css:${problem.line} uses var(${problem.name}) but ${problem.name} is never defined`);
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`not ok - ${message}`);
  }
  console.error(`${failures.length} UI guardrail failure${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}

console.log("ok - UI guardrails for auth gating, modal layering, editor, registry publishing, log diagnostics, OpenSCAD, CSS tokens, and responsive breakpoints");
