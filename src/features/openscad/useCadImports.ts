import { useState } from "react";
import { apiError } from "../../lib/api";
import type {
  CadEngine,
  OpenScadParameter,
  OpenScadRenderMode,
  OpenScadSourceFile,
} from "./types";

const maxCadFileBytes = 64 * 1024 * 1024;

type CadConversionResponse = {
  bodyCount: number;
  duration: number;
  engine: "build123d" | "scad";
  parameters?: OpenScadParameter[];
  plan?: Record<string, unknown>;
  recognizedBodyCount: number;
  referenceBodyCount: number;
  source: string;
  triangleCount: number;
  vertexCount: number;
};

type ScadImportResponse = {
  files: Array<{ name: string; source: string }>;
  mainFile: string;
  sourceUrl: string;
};

type UseCadImportsOptions = {
  /** Merge imported files into the workspace and make `main` the entry file. */
  applyImportedFiles: (imported: OpenScadSourceFile[], main: OpenScadSourceFile) => void;
  /** Discard the current preview buffer. */
  clearPreview: () => void;
  renderingMode: OpenScadRenderMode | null;
  requestControllerRef: { current: AbortController | null };
  setError: (message: string) => void;
  setStatus: (message: string) => void;
};

/**
 * File, URL, and CAD-conversion imports for the OpenSCAD workspace. The three
 * import paths share one AbortController (via `requestControllerRef`, also
 * shared with rendering) so starting a new request cancels the previous one.
 */
export function useCadImports({
  applyImportedFiles,
  clearPreview,
  renderingMode,
  requestControllerRef,
  setError,
  setStatus,
}: UseCadImportsOptions) {
  const [conversionTarget, setConversionTarget] = useState<CadEngine>("openscad");
  const [convertingCad, setConvertingCad] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importingUrl, setImportingUrl] = useState(false);
  const [showUrlImport, setShowUrlImport] = useState(false);

  async function importFiles(fileList: FileList | readonly File[] | null) {
    const selectedFiles = Array.from(fileList ?? []);
    const scadFiles = selectedFiles.filter((file) => file.name.toLowerCase().endsWith(".scad"));
    if (!scadFiles.length) {
      if (selectedFiles.length) {
        setError("No OpenSCAD files found. Add one or more files ending in .scad.");
        setStatus("No files added");
      }
      return;
    }
    const imported = await Promise.all(
      scadFiles.map(async (file) => ({
        engine: "openscad" as const,
        name: file.webkitRelativePath || file.name,
        source: await file.text(),
      })),
    );
    applyImportedFiles(imported, imported[0]);
    clearPreview();
    setError("");
    const skippedCount = selectedFiles.length - imported.length;
    setStatus(
      `Loaded ${imported.length} OpenSCAD file${imported.length === 1 ? "" : "s"}`
      + (skippedCount ? ` · skipped ${skippedCount} unsupported file${skippedCount === 1 ? "" : "s"}` : ""),
    );
  }

  async function importFromUrl() {
    if (!importUrl.trim() || importingUrl || renderingMode || convertingCad) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setImportingUrl(true);
    clearPreview();
    setError("");
    setStatus("Loading OpenSCAD from URL");
    try {
      const response = await fetch("/api/cad/import-scad", {
        body: JSON.stringify({ url: importUrl.trim() }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await apiError(response, "The OpenSCAD URL could not be loaded."));
      const message = await response.json() as ScadImportResponse;
      if (
        !Array.isArray(message.files)
        || !message.files.length
        || message.files.some((file) =>
          !file
          || typeof file.name !== "string"
          || !file.name.toLowerCase().endsWith(".scad")
          || typeof file.source !== "string",
        )
      ) {
        throw new Error("The import service returned no valid OpenSCAD files.");
      }
      const imported = message.files.map((file) => ({
        engine: "openscad" as const,
        name: file.name,
        source: file.source,
      }));
      const nextMainFile = imported.find((file) => file.name === message.mainFile) ?? imported[0];
      applyImportedFiles(imported, nextMainFile);
      setShowUrlImport(false);
      setStatus(`Loaded ${imported.length} OpenSCAD file${imported.length === 1 ? "" : "s"} from URL`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(error instanceof Error ? error.message : "The OpenSCAD URL could not be loaded.");
      setStatus("URL import failed");
    } finally {
      setImportingUrl(false);
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  async function convertCadFile(file?: File) {
    if (!file || convertingCad || renderingMode) return;
    if (!file.size) {
      setError("The selected CAD file is empty.");
      return;
    }
    if (file.size > maxCadFileBytes) {
      setError("Choose a CAD file smaller than 64 MB.");
      return;
    }

    const extension = file.name.split(".").pop()?.toLowerCase();
    const format = extension === "step" || extension === "stp"
      ? "step"
      : extension === "iges" || extension === "igs"
        ? "iges"
        : extension === "brep"
          ? "brep"
          : null;
    if (!format) {
      setError("Choose a STEP, IGES, or BREP file.");
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setConvertingCad(true);
    clearPreview();
    setError("");
    setStatus("Converting CAD on server");

    try {
      const response = await fetch(
        `/api/cad/convert?format=${encodeURIComponent(format)}&filename=${encodeURIComponent(file.name)}&target=${conversionTarget === "openscad" ? "scad" : conversionTarget}`,
        {
          body: file,
          headers: { "content-type": "application/octet-stream" },
          method: "POST",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(await apiError(response, "The CAD file could not be converted."));
      const message = await response.json() as CadConversionResponse;
      if (!message.source) throw new Error("The CAD service returned no reconstruction source.");

      const outputExtension = message.engine === "scad" ? "scad" : "build123d.py";
      const outputName = `${file.name.replace(/\.(?:step|stp|iges|igs|brep)$/i, "")}.${outputExtension}`;
      const imported: OpenScadSourceFile = {
        conversion: {
          bodyCount: message.bodyCount,
          duration: message.duration,
          recognizedBodyCount: message.recognizedBodyCount,
          referenceBodyCount: message.referenceBodyCount,
          sourceName: file.name,
          triangleCount: message.triangleCount,
          vertexCount: message.vertexCount,
        },
        engine: message.engine === "scad" ? "openscad" : message.engine,
        name: outputName,
        parameters: message.parameters,
        plan: message.plan,
        source: message.source,
      };
      applyImportedFiles([imported], imported);
      setStatus(
        `${message.recognizedBodyCount}/${message.bodyCount} bodies reconstructed, ${message.referenceBodyCount} references, ${(message.duration / 1000).toFixed(1)}s`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(error instanceof Error ? error.message : "The CAD file could not be converted.");
      setStatus("CAD conversion failed");
    } finally {
      setConvertingCad(false);
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  /** Restore the import machinery to its initial state (workspace reset). */
  function resetImportState() {
    setConvertingCad(false);
    setConversionTarget("openscad");
  }

  return {
    conversionTarget,
    convertCadFile,
    convertingCad,
    importFiles,
    importFromUrl,
    importUrl,
    importingUrl,
    resetImportState,
    setConversionTarget,
    setImportUrl,
    setShowUrlImport,
    showUrlImport,
  };
}
