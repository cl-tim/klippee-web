import { describe, expect, it } from "vitest";
import { scanConfigFiles, scanPublicConfigFiles } from "./safety";

describe("workspace safety review", () => {
  it("does not flag literal device paths as automatic variable candidates", () => {
    const findings = scanConfigFiles([{
      content: "[mcu]\nserial: /dev/serial/by-id/usb-controller\n",
      path: "printer.cfg",
    }]);

    expect(findings).toEqual([]);
  });

  it("warns about literal hardware identifiers for public review without changing private analysis", () => {
    const file = {
      content: [
        "[mcu]",
        "serial: /dev/serial/by-id/usb-controller",
        "[mcu toolhead]",
        "canbus_uuid: 1234567890ab",
        "[beacon]",
        "serial: /dev/v4l/by-id/usb-beacon",
        "[camera]",
        "device: /dev/video0",
      ].join("\n"),
      path: "printer.cfg",
    };

    expect(scanConfigFiles([file])).toEqual([]);
    expect(scanPublicConfigFiles([file]).filter((finding) => finding.category === "device-identity"))
      .toMatchObject([{ line: 2, severity: "warn" }]);
  });

  it("warns about private network addresses, local hostnames, and camera endpoints before publication", () => {
    const files = [
      {
        content: "trusted_clients: 192.168.1.0/24\n",
        path: "moonraker.conf",
      },
      {
        content: "cors_domains: http://printer.local\n",
        path: "moonraker.conf",
      },
      {
        content: "stream_url: http://10.0.0.24:8080/stream\n",
        path: "camera.cfg",
      },
      {
        content: "host: fd00::1\n",
        path: "network.cfg",
      },
    ];

    expect(files.flatMap((file) => scanPublicConfigFiles([file]))
      .filter((finding) => finding.category === "network-identity")).toMatchObject([
      { line: 1, path: "moonraker.conf", severity: "warn" },
      { line: 1, path: "moonraker.conf", severity: "warn" },
      { line: 1, path: "camera.cfg", severity: "warn" },
      { line: 1, path: "network.cfg", severity: "warn" },
    ]);
  });

  it("still warns when a saved variable placeholder needs a printer value", () => {
    const findings = scanConfigFiles([{
      content: "[mcu]\nserial: ${KLIPPEE:mcu_serial}\n",
      path: "printer.cfg",
    }]);

    expect(findings).toMatchObject([{
      line: 2,
      path: "printer.cfg",
      severity: "warn",
    }]);
  });

  it("does not flag uploaded KAMP, relative, or wildcard includes as missing", () => {
    const findings = scanConfigFiles([
      {
        content: [
          "[include ./KAMP/Adaptive_Meshing.cfg]",
          "[include macros/*.cfg]",
        ].join("\n"),
        path: "printer.cfg",
      },
      {
        content: "[include inner.cfg]\n",
        path: "sub/base.cfg",
      },
      {
        content: "",
        path: "sub/inner.cfg",
      },
      {
        content: "",
        path: "KAMP/Adaptive_Meshing.cfg",
      },
      {
        content: "",
        path: "macros/start.cfg",
      },
    ]);

    expect(findings.filter((finding) => finding.message.includes("not present"))).toEqual([]);
  });
});
