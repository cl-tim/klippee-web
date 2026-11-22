import {
  Box,
  Check,
  Download,
  Gauge,
  RotateCcw,
  Search,
} from "lucide-react";
import { Accordion, Badge, Button, Group, Stack, Text, TextInput, Title, UnstyledButton } from "@mantine/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatBytes } from "../../app/format";
import { apiError } from "../../lib/api";
import { downloadBlob } from "../../rendering";
import { OpenScadViewer } from "../openscad/OpenScadViewer";
import {
  cadEditorLibraries,
  defaultValuesFor,
  renderParametersFor,
  type CadComponentModel,
  type CadEditorKind,
} from "./libraries";
import { ParameterControl } from "./ParameterControl";
import { HelpRow } from "../../components/FieldHelp";
import type { ParameterField, ParameterValue } from "./underwareModels";

type StoredEditorState = {
  modelId?: string;
  parameters?: Record<string, ParameterValue>;
};

function loadStoredState(kind: CadEditorKind): StoredEditorState {
  try {
    return JSON.parse(localStorage.getItem(cadEditorLibraries[kind].storageKey) || "{}") as StoredEditorState;
  } catch {
    return {};
  }
}

export function ParametricCadEditor({ kind }: { kind: CadEditorKind }) {
  const library = cadEditorLibraries[kind];
  const initialState = useMemo(() => loadStoredState(kind), [kind]);
  const initialModel = library.models.find((model) => model.id === initialState.modelId) ?? library.models[0];
  const [modelId, setModelId] = useState(initialModel.id);
  const [parameters, setParameters] = useState<Record<string, ParameterValue>>(() => ({
    ...defaultValuesFor(initialModel),
    ...initialState.parameters,
    ...initialModel.fixedValues,
  }));
  const [filter, setFilter] = useState("");
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [renderingMode, setRenderingMode] = useState<"preview" | "export" | null>(null);
  const [status, setStatus] = useState("Choose a component and adjust its dimensions");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const model = library.models.find((candidate) => candidate.id === modelId) ?? library.models[0];

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  useEffect(() => {
    try {
      localStorage.setItem(library.storageKey, JSON.stringify({ modelId, parameters }));
    } catch {
      // Rendering remains available when browser storage is disabled.
    }
  }, [library.storageKey, modelId, parameters]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ParameterField[]>();
    for (const field of model.fields) {
      grouped.set(field.group, [...(grouped.get(field.group) ?? []), field]);
    }
    return [...grouped.entries()];
  }, [model.fields]);

  const visibleModels = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? library.models.filter((candidate) =>
          `${candidate.name} ${candidate.shortName} ${candidate.category} ${candidate.family ?? ""}`
            .toLowerCase()
            .includes(query))
      : library.models;
  }, [filter, library.models]);

  const modelGroups = useMemo(() => {
    const grouped = new Map<string, CadComponentModel[]>();
    for (const candidate of visibleModels) {
      const label = [candidate.family, candidate.category].filter(Boolean).join(" · ");
      grouped.set(label, [...(grouped.get(label) ?? []), candidate]);
    }
    return [...grouped.entries()];
  }, [visibleModels]);

  function chooseModel(nextModel: CadComponentModel) {
    requestControllerRef.current?.abort();
    setModelId(nextModel.id);
    setParameters(defaultValuesFor(nextModel));
    setBuffer(null);
    setDuration(null);
    setError("");
    setStale(false);
    setStatus(`${nextModel.name} ready to configure`);
  }

  function changeParameter(key: string, value: ParameterValue) {
    setParameters((current) => ({ ...current, [key]: value }));
    if (buffer) setStale(true);
  }

  function reset() {
    requestControllerRef.current?.abort();
    setParameters(defaultValuesFor(model));
    setBuffer(null);
    setDuration(null);
    setError("");
    setStale(false);
    setStatus("Parameters reset");
  }

  function downloadBuffer(nextBuffer: ArrayBuffer) {
    downloadBlob(new Blob([nextBuffer], { type: "model/stl" }), `${model.id}.stl`);
  }

  function render(mode: "preview" | "export") {
    if (renderingMode) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setRenderingMode(mode);
    setError("");
    setStatus(mode === "preview" ? "Generating preview" : "Preparing printable STL");

    void (async () => {
      try {
        const requiredFiles = model.requiredFiles
          ? library.sourceFiles.filter((file) => model.requiredFiles?.includes(file.name))
          : library.sourceFiles;
        const response = await fetch(`/api/cad/render?mode=${mode}`, {
          body: JSON.stringify({
            files: requiredFiles,
            mainFile: model.file,
            parameters: renderParametersFor(model, parameters),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await apiError(response, `${model.name} could not be rendered.`));
        const nextBuffer = await response.arrayBuffer();
        if (nextBuffer.byteLength < 84) throw new Error("The CAD engine returned an empty STL.");
        const nextDuration = Number(response.headers.get("x-cad-duration-ms")) || null;
        if (mode === "preview") {
          setBuffer(nextBuffer);
          setDuration(nextDuration);
          setStale(false);
          setStatus("Preview ready");
        } else {
          downloadBuffer(nextBuffer);
          setStatus("STL exported");
        }
      } catch (renderError) {
        if (renderError instanceof DOMException && renderError.name === "AbortError") return;
        setError(renderError instanceof Error ? renderError.message : "The CAD engine could not render this component.");
        setStatus("Render failed");
      } finally {
        setRenderingMode(null);
        if (requestControllerRef.current === controller) requestControllerRef.current = null;
      }
    })();
  }

  return (
    <section aria-label={library.title} className="cad-editor-workspace">
      <aside aria-label="Component library" className="cad-component-panel">
        <header className="cad-editor-title">
          <HelpRow label={library.title} help={library.description}><Title order={1}>{library.title}</Title></HelpRow>
        </header>
        <TextInput
          aria-label="Search components"
          leftSection={<Search aria-hidden="true" size={16} />}
          mx={14}
          my={12}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search components"
          type="search"
          value={filter}
        />
        <nav aria-label={`${library.title} components`} className="cad-component-list">
          {modelGroups.map(([group, models]) => (
            <section key={group}>
              <Text className="cad-component-group" fw={600} size="sm">{group}</Text>
              {models.map((candidate) => (
                <UnstyledButton
                  aria-pressed={candidate.id === model.id}
                  className={candidate.id === model.id ? "is-active" : ""}
                  key={candidate.id}
                  onClick={() => chooseModel(candidate)}
                  p="sm"
                  bg={candidate.id === model.id ? "var(--accent-soft)" : "transparent"}
                  style={{ display: "flex", gap: 10, width: "100%", minHeight: 64, borderRadius: "var(--mantine-radius-md)" }}
                  type="button"
                >
                  <span className="cad-model-accent" style={{ "--cad-model-accent": candidate.accent } as CSSProperties}>
                    {candidate.shortName.slice(0, 1)}
                  </span>
                  <Stack align="flex-start" gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={600} size="sm">{candidate.shortName}</Text>
                    <Text c="dimmed" size="xs" lineClamp={2}>{candidate.description}</Text>
                  </Stack>
                  {candidate.id === model.id ? <Check aria-hidden="true" size={15} /> : null}
                </UnstyledButton>
              ))}
            </section>
          ))}
          {!visibleModels.length ? <Text className="cad-empty-search" c="dimmed">No matching components.</Text> : null}
        </nav>
        <footer className="cad-editor-attribution">
          <span>
            {library.sourceFiles.length} pre-loaded SCAD {library.sourceFiles.length === 1 ? "file" : "files"}
          </span>
          {library.attribution.map((item) => (
            <a href={item.url} key={item.url} rel="noreferrer" target="_blank">{item.label}</a>
          ))}
        </footer>
      </aside>

      <section aria-label="CAD preview" className="cad-preview-panel">
        <header className="cad-preview-header">
          <Stack gap={2}>
            <HelpRow label={model.name} help={model.description}><Title order={2}>{model.name}</Title></HelpRow>
          </Stack>
          <Badge variant="light" style={{ flexShrink: 0 }}>{model.fields.length} parameters</Badge>
        </header>
        <div className="openscad-viewer-stage cad-preview-stage">
          <OpenScadViewer buffer={buffer} />
          {!buffer && !renderingMode ? (
            <div className="openscad-viewer-empty">
              <Box size={34} />
              <Text fw={600}>No preview yet</Text>
              <Text c="dimmed" size="sm">Adjust the parameters, then generate a preview below.</Text>
            </div>
          ) : null}
          {renderingMode ? (
            <div className="openscad-render-state">
              <Box size={30} />
              <Text fw={600} role="status">{status}</Text>
              <Text c="dimmed" size="sm">OpenSCAD is compiling {model.shortName.toLowerCase()} geometry.</Text>
            </div>
          ) : null}
          {buffer && stale ? <Badge className="openscad-mesh-badge is-stale">Parameters changed · refresh preview</Badge> : null}
        </div>
        {error ? <pre className="openscad-error">{error}</pre> : null}
        <footer className="openscad-actionbar">
          <Text c="dimmed" size="sm" mih="2lh" lineClamp={2} title={status} role={renderingMode ? undefined : "status"}>{!renderingMode && (stale ? "Showing previous preview" : status === "Preview ready" && buffer
            ? `Preview ready · ${formatBytes(buffer.byteLength)}${duration ? ` · ${(duration / 1000).toFixed(1)}s` : ""}` : status)}</Text>
          <Group className="cad-preview-actions" gap="xs" wrap="wrap">
            <Button
              aria-label={buffer ? "Refresh preview" : "Generate preview"}
              className="inline-action"
              disabled={Boolean(renderingMode)}
              onClick={() => render("preview")}
              type="button"
              variant="default"
            >
              <Gauge aria-hidden="true" size={16} />{buffer ? "Refresh" : "Preview"}
            </Button>
            <Button
              className="primary-action"
              disabled={Boolean(renderingMode)}
              onClick={() => render("export")}
              type="button"
              variant="filled"
            >
              <Download aria-hidden="true" size={17} />Export STL
            </Button>
          </Group>
        </footer>
      </section>

      <aside aria-label="Component parameters" className="cad-parameter-panel">
        <header>
          <Stack gap={2}>
            <Title order={2}>Parameters</Title>
          </Stack>
          <Button aria-label="Reset parameters" className="icon-button" onClick={reset} type="button" variant="subtle">
            <RotateCcw size={16} />
          </Button>
        </header>
        <div className="openscad-parameter-scroll">
          <Accordion key={modelId} defaultValue={groups.map((_, index) => `group-${index}`)} multiple>
            {groups.map(([group, fields], index) => (
              <Accordion.Item key={group} value={`group-${index}`}>
                <Accordion.Control>{group}</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="sm">
                    {fields.map((field) => (
                      <ParameterControl
                        key={field.key}
                        onChange={(value) => changeParameter(field.key, value)}
                        parameter={field}
                        value={parameters[field.key] ?? field.defaultValue}
                      />
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </div>
        <Text className="cad-fit-warning" c="var(--warning)" size="sm" mx="md" mb="md" mt="auto" p="sm">Fit depends on printer, material, and tolerances. Test a small component first.</Text>
      </aside>
    </section>
  );
}
