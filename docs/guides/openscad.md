# Parametric CAD Editors

Klippee includes focused editors for Gridfinity, openGrid, and OpenGrid
Underware components. Each editor opens with its model library, parameters, 3D
preview, and STL export in one workspace. The OpenGrid Underware editor includes
the explored Underware 2.0 and Monokini SCAD sets. The Gridfinity editor uses
the pinned, unmodified bin, Lite bin, and baseplate generators from
[Gridfinity Rebuilt in OpenSCAD](https://github.com/kennetek/gridfinity-rebuilt-openscad)
instead of approximate Klippee geometry. Those generators share a utility and a
constants file, which Klippee sends alongside whichever generator is selected.
The OpenGrid editor uses the supplied `openGrid.scad` generator by
BlackjackDuck (Andy), replacing Klippee's earlier approximate panel and
accessory geometry with its real Full, Lite, print-stack, and fill-space
options.

## Focused Editor Workflow

1. Open **Gridfinity Editor**, **OpenGrid Editor**, or **OpenGrid Underware
   Editor** from the primary navigation.
2. Choose the component type in the left panel.
3. Adjust its dimensions and fit controls in the right panel.
4. Generate and inspect the interactive preview.
5. Export the STL. Klippee performs a fresh export render and returns it
   directly to the browser.

CAD requests use temporary server directories. Source files, generated source,
parameter values, and generated STL data are not written to D1 or R2 and are
discarded after each response. Signing in does not change that behavior.

The focused editors remember the selected component and its parameter values in
that browser. Their pre-loaded sources are sent only when previewing or
exporting.

## Advanced OpenSCAD Workspace

The unlisted `/openscad-studio` route retains the general-purpose workspace for
uploading or dropping `.scad` files, importing public SCAD URLs, and
reconstructing STEP, IGES, or BREP files as OpenSCAD or build123d.
Each format has its own source file and renderer. The workspace is intended for
source-level CAD work rather than the common component-generator workflow.

## OpenSCAD to build123d

The unlisted `/scad-to-build123d` route converts a single OpenSCAD script into
[build123d](https://build123d.readthedocs.io/) Python source. Paste or drop a
`.scad` file, convert, then copy or download the result.

It does not parse OpenSCAD directly. OpenSCAD's own `csg` export flattens the
script first, resolving every module, function, loop, variable, and `$fn` into a
canonical tree of primitives and transforms, and that tree is what gets
translated. Conversion is therefore resolution independent: a `circle` stays a
circle rather than becoming the polygon a mesh export would produce.

Most of the CSG vocabulary maps directly. `multmatrix` becomes a `Pos` or a
`Matrix` transform, the booleans become `+`, `-`, and `&`, `linear_extrude`
becomes `extrude`, and `rotate_extrude` becomes `revolve`. An OpenSCAD
`linear_extrude` with `scale` lofts between two profiles rather than using a
draft angle, because OpenSCAD scales the profile instead of applying a constant
taper.

Some OpenSCAD operations have no build123d equivalent:

- 3D `hull` has no OCCT convex hull. 2D `hull` maps to `make_hull`.
- `minkowski` only converts when its second operand is a sphere, which is a
  uniform 3D offset. General Minkowski sums do not convert.
- `polyhedron`, `projection`, `surface`, and twisted `linear_extrude` are not
  converted.

Those emit a `FIXME` comment and a call that raises, so generated code is never
quietly wrong about geometry, and they are listed with a coverage percentage
after conversion. Enumerated values are reported per operation rather than as a
single pass or fail.

Conversion itself needs only OpenSCAD. The output is source text and nothing
executes it server-side, so it does not use the build123d install that the
reconstruction renderer depends on.

## CAD Conversion

STEP, IGES, and BREP files contain final boundary representation geometry, but
usually do not contain a portable history of the source CAD operations. Klippee
recognizes defensible native primitives and constant-section profiles, initially
boxes, cylinders, tubes, and linear extrusions. It emits readable dimensions
and positions as parameters shared by both output formats.

Bodies that cannot be reconstructed confidently remain clearly labelled,
dimensionally adjustable reference geometry. OpenSCAD embeds a reference mesh;
build123d embeds the exact BREP body. Recognition coverage is shown after
conversion, and reference geometry can be hidden with `show_reference_parts`.
It is intended as a scaffold for replacing unresolved modules, not as a claim
that sketches, constraints, fillets, or the original feature tree were recovered.

Uploads are limited to 64 MB. OpenSCAD render requests may contain up to 64
source files. Public URL imports may contain up to 64 files, 1 MB per file and
8 MB in total. Production allows 20 CAD operations per source address per
minute, while conversion and rendering still run one at a time per CAD
container. OpenSCAD source may include other `.scad` files supplied in the same
request; external file imports and absolute paths are rejected.

### Python CAD safety boundary

build123d reconstruction produces a standalone `.py` file for
download, but browser source is never submitted for execution. Preview and
export requests contain only the validated reconstruction plan and typed
parameter values. A child-process renderer translates that plan through direct
build123d API calls. It does not execute downloaded or browser-displayed Python. Generated
Python remains editable output without exposing a general-purpose remote
Python runner.

## Parameter Detection

The workspace recognizes scalar OpenSCAD Customizer assignments:

```scad
/* [Shape] */
// Overall outside width in millimetres.
width = 40; // [10:0.5:100]
profile = "round"; // [round:Round,square:Square]
centered = true;
label = "Klippee"; // Text embossed on the model.

/* [Hidden] */
internal_value = 12;
```

Numeric ranges become number controls, option lists become selects, booleans
become checkboxes, and strings become text fields. Values are passed to
OpenSCAD with validated `-D` definitions, including bounded vectors. Where a
bundled generator takes an integer for an enumerated choice, as Gridfinity
Rebuilt does for its height mode, tab, hole, and plate styles, the editor shows
readable labels and maps them back to the upstream integers rather than editing
the source. The pinned runtime enables OpenSCAD's `textmetrics` feature for
models that generate labels.

## Local Development

Install both Python requirement sets with `npm run setup:dev`, then run the CAD
API and Vite in separate terminals:

```bash
npm run dev:cad
npm run dev
```

Native OpenSCAD and build123d rendering are available in the
production container. For an equivalent local Linux runtime, use
`npm run docker:cad:build` followed by `npm run docker:cad:run`.

## Licensing

Klippee is licensed under GPL-2.0-or-later. Native runtime licensing and source
links are recorded in `NOTICE.md` and `server/CAD_NOTICE.md`. User-provided CAD
and generated geometry retain their own rights and are never published or
stored automatically.

build123d is Apache-2.0 licensed and is installed in the CAD container for
reconstruction rendering. The OpenSCAD converter does not rely on it: converted
output is returned as source text and is never executed server-side, so running
that output only needs build123d wherever you run it. Converted source inherits
the rights of the OpenSCAD script it came from.
