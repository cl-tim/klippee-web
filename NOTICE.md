# Klippee Notices

Klippee is free software licensed under the GNU General Public License,
version 2 or (at your option) any later version. See `LICENSE`.

## Transient CAD Service

Klippee runs OpenSCAD and OpenCascade Technology in a dedicated server-side CAD
container. OpenSCAD is licensed under the GNU General Public License version 2
or later. build123d and the CadQuery OCP bindings are licensed under
the Apache License 2.0, and OpenCascade Technology is licensed under the GNU
Lesser General Public License version 2.1 with the OCCT exception. Runtime and source details are
documented in `server/CAD_NOTICE.md`.

OpenSCAD is Copyright (C) the OpenSCAD developers and contributors.

The CAD runtime is provided without warranty. Requests are processed in a
temporary directory and returned directly; Klippee does not persist CAD source,
reconstructed OpenSCAD, or generated STL output. STEP, IGES, and BREP analysis
emits recognized native primitives and uses labelled reference meshes for
unresolved bodies. It does not claim to recover source sketches, constraints,
or feature history.

## Pre-loaded Parametric Model Sources

The OpenGrid Underware Editor includes Underware 2.0 and Monokini OpenSCAD
sources by Hands on Katie and BlackjackDuck (Andy). Those files and derived
parts are licensed under Creative Commons Attribution-NonCommercial-ShareAlike
4.0 International (CC BY-NC-SA 4.0). The original attribution and change-log
headers are retained in the bundled `.scad` files.

Documentation and project source:
https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/

The Gridfinity Editor includes the model files from Gridfinity Rebuilt in
OpenSCAD by kennetek, licensed under the MIT License. The bundled sources are
unmodified, pinned by SHA-256, and carry the retained upstream license,
including the underlying Gridfinity MIT license by Zachary Freedman and
Voidstar Lab LLC, in `src/features/cadEditors/scad/gridfinity/`.

Project source:
https://github.com/kennetek/gridfinity-rebuilt-openscad

Gridfinity was created by Zack Freedman. The OpenGrid Editor includes the
`openGrid.scad` design by David D. and OpenSCAD implementation by BlackjackDuck
(Andy). The supplied source and derived parts are respectively licensed under
Creative Commons Attribution-NonCommercial-ShareAlike 4.0 and Creative Commons
Attribution 4.0. Its original attribution and change-log header are retained.

Author profile:
https://makerworld.com/en/@BlackjackDuck
