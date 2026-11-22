import { describe, expect, it } from "vitest";
import {
  inferSelectedVariableType,
  selectionForVariable,
  uniqueVariableName,
  variableReferenceForSelection,
} from "./editorVariables";

describe("editor variable selection", () => {
  const content = "[mcu]\nserial: /dev/serial/by-id/usb-controller # keep this comment\nrestart_method: command\n";

  it("converts a selected config line into its trimmed value range", () => {
    const lineStart = content.indexOf("serial:");
    const selection = selectionForVariable(content, lineStart, content.indexOf("\n", lineStart) + 1);

    expect(selection).toEqual({
      from: content.indexOf("/dev/serial"),
      line: 2,
      suggestedName: "mcu_serial",
      to: content.indexOf(" # keep"),
      value: "/dev/serial/by-id/usb-controller",
    });
  });

  it("keeps an exact value selection precise instead of replacing every occurrence", () => {
    const from = content.indexOf("command");
    expect(selectionForVariable(content, from, from + "command".length)).toMatchObject({
      from,
      suggestedName: "mcu_restart_method",
      to: from + "command".length,
      value: "command",
    });
  });

  it("rejects multi-line and placeholder selections", () => {
    expect(selectionForVariable(content, 0, content.length)).toBeNull();
    expect(selectionForVariable("serial: ${KLIPPEE:mcu_serial}", 8, 29)).toBeNull();
  });

  it("recognizes an existing placeholder selected in the editor", () => {
    const placeholderContent = "[mcu]\nserial: ${KLIPPEE:mcu_serial}\n";
    const from = placeholderContent.indexOf("${KLIPPEE:");

    expect(variableReferenceForSelection(placeholderContent, from, placeholderContent.length - 1)).toEqual({
      from,
      line: 2,
      name: "mcu_serial",
      to: from + "${KLIPPEE:mcu_serial}".length,
    });
    expect(variableReferenceForSelection(placeholderContent, 0, placeholderContent.length)).toBeNull();
  });

  it("generates unique valid names and infers common value types", () => {
    expect(uniqueVariableName("mcu serial", ["mcu_serial"])).toBe("mcu_serial_2");
    expect(uniqueVariableName("42", [])).toBe("value_42");
    expect(inferSelectedVariableType("/dev/serial/by-id/controller", "mcu_serial")).toBe("device-path");
    expect(inferSelectedVariableType("33.5", "extruder_pid_kp")).toBe("number");
    expect(inferSelectedVariableType("abc123", "api_token")).toBe("secret");
  });
});
