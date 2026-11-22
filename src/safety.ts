import { workspaceIncludeExists } from "./packageBuilder";

type ScannableFile = {
  content: string;
  path: string;
};

/**
 * `kind` is "generic" for the category-level review hints (heater/motion/pin)
 * and "specific" for everything else (secrets, duplicate sections, missing
 * includes, etc.). Variable creation is intentionally initiated by selecting
 * an editor value, not by linting possible candidates.
 */
export type SafetyFinding = {
  line?: number;
  message: string;
  path: string;
  severity: "block" | "warn";
  kind?: "generic" | "specific";
  category?: string;
};

const secretLinePattern = /\b(password|passwd|token|secret|api[_-]?key|bearer)\b\s*[:=]\s*["']?[^"'\s#]{8,}/i;
const privateKeyPattern = /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/;
const includePattern = /^\s*\[include\s+([^\]]+)\]/i;
const sectionPattern = /^\s*\[([^\]]+)\]/;
const unresolvedVariablePattern = /\$\{KLIPPEE:[a-z][a-z0-9_]*\}/;
const runtimeFileNames = new Set(["saved_variables.cfg", "moonraker.secrets"]);
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
const deviceIdentityPattern = /\/dev\/(?:serial\/(?:by-id|by-path)|v4l|video\d+|video\/|input)\S*|\bcanbus_uuid\s*[:=]\s*(?!\$\{KLIPPEE:)[0-9a-f]{8,}\b|\b(?:usb_vendor_id|usb_product_id|idVendor|idProduct)\s*[:=]\s*[^\s#]+/i;
const cameraSettingPattern = /^\s*(?:camera|webcam|stream_url|snapshot_url|camera_url)\s*[:=]\s*\S+/i;
const localHostnamePattern = /\b(?:localhost|(?:[a-z0-9-]+\.)+(?:local|lan|internal|home|home\.arpa))\b/i;
const localIpv6Pattern = /(?:^|[^0-9a-f])(?:::1|(?:fc|fd)[0-9a-f:]{2,}|fe80:[0-9a-f:]{2,})(?:\/\d{1,3})?(?=$|[^0-9a-f])/i;
const hostnameFieldPattern = /^\s*(?:host|hostname|server|address|moonraker_host|camera_host)\s*[:=]\s*[a-z0-9][a-z0-9-]*(?::\d+)?\s*(?:#.*)?$/i;
const corsDomainPattern = /^\s*(?:cors_domains|cors_origin|cors_origins)\s*[:=]\s*\S+/i;
const riskyOptionPatterns = [
  {
    category: "heater",
    message: "Heater limits use machine-specific values. Review thermistor type, max_temp, and PID before installing.",
    pattern: /^\s*(max_temp|min_temp|sensor_type|heater_pin|control)\s*:/i,
  },
  {
    category: "motion",
    message: "Motion limits depend on the printer's mechanics. Review max_velocity / max_accel / rotation_distance before installing.",
    pattern: /^\s*(max_velocity|max_accel|max_z_velocity|max_z_accel|position_max|rotation_distance)\s*:/i,
  },
  {
    category: "pin",
    message: "Pin assignments are board-specific. Check every pin against your control board wiring before installing.",
    pattern: /^\s*[\w-]*pin\s*:/i,
  },
];

export function scanConfigFiles(files: ScannableFile[]) {
  const findings: SafetyFinding[] = [];
  const filePaths = new Set(files.map((file) => file.path.replace(/\\/g, "/")));

  for (const file of files) {
    const basename = file.path.split(/[\\/]/).pop()?.toLowerCase() ?? file.path.toLowerCase();
    const seenSections = new Map<string, number>();
    const seenGenericCategories = new Map<string, { firstLine: number; count: number; message: string }>();

    if (runtimeFileNames.has(basename)) {
      findings.push({
        message: "Runtime state files should stay private and out of reusable package history.",
        path: file.path,
        severity: "warn",
      });
    }

    if (/\.(zip|tar|gz|7z|rar)$/i.test(file.path)) {
      findings.push({
        message: "Archive files should be stored as imports, not synced config files.",
        path: file.path,
        severity: "warn",
      });
    }

    file.content.split("\n").forEach((line, index) => {
      const section = sectionPattern.exec(line)?.[1]?.trim().toLowerCase();
      if (section) {
        const firstLine = seenSections.get(section);
        if (firstLine) {
          findings.push({
            line: index + 1,
            message: `Duplicate section [${section}] also appears on line ${firstLine}.`,
            path: file.path,
            severity: "warn",
          });
        } else {
          seenSections.set(section, index + 1);
        }
      }

      const include = includePattern.exec(line)?.[1]?.trim();
      if (include && !workspaceIncludeExists(file.path, include, filePaths)) {
        findings.push({
          line: index + 1,
          message: `Included file ${include} is not present in this workspace.`,
          path: file.path,
          severity: "warn",
        });
      }

      if (privateKeyPattern.test(line)) {
        findings.push({
          line: index + 1,
          message: "Private key material cannot be saved into Klippee history.",
          path: file.path,
          severity: "block",
        });
      }

      if (secretLinePattern.test(line)) {
        findings.push({
          line: index + 1,
          message: "This looks like a credential or token. Remove or redact it before saving.",
          path: file.path,
          severity: "block",
        });
      }

      if (unresolvedVariablePattern.test(line)) {
        findings.push({
          category: "template-variable",
          line: index + 1,
          message: "This Klippee variable must be filled for the selected printer before install or sync.",
          path: file.path,
          severity: "warn",
        });
      }

      for (const risky of riskyOptionPatterns) {
        if (risky.pattern.test(line)) {
          const existing = seenGenericCategories.get(risky.category);
          if (existing) {
            existing.count += 1;
          } else {
            seenGenericCategories.set(risky.category, {
              firstLine: index + 1,
              count: 1,
              message: risky.message,
            });
          }
        }
      }
    });

    // Emit one summary finding per category instead of one per line.
    for (const [category, info] of seenGenericCategories) {
      findings.push({
        line: info.firstLine,
        message: info.count > 1
          ? `${info.message} (${info.count} lines in this file)`
          : info.message,
        path: file.path,
        severity: "warn",
        kind: "generic",
        category,
      });
    }
  }

  return findings;
}

/**
 * Adds publication-only privacy warnings to the general configuration review.
 * Private workspace analysis keeps using scanConfigFiles so literal hardware
 * values do not become variables or warnings until the owner reviews a public
 * publication candidate.
 */
export function scanPublicConfigFiles(files: ScannableFile[]) {
  const findings = scanConfigFiles(files);

  for (const file of files) {
    const lines = file.content.split("\n");
    let firstDeviceLine: number | undefined;
    let firstNetworkLine: number | undefined;

    lines.forEach((line, index) => {
      if (firstDeviceLine === undefined && deviceIdentityPattern.test(line)) {
        firstDeviceLine = index + 1;
      }
      // Reset the global regex state before testing each line.
      ipv4Pattern.lastIndex = 0;
      const localAddress = Array.from(line.matchAll(ipv4Pattern), ([address]) => address)
        .some((address) => isLocalIpv4Address(address));
      if (
        firstNetworkLine === undefined
        && (
          localAddress
          || localIpv6Pattern.test(line)
          || localHostnamePattern.test(line)
          || hostnameFieldPattern.test(line)
          || corsDomainPattern.test(line)
          || cameraSettingPattern.test(line)
        )
      ) {
        firstNetworkLine = index + 1;
      }
    });

    if (firstDeviceLine !== undefined) {
      findings.push({
        category: "device-identity",
        line: firstDeviceLine,
        message: "This file contains a machine-specific device or bus identifier. Replace it with a package variable before publishing if it identifies your printer.",
        path: file.path,
        severity: "warn",
      });
    }
    if (firstNetworkLine !== undefined) {
      findings.push({
        category: "network-identity",
        line: firstNetworkLine,
        message: "This file may contain a local address, hostname, or camera endpoint. Review it before publishing.",
        path: file.path,
        severity: "warn",
      });
    }
  }

  return findings;
}

function isLocalIpv4Address(value: string) {
  const [address] = value.split("/");
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function hasBlockingSafetyFindings(findings: SafetyFinding[]) {
  return findings.some((finding) => finding.severity === "block");
}
