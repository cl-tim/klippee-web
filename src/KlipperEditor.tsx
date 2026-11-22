import { basicSetup, EditorView } from "codemirror";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Compartment, StateField, type EditorState } from "@codemirror/state";
import { keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useId, useMemo, useRef } from "react";
import {
  selectionForVariable,
  uniqueVariableName,
  variableReferenceForSelection,
} from "./editorVariables";
import type { VariableValues } from "./rendering";
import type { SafetyFinding } from "./safety";
import type { EditorValueSelection, EditorVariableReferenceSelection, PackageVariable } from "./types";

const klipperLanguage = StreamLanguage.define({
  token(stream) {
    // Inline `#...` comments. Klipper allows `#` as a line-end comment marker;
    // match it anywhere on the line, not just at start-of-line.
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol()) {
      if (stream.match(/\s*\[[^\]]+\]/)) {
        return "keyword";
      }
    }
    if (stream.match(/\$\{KLIPPEE:[a-z][a-z0-9_]*\}/)) {
      return "variableName.special";
    }
    if (stream.match(/^[a-zA-Z_][\w-]*(?=\s*:)/)) {
      return "propertyName";
    }
    if (stream.match(/-?\d+(\.\d+)?/)) {
      return "number";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/)) {
      return "string";
    }
    stream.next();
    return null;
  },
});

// Dark theme for the lint tooltip and a few other CodeMirror surfaces that
// default to white background.
const klipperEditorTheme = EditorView.theme({
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "rgba(103, 216, 189, 0.18)",
    boxShadow: "inset 0 0 0 1px rgba(103, 216, 189, 0.42)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(103, 216, 189, 0.14)",
  },
  ".cm-tooltip": {
    backgroundColor: "#1b2420",
    color: "#f2f7f4",
    border: "1px solid #2c3834",
    borderRadius: "6px",
  },
  ".cm-tooltip-lint": {
    backgroundColor: "#1b2420",
    color: "#f2f7f4",
  },
  ".cm-diagnostic": {
    color: "#f2f7f4",
    padding: "6px 10px",
  },
  ".cm-diagnostic-error": {
    borderLeft: "3px solid #ff8e7f",
  },
  ".cm-diagnostic-warning": {
    borderLeft: "3px solid #f0c76a",
  },
}, { dark: true });

const klipperHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "#7b8d85", fontStyle: "italic" },
  { tag: tags.keyword, color: "#67d8bd", fontWeight: "700" },
  { tag: tags.propertyName, color: "#8fd4ff" },
  { tag: tags.special(tags.variableName), color: "#f0c76a" },
  { tag: tags.number, color: "#f8b86a" },
  { tag: tags.string, color: "#b9f18d" },
]);

function diagnosticSeverity(severity: SafetyFinding["severity"]): Diagnostic["severity"] {
  return severity === "block" ? "error" : "warning";
}

function diagnosticsFor(filePath: string, findings: SafetyFinding[]) {
  return linter((view) => {
    const diagnostics: Diagnostic[] = [];
    for (const finding of findings) {
      if (finding.path !== filePath) {
        continue;
      }
      const lineNumber = Math.max(1, finding.line ?? 1);
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
      diagnostics.push({
        from: line.from,
        message: finding.message,
        severity: diagnosticSeverity(finding.severity),
        to: line.to,
      });
    }
    return diagnostics;
  });
}

type VariableTooltipHandlers = {
  createVariable: (selection: EditorValueSelection, name: string) => boolean;
  definitions: () => PackageVariable[];
  updateVariable: (name: string, value: string) => void;
  values: () => VariableValues;
};

function tooltipButton(label: string, className = "") {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  button.type = "button";
  return button;
}

function preserveEditorSelection(event: MouseEvent) {
  event.preventDefault();
}

function renderCreateVariableLauncher(
  dom: HTMLElement,
  view: EditorView,
  selection: EditorValueSelection,
  handlers: VariableTooltipHandlers,
) {
  dom.classList.remove("is-editing", "is-success");
  dom.removeAttribute("role");
  dom.removeAttribute("aria-label");
  const button = tooltipButton("Make variable", "cm-variable-tooltip-launcher");
  button.setAttribute("aria-label", `Make selected value ${selection.value} a variable`);
  button.addEventListener("mousedown", preserveEditorSelection);
  button.addEventListener("click", () => renderCreateVariableForm(dom, view, selection, handlers));
  dom.replaceChildren(button);
}

function renderCreateVariableForm(
  dom: HTMLElement,
  view: EditorView,
  selection: EditorValueSelection,
  handlers: VariableTooltipHandlers,
) {
  dom.classList.add("is-editing");
  dom.setAttribute("aria-label", "Create variable from selected value");
  dom.setAttribute("role", "dialog");

  const form = document.createElement("form");
  form.className = "cm-variable-tooltip-form";
  const heading = document.createElement("strong");
  heading.textContent = `Make line ${selection.line} value a variable`;
  const selectedValue = document.createElement("code");
  selectedValue.textContent = selection.value;
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Variable name");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = uniqueVariableName(
    selection.suggestedName,
    handlers.definitions().map((variable) => variable.name),
  );
  const helper = document.createElement("small");
  helper.textContent = "The selected text becomes this printer's initial value.";
  const error = document.createElement("small");
  error.className = "cm-variable-tooltip-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  const cancel = tooltipButton("Cancel", "cm-variable-tooltip-cancel");
  const create = tooltipButton("Create variable", "cm-variable-tooltip-submit");
  create.type = "submit";
  cancel.addEventListener("click", () => {
    renderCreateVariableLauncher(dom, view, selection, handlers);
    view.focus();
  });
  actions.append(cancel, create);
  form.append(heading, selectedValue, input, helper, error, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      error.textContent = "Use lowercase letters, numbers, and underscores; start with a letter.";
      return;
    }
    if (handlers.definitions().some((variable) => variable.name === name)) {
      error.textContent = "That variable already exists.";
      return;
    }
    if (!handlers.createVariable(selection, name)) {
      error.textContent = "The editor selection changed. Select the value again.";
    }
  });
  dom.replaceChildren(form);
  queueMicrotask(() => input.focus());
}

function renderVariableValueLauncher(
  dom: HTMLElement,
  view: EditorView,
  reference: EditorVariableReferenceSelection,
  handlers: VariableTooltipHandlers,
) {
  dom.classList.remove("is-editing", "is-success");
  dom.removeAttribute("role");
  dom.removeAttribute("aria-label");
  const button = tooltipButton("Set variable value", "cm-variable-tooltip-launcher");
  button.setAttribute("aria-label", `Set value for variable ${reference.name}`);
  button.addEventListener("mousedown", preserveEditorSelection);
  button.addEventListener("click", () => renderVariableValueForm(dom, view, reference, handlers));
  dom.replaceChildren(button);
}

function renderVariableValueForm(
  dom: HTMLElement,
  view: EditorView,
  reference: EditorVariableReferenceSelection,
  handlers: VariableTooltipHandlers,
) {
  dom.classList.add("is-editing");
  dom.setAttribute("aria-label", `Set value for variable ${reference.name}`);
  dom.setAttribute("role", "dialog");

  const definition = handlers.definitions().find((variable) => variable.name === reference.name);
  const form = document.createElement("form");
  form.className = "cm-variable-tooltip-form";
  const heading = document.createElement("strong");
  heading.textContent = definition?.label ?? reference.name;
  const placeholder = document.createElement("code");
  placeholder.textContent = `\${KLIPPEE:${reference.name}}`;
  const actions = document.createElement("div");
  const cancel = tooltipButton("Cancel", "cm-variable-tooltip-cancel");
  cancel.addEventListener("click", () => {
    renderVariableValueLauncher(dom, view, reference, handlers);
    view.focus();
  });

  if (definition?.secret) {
    const guidance = document.createElement("small");
    guidance.textContent = `Set on the printer with: klippee variables set ${reference.name} <value>`;
    actions.append(cancel);
    form.append(heading, placeholder, guidance, actions);
  } else {
    const input = document.createElement("input");
    input.setAttribute("aria-label", `Value for ${definition?.label ?? reference.name}`);
    input.autocomplete = "off";
    input.value = handlers.values()[reference.name] ?? "";
    const helper = document.createElement("small");
    helper.textContent = definition?.description || "Used whenever this configuration is rendered for the printer.";
    const save = tooltipButton("Save value", "cm-variable-tooltip-submit");
    save.type = "submit";
    actions.append(cancel, save);
    form.append(heading, placeholder, input, helper, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handlers.updateVariable(reference.name, input.value);
      dom.classList.remove("is-editing");
      dom.classList.add("is-success");
      const status = document.createElement("strong");
      status.textContent = "Variable value updated";
      const done = tooltipButton("Done", "cm-variable-tooltip-cancel");
      done.addEventListener("click", () => {
        renderVariableValueLauncher(dom, view, reference, handlers);
        view.focus();
      });
      dom.replaceChildren(status, done);
    });
    queueMicrotask(() => input.focus());
  }

  dom.replaceChildren(form);
}

function contextualVariableTooltip(state: EditorState, handlers: VariableTooltipHandlers): readonly Tooltip[] {
  const range = state.selection.main;
  if (range.empty) return [];
  const content = state.doc.toString();
  const reference = variableReferenceForSelection(content, range.anchor, range.head);
  const selection = reference ? null : selectionForVariable(content, range.anchor, range.head);
  if (!reference && !selection) return [];
  const target = reference ?? selection;
  if (!target) return [];

  return [{
    above: true,
    arrow: true,
    end: target.to,
    pos: target.from,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-variable-tooltip";
      if (reference) {
        renderVariableValueLauncher(dom, view, reference, handlers);
      } else if (selection) {
        renderCreateVariableLauncher(dom, view, selection, handlers);
      }
      return { dom, offset: { x: 0, y: 6 } };
    },
  }];
}

function contextualVariableTooltipExtension(handlers: VariableTooltipHandlers) {
  return StateField.define<readonly Tooltip[]>({
    create: (state) => contextualVariableTooltip(state, handlers),
    update: (_tooltips, transaction) => contextualVariableTooltip(transaction.state, handlers),
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  });
}

export function KlipperEditor({
  filePath,
  findings,
  onCreateVariable,
  onChange,
  onUpdateVariable,
  scrollToLine,
  value,
  variableDefinitions,
  variableValues,
}: {
  filePath: string;
  findings: SafetyFinding[];
  onCreateVariable: (selection: EditorValueSelection, name: string) => boolean;
  onChange: (value: string) => void;
  onUpdateVariable: (name: string, value: string) => void;
  /** Token + line number. Any change in this object triggers a scroll. */
  scrollToLine?: { token: number; line: number };
  value: string;
  variableDefinitions: PackageVariable[];
  variableValues: VariableValues;
}) {
  const keyboardHelpId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCreateVariableRef = useRef(onCreateVariable);
  const onUpdateVariableRef = useRef(onUpdateVariable);
  const variableDefinitionsRef = useRef(variableDefinitions);
  const variableValuesRef = useRef(variableValues);
  const applyingExternalValueRef = useRef(false);
  const lintCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onCreateVariableRef.current = onCreateVariable;
    onUpdateVariableRef.current = onUpdateVariable;
    variableDefinitionsRef.current = variableDefinitions;
    variableValuesRef.current = variableValues;
  }, [onCreateVariable, onUpdateVariable, variableDefinitions, variableValues]);

  useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const variableTooltipExtension = contextualVariableTooltipExtension({
      createVariable: (selection, name) => onCreateVariableRef.current(selection, name),
      definitions: () => variableDefinitionsRef.current,
      updateVariable: (name, nextValue) => onUpdateVariableRef.current(name, nextValue),
      values: () => variableValuesRef.current,
    });
    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        history(),
        klipperLanguage,
        syntaxHighlighting(klipperHighlight),
        lintGutter(),
        lintCompartment.of(diagnosticsFor(filePath, findings)),
        klipperEditorTheme,
        variableTooltipExtension,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": `Edit ${filePath}`,
          "aria-describedby": keyboardHelpId,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternalValueRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
      parent: hostRef.current,
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor instance is created once; value/lint updates are handled by focused effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) {
      return;
    }
    applyingExternalValueRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, insert: value, to: view.state.doc.length },
      });
    } finally {
      applyingExternalValueRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: lintCompartment.reconfigure(diagnosticsFor(filePath, findings)),
    });
  }, [filePath, findings, lintCompartment]);

  useEffect(() => {
    if (!scrollToLine) return;
    const view = viewRef.current;
    if (!view) return;
    const totalLines = view.state.doc.lines;
    const targetLine = Math.max(1, Math.min(totalLines, scrollToLine.line));
    const lineInfo = view.state.doc.line(targetLine);
    view.dispatch({
      selection: { anchor: lineInfo.from, head: lineInfo.to },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
    view.focus();
  }, [scrollToLine]);

  return <>
    <span className="sr-only" id={keyboardHelpId}>Tab moves between controls. Use Control or Command with the square bracket keys to indent or unindent.</span>
    <div className="klipper-editor" ref={hostRef} />
  </>;
}
