# CAD Runtime Notices

The Klippee CAD container installs a pinned official OpenSCAD development
snapshot (with Debian's OpenSCAD package supplying its system runtime
dependencies) and build123d from PyPI. build123d supplies the OpenCascade
Technology (OCCT) bindings used for CAD import and reconstruction. These components run only inside
the transient CAD processing service; their binaries are not shipped to
browsers.

- OpenSCAD is licensed under the GNU General Public License version 2 or later.
  The pinned snapshot version and checksum are recorded in `Dockerfile.cad`.
  Source: https://github.com/openscad/openscad
- BOSL2 is licensed under the BSD 2-Clause License. The complete, pinned
  library is installed in the CAD container for OpenSCAD models that use
  `include <BOSL2/...>`.
  Source: https://github.com/BelfrySCAD/BOSL2
- build123d is licensed under the Apache License 2.0.
  Source: https://github.com/gumyr/build123d
- CadQuery OCP bindings are licensed under the Apache License 2.0.
  Source: https://github.com/CadQuery/OCP
- OpenCascade Technology is licensed under the GNU Lesser General Public
  License version 2.1 with the OCCT exception.
  Source: https://dev.opencascade.org/resources/licensing

The container image is assembled from the pinned packages in
`server/cad-requirements.txt` and `Dockerfile.cad`. User-provided source and
generated output retain their own rights and are not stored by Klippee.
