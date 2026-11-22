import { describe, expect, it } from "vitest";
import {
  preserveCapturedVariableTemplates,
  unprotectedCapturedVariableNames,
} from "./captureVariables";
import type { StoredConfigFile } from "./types";

function config(path: string, content: string): StoredConfigFile {
  return { content, path, public: false, role: "include" };
}

describe("preserveCapturedVariableTemplates", () => {
  it("restores a uniquely matching rendered line across unrelated insertions", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\nx_offset: 0\n",
    );
    const captured = config(
      "beacon.cfg",
      "# printer-side note\r\n[beacon]\r\nserial: /dev/serial/by-id/beacon-one\r\nx_offset: 1\r\n",
    );

    const [preserved] = preserveCapturedVariableTemplates(
      [captured],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    );

    expect(preserved.content).toContain("serial: ${KLIPPEE:beacon_serial}\r\n");
    expect(preserved.content).toContain("x_offset: 1\r\n");
    expect(preserved.content).toContain("# printer-side note\r\n");
  });

  it("does not restore changed, ambiguous, or unknown-value lines", () => {
    const template = config(
      "printer.cfg",
      [
        "serial: ${KLIPPEE:beacon_serial} # primary",
        "duplicate: ${KLIPPEE:duplicate_value}",
        "secret: ${KLIPPEE:local_secret}",
        "",
      ].join("\n"),
    );
    const captured = config(
      "printer.cfg",
      [
        "serial: /dev/serial/by-id/beacon-two # locally changed",
        "duplicate: repeated",
        "duplicate: repeated",
        "secret: host-only-value",
        "",
      ].join("\n"),
    );

    const [preserved] = preserveCapturedVariableTemplates(
      [captured],
      [template],
      {
        beacon_serial: "/dev/serial/by-id/beacon-one",
        duplicate_value: "repeated",
      },
    );

    expect(preserved).toEqual(captured);
    expect(unprotectedCapturedVariableNames(
      [preserved],
      [template],
      {
        beacon_serial: "/dev/serial/by-id/beacon-one",
        duplicate_value: "repeated",
      },
    )).toEqual(["beacon_serial", "duplicate_value", "local_secret"]);
  });

  it("does not choose between templates that render to the same captured line", () => {
    const template = config(
      "printer.cfg",
      "serial: ${KLIPPEE:first_serial}\nserial: ${KLIPPEE:second_serial}\n",
    );
    const captured = config("printer.cfg", "serial: /dev/serial/shared\n");

    const [preserved] = preserveCapturedVariableTemplates(
      [captured],
      [template],
      {
        first_serial: "/dev/serial/shared",
        second_serial: "/dev/serial/shared",
      },
    );

    expect(preserved).toEqual(captured);
    expect(unprotectedCapturedVariableNames(
      [preserved],
      [template],
      {
        first_serial: "/dev/serial/shared",
        second_serial: "/dev/serial/shared",
      },
    )).toEqual(["first_serial", "second_serial"]);
  });

  it("does not move a variable marker onto an identical line in another section", () => {
    const template = config(
      "printer.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n[mcu]\nserial: controller\n",
    );
    const captured = config(
      "printer.cfg",
      "[beacon]\nserial: replacement\n[mcu]\nserial: /dev/serial/by-id/beacon-one\n",
    );

    const [preserved] = preserveCapturedVariableTemplates(
      [captured],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    );

    expect(preserved).toEqual(captured);
    expect(unprotectedCapturedVariableNames(
      [preserved],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
  });

  it("does not move a marker to a later identical line in the same section", () => {
    const template = config(
      "printer.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\nspeed: 5\n",
    );
    const captured = config(
      "printer.cfg",
      [
        "[beacon]",
        "serial: replacement",
        "speed: 5",
        "serial: /dev/serial/by-id/beacon-one",
        "",
      ].join("\n"),
    );

    const [preserved] = preserveCapturedVariableTemplates(
      [captured],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    );

    expect(preserved).toEqual(captured);
  });

  it("reports host-local literals that cannot be safely restored", () => {
    const template = config(
      "service.cfg",
      "[service]\nendpoint: ${KLIPPEE:auth_token}\nlabel: ${KLIPPEE:profile_name}\n",
    );
    const captured = config(
      "service.cfg",
      "[service]\nendpoint: opaque-host-secret\nlabel: Visible profile\n",
    );

    expect(unprotectedCapturedVariableNames(
      [captured],
      [template],
      { profile_name: "Visible profile" },
    )).toEqual(["auth_token"]);
    expect(unprotectedCapturedVariableNames(
      [{ ...captured, content: template.content }],
      [template],
      { profile_name: "Visible profile" },
    )).toEqual([]);
  });

  it("validates every protected occurrence instead of accepting a stray marker", () => {
    const template = config(
      "service.cfg",
      [
        "[service]",
        "primary: ${KLIPPEE:auth_token}",
        "secondary: ${KLIPPEE:auth_token}",
        "",
      ].join("\n"),
    );
    const captured = config(
      "service.cfg",
      [
        "[service]",
        "primary: leaked-value # ${KLIPPEE:auth_token}",
        "secondary: ${KLIPPEE:auth_token}",
        "",
      ].join("\n"),
    );

    expect(unprotectedCapturedVariableNames([captured], [template], {}))
      .toEqual(["auth_token"]);
  });

  it("rejects a protected marker moved later within the same section", () => {
    const template = config(
      "service.cfg",
      "[service]\nendpoint: ${KLIPPEE:auth_token}\ntimeout: 30\n",
    );
    const captured = config(
      "service.cfg",
      [
        "[service]",
        "endpoint: leaked-value",
        "timeout: 30",
        "endpoint: ${KLIPPEE:auth_token}",
        "",
      ].join("\n"),
    );

    expect(unprotectedCapturedVariableNames([captured], [template], {}))
      .toEqual(["auth_token"]);
  });

  it("rejects a duplicate authoritative section instead of moving trust to its first copy", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    );
    const captured = config(
      "beacon.cfg",
      [
        "[beacon]",
        "serial: /dev/serial/by-id/beacon-one",
        "[beacon]",
        "serial: host-local-copy",
        "",
      ].join("\n"),
    );
    const values = { beacon_serial: "/dev/serial/by-id/beacon-one" };

    expect(preserveCapturedVariableTemplates([captured], [template], values))
      .toEqual([captured]);
    expect(unprotectedCapturedVariableNames([captured], [template], values))
      .toEqual(["beacon_serial"]);
  });

  it("rejects a renamed or missing authoritative variable file", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    );
    const renamed = config("renamed-beacon.cfg", template.content);

    expect(unprotectedCapturedVariableNames(
      [renamed],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
    expect(unprotectedCapturedVariableNames(
      [],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
  });

  it("rejects extra capture paths while an authoritative variable exists", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    );
    const copied = config(
      "copied.cfg",
      "[beacon]\nserial: /dev/serial/by-id/beacon-one\n",
    );

    expect(unprotectedCapturedVariableNames(
      [template, copied],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
  });

  it("rejects duplicate capture or authority paths", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    );
    const rendered = config(
      "beacon.cfg",
      "[beacon]\nserial: /dev/serial/by-id/beacon-one\n",
    );

    expect(unprotectedCapturedVariableNames(
      [template, rendered],
      [template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
    expect(unprotectedCapturedVariableNames(
      [template],
      [template, template],
      { beacon_serial: "/dev/serial/by-id/beacon-one" },
    )).toEqual(["beacon_serial"]);
  });

  it("uses an unapplied desired template as reject-only authority", () => {
    const template = config(
      "beacon.cfg",
      "[beacon]\nserial: ${KLIPPEE:beacon_serial}\n",
    );
    const captured = config(
      "beacon.cfg",
      "[beacon]\nserial: /dev/serial/by-id/beacon-one\n",
    );
    const values = { beacon_serial: "/dev/serial/by-id/beacon-one" };

    expect(unprotectedCapturedVariableNames([captured], [template], values)).toEqual([]);
    expect(unprotectedCapturedVariableNames(
      [captured],
      [template],
      values,
      { protectAllPlaceholders: true },
    )).toEqual(["beacon_serial"]);
    expect(captured.content).not.toContain("${KLIPPEE:beacon_serial}");
  });
});
