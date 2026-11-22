# Gridfinity Rebuilt in OpenSCAD

The bundled OpenSCAD sources are the unmodified model files from:

- Project: https://github.com/kennetek/gridfinity-rebuilt-openscad
- Distribution: https://www.printables.com/model/274917-gridfinity-rebuilt-in-openscad
- Download: `gridfinity-rebuilt-in-openscad-model_files.zip`
- Archive SHA-256: `8622d755431f8ad7a67a64337b65c0d05894ad0e8eb2223b3c0e8b7ba964bd82`
- Retrieved: 2026-08-02
- License: MIT

Included files and their SHA-256 digests:

- `gridfinity-rebuilt-bins.scad`
  `0e745078deddc8c3dee633157303adc007717a18b18e1bccc98959bcc33a97e8`
- `gridfinity-rebuilt-lite.scad`
  `d77d251c367c0c2a69939d47196ab430b70c58139931771fbf269d3a18041c6a`
- `gridfinity-rebuilt-baseplate.scad`
  `0f369aa72d1a5dd0a05f39754898b2813055ed81b73f6c2b3ea2d358908ad4e9`
- `gridfinity-rebuilt-utility.scad`
  `53c5418fb4c9d5995950e3f4c6567e2595497c94ffae1849ed82725221e8ad36`
- `gridfinity-constants.scad`
  `fa5fca8994c52bb77d3ba7246e8d9584e376a41a3d804180900ca3eb07787bd8`

Each generator file includes `<gridfinity-rebuilt-utility.scad>`, which in turn
includes `<gridfinity-constants.scad>`. Klippee sends the selected generator
plus both shared files with every render request and names the generator as the
entry file. Typed Customizer values are passed through OpenSCAD command-line
definitions.

The upstream project recreates Zack Freedman's Gridfinity system.

Klippee production runtime: OpenSCAD 2026.04.05.

## Klippee compatibility changes

None. The sources are byte-for-byte as distributed, and the digests above are
the verification. The enumerated Customizer values (`gridz_define`,
`style_tab`, `style_hole`, `style_plate`) are integers upstream, so Klippee maps
its labelled select options back to those integers before rendering rather than
editing the sources.

Rendering was also verified against OpenSCAD 2021.01 as a compatibility floor.

The complete upstream license, including the underlying Gridfinity license, is
retained in `LICENSE.gridfinity-rebuilt`.
