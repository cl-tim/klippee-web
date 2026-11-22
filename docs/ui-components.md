# UI components

Klippee uses Mantine for application controls and shadcn for composed panels.
Both use the dark teal theme in `src/app/uiTheme.ts`, mounted once by
`src/app/UiProvider.tsx`. Body text is 16px; secondary text is 14px. Controls
use Mantine's medium size, and icon actions have a 44px target.

## Component ownership

- Mantine owns the app shell, navigation, buttons, inputs, checkboxes, numeric
  fields, badges, tabs, accordions, alerts, dialogs, and the compact workspace drawer.
- shadcn's installed Card, Separator, and Skeleton components live in
  `src/components/ui/`. `components.json` records the registry style and aliases.
- Shared page headings, search, status panels, and warnings live in
  `src/components/common.tsx`; dialogs use `ModalShell` for consistent widths,
  labeling, focus trapping, Escape dismissal, and focus return.
- React Aria continues to own the workspace file Tree. CodeMirror, source
  editors, CAD canvases, and keyboard-resizable panels keep their specialist
  behavior.

Use the owning library's component for new standard controls. Use a composed
Mantine UnstyledButton for a clickable card or drop zone, with its layout and
visual properties supplied through Mantine props/styles. Regular Button labels
wrap on narrow screens while retaining a 44px minimum height. Use short
action labels; use UnstyledButton for an entire card or drop zone.

## Theme and layout

`uiCssVariables` maps Mantine's palette to the shadcn semantic variables and
the existing layout variables. Change typography and colors there so both
packs stay consistent. Avoid per-screen font sizes below the shared secondary
size. Use explicit red outline buttons or red subtle icon actions for
destructive controls.

`src/styles.css` retains domain layouts and specialist editor styling inside
`@layer legacy`. Mantine's component styles and Tailwind utilities take
precedence. Do not rely on a legacy class to override a library component's
padding, height, background, border, or display. Mantine input `className`
targets the outer wrapper; use `classNames.input` or `styles.input` when a
class or layout property belongs to the actual input.

Let Mantine generate both ends of tab and dialog accessibility relationships.
Use SegmentedControl for a value picker that does not switch tab panels.

## Verification

Run `npm run check` for the repository gate and `npm run test:ui:smoke` for
desktop/mobile browser scenarios and screenshots. The browser smoke harness
uses mock API data and does not contact physical printers.

Set `UI_SMOKE_RESPONSIVE=1` to check the 13-size matrix (320px through
2560px, landscape, sidebar breakpoints, and a 200% layout). Use
`UI_SMOKE_VIEWPORTS` with comma-separated profile names for a focused repeat.
`UI_SMOKE_FEATURE=workspace`, `public-config`, `diagnostics`, or `account` and
`UI_SMOKE_TOOL_ROUTE=scad-converter` limit a repeat to the changed surface.
Artifacts default to `output/playwright/ui-smoke/<run>/`. The harness starts a
frontend-only local server; it needs neither Worker credentials nor a printer.

The account scenario covers the footer, login, keyboard menu navigation,
Escape focus return, and the collapsed sidebar. Set `UI_SMOKE_ACCOUNT_NAME`
and `UI_SMOKE_ACCOUNT_PROVIDERS` (comma-separated `github,discord`, or an empty
value for neither) to review long names and linked/unlinked providers.

Review the images as well as the assertions: clipped card labels and wrapper sizing can pass
functional tests.

Component tests use `renderWithUi` / `TestUiProvider` from
`src/test/uiTestUtils.tsx`; mount the UI provider outside storage/query
providers so their loading and error panels also receive the theme.
