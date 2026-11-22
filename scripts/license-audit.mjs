import { readFile, stat } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const failures = [];

if (rootPackage.license !== "GPL-2.0-or-later") {
  failures.push("package.json must declare GPL-2.0-or-later");
}

for (const [packagePath, pkg] of Object.entries(lock.packages ?? {})) {
  if (!packagePath || !pkg.version || !pkg.license) continue;
  if (/\bAGPL(?:[-\s]|\b)/i.test(String(pkg.license))) {
    failures.push(`${packagePath.replace(/^node_modules\//, "")} ${pkg.version} uses ${pkg.license}`);
  }
}

const requiredFiles = [
  ["LICENSE", 15_000],
  ["Dockerfile.cad", 300],
  ["server/cad-requirements.txt", 80],
  ["server/CAD_NOTICE.md", 500],
  ["src/features/cadEditors/scad/gridfinity/LICENSE.gridfinity-rebuilt", 2_000],
  ["src/features/cadEditors/scad/gridfinity/UPSTREAM.md", 500],
  ["src/features/cadEditors/scad/opengrid/openGrid.scad", 30_000],
  ["src/features/cadEditors/scad/opengrid/UPSTREAM.md", 500],
];

for (const [file, minimumBytes] of requiredFiles) {
  try {
    const fileStat = await stat(file);
    if (fileStat.size < minimumBytes) failures.push(`${file} is unexpectedly small`);
  } catch {
    failures.push(`${file} is missing`);
  }
}

const notice = await readFile("NOTICE.md", "utf8");
const cadNotice = await readFile("server/CAD_NOTICE.md", "utf8");
const underwareSource = await readFile("src/features/cadEditors/scad/underware/Underware_I_Channel.scad", "utf8");
const monokiniSource = await readFile("src/features/cadEditors/scad/monokini/monokini_I_channel.scad", "utf8");
const gridfinitySource = await readFile(
  "src/features/cadEditors/scad/gridfinity/gridfinity-rebuilt-bins.scad",
  "utf8",
);
const gridfinityLicense = await readFile(
  "src/features/cadEditors/scad/gridfinity/LICENSE.gridfinity-rebuilt",
  "utf8",
);
const gridfinityNotice = await readFile("src/features/cadEditors/scad/gridfinity/UPSTREAM.md", "utf8");
const openGridSource = await readFile("src/features/cadEditors/scad/opengrid/openGrid.scad", "utf8");
const openGridNotice = await readFile("src/features/cadEditors/scad/opengrid/UPSTREAM.md", "utf8");
if (!notice.includes("Transient CAD Service") || !notice.includes("does not persist CAD")) {
  failures.push("NOTICE.md must disclose transient server-side CAD processing");
}
if (
  !notice.includes("Pre-loaded Parametric Model Sources")
  || !notice.includes("CC BY-NC-SA 4.0")
  || !underwareSource.includes("Attribution Non-Commercial Share-Alike")
  || !monokiniSource.includes("Attribution Non-Commercial Share-Alike")
) {
  failures.push("Bundled Underware and Monokini SCAD sources must retain their attribution and license disclosure");
}
if (
  !notice.includes("Gridfinity Editor includes the model files")
  || !notice.includes("https://github.com/kennetek/gridfinity-rebuilt-openscad")
  || !gridfinityNotice.includes("8622d755431f8ad7a67a64337b65c0d05894ad0e8eb2223b3c0e8b7ba964bd82")
  || !gridfinityNotice.includes("License: MIT")
  || !gridfinityNotice.includes("Klippee production runtime: OpenSCAD 2026.04.05")
  || !gridfinitySource.includes("https://github.com/kennetek/gridfinity-rebuilt-openscad")
  || !gridfinityLicense.includes("Copyright (c) 2023 Kenneth Hodson")
  || !gridfinityLicense.includes("Copyright (c) 2023 Zachary Freedman and Voidstar Lab LLC")
) {
  failures.push("Bundled Gridfinity Rebuilt sources must retain their pinned provenance and MIT disclosure");
}
if (
  !notice.includes("OpenGrid Editor includes the")
  || !notice.includes("BlackjackDuck")
  || !openGridSource.includes("OpenSCAD by BlackjackDuck")
  || !openGridSource.includes("Attribution Non-Commercial Share-Alike")
  || !openGridNotice.includes("418e259f293db9cf10bd1f2137c04ee00719ef625c303151908e879c843cfd8e")
) {
  failures.push("Bundled openGrid source must retain its attribution, license, and supplied-source provenance");
}
for (const dependency of ["OpenSCAD", "BOSL2", "build123d", "CadQuery OCP", "OpenCascade Technology"]) {
  if (!cadNotice.includes(dependency)) failures.push(`server/CAD_NOTICE.md must disclose ${dependency}`);
}

if (failures.length) {
  console.error("License audit failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("ok - project license, dependency compatibility, and native CAD runtime notices verified");
