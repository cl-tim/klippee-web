import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  equalOpenScadPanelRatios,
  normalizeOpenScadPanelRatios,
  nudgeOpenScadPanelRatios,
  resizeOpenScadPanelWidths,
  type OpenScadPanelDivider,
  type OpenScadPanelRatios,
  type OpenScadPanelWidths,
} from "./panelLayout";

const panelLayoutStorageKey = "klippee.openscad.panel-layout.v1";

type PanelResizeDrag = {
  divider: OpenScadPanelDivider;
  pointerId: number;
  startWidths: OpenScadPanelWidths;
  startX: number;
};

function loadPanelRatios(): OpenScadPanelRatios {
  try {
    const stored = window.localStorage.getItem(panelLayoutStorageKey);
    if (!stored) return [...equalOpenScadPanelRatios];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? normalizeOpenScadPanelRatios(parsed) ?? [...equalOpenScadPanelRatios]
      : [...equalOpenScadPanelRatios];
  } catch {
    return [...equalOpenScadPanelRatios];
  }
}

/**
 * Drag/keyboard resize machinery for the three OpenSCAD workspace panels.
 * Ratios persist to localStorage; attach the returned refs to the panels and
 * render a `PanelResizeHandle` between each pair.
 */
export function usePanelResize() {
  const [panelRatios, setPanelRatios] = useState<OpenScadPanelRatios>(loadPanelRatios);
  const sourcePanelRef = useRef<HTMLElement | null>(null);
  const viewerPanelRef = useRef<HTMLDivElement | null>(null);
  const parametersPanelRef = useRef<HTMLElement | null>(null);
  const panelResizeDragRef = useRef<PanelResizeDrag | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(panelLayoutStorageKey, JSON.stringify(panelRatios));
    } catch {
      // Resizing should continue to work when browser storage is unavailable.
    }
  }, [panelRatios]);
  useEffect(() => () => document.body.classList.remove("is-resizing-openscad"), []);

  const panelGridStyle = {
    "--openscad-parameters-ratio": `${panelRatios[2]}fr`,
    "--openscad-source-ratio": `${panelRatios[0]}fr`,
    "--openscad-viewer-ratio": `${panelRatios[1]}fr`,
  } as CSSProperties;

  function currentPanelWidths(): OpenScadPanelWidths | null {
    const source = sourcePanelRef.current?.getBoundingClientRect().width;
    const viewer = viewerPanelRef.current?.getBoundingClientRect().width;
    const parametersPanel = parametersPanelRef.current?.getBoundingClientRect().width;
    if (!source || !viewer || !parametersPanel) return null;
    return [source, viewer, parametersPanel];
  }

  function updatePanelRatiosFromWidths(widths: OpenScadPanelWidths) {
    const normalized = normalizeOpenScadPanelRatios(widths);
    if (normalized) setPanelRatios(normalized);
  }

  function beginPanelResize(
    divider: OpenScadPanelDivider,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const startWidths = currentPanelWidths();
    if (!startWidths) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeDragRef.current = {
      divider,
      pointerId: event.pointerId,
      startWidths,
      startX: event.clientX,
    };
    document.body.classList.add("is-resizing-openscad");
  }

  function continuePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelResizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updatePanelRatiosFromWidths(
      resizeOpenScadPanelWidths(drag.startWidths, drag.divider, event.clientX - drag.startX),
    );
  }

  function endPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelResizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panelResizeDragRef.current = null;
    document.body.classList.remove("is-resizing-openscad");
  }

  function handlePanelResizeKey(
    divider: OpenScadPanelDivider,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Home") {
      event.preventDefault();
      setPanelRatios([...equalOpenScadPanelRatios]);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 0.04 : -0.04;
    setPanelRatios((current) => nudgeOpenScadPanelRatios(current, divider, direction));
  }

  function resetPanelRatios() {
    setPanelRatios([...equalOpenScadPanelRatios]);
  }

  return {
    beginPanelResize,
    continuePanelResize,
    endPanelResize,
    handlePanelResizeKey,
    panelGridStyle,
    panelRatios,
    parametersPanelRef,
    resetPanelRatios,
    sourcePanelRef,
    viewerPanelRef,
  };
}
