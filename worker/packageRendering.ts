import type { ConfigPackage } from "../src/types";
import {
  TemplateRenderLimitError as PackageRenderLimitError,
  renderTemplateFiles,
  unresolvedTemplateVariables,
} from "../src/templateRendering";
import { maxRenderedPackageBytes, renderedZipArtifactTtlSeconds } from "./constants";
import { printerVariableValuesForRequest } from "./printerShared";
import type { Env, VariableValues } from "./types";
import { nowIso } from "./util";

export { PackageRenderLimitError, unresolvedTemplateVariables };

export function renderPackageFiles(
  files: ConfigPackage["files"],
  values: VariableValues,
  limitBytes = maxRenderedPackageBytes,
) {
  return renderTemplateFiles(files, values, limitBytes);
}

export function safeZipFilename(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "klippee-config";
}

function omitSecretVariableValues(pkg: ConfigPackage, values: VariableValues) {
  const secretNames = new Set(
    pkg.variables
      .filter((variable) => variable.secret || variable.type === "secret")
      .map((variable) => variable.name),
  );
  return Object.fromEntries(Object.entries(values).filter(([name]) => !secretNames.has(name))) as VariableValues;
}

export class PackageVariableInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageVariableInputError";
  }
}

function declaredVariableValues(
  pkg: ConfigPackage,
  candidate: unknown,
  options: { rejectInvalid: boolean },
) {
  if (candidate === undefined) {
    return {} as VariableValues;
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    if (options.rejectInvalid) {
      throw new PackageVariableInputError("Package variables must be an object of scalar values");
    }
    return {} as VariableValues;
  }

  const record = candidate as Record<string, unknown>;
  const values: VariableValues = {};
  for (const variable of pkg.variables) {
    if (!Object.prototype.hasOwnProperty.call(record, variable.name)) {
      continue;
    }
    const value = record[variable.name];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || value === null
    ) {
      values[variable.name] = value;
      continue;
    }
    if (options.rejectInvalid) {
      throw new PackageVariableInputError(
        `Package variable ${variable.name} must be a string, number, boolean, or null`,
      );
    }
  }
  return values;
}

export async function renderValuesForBody(
  request: Request,
  env: Env,
  pkg: ConfigPackage,
  body: unknown,
  options: { allowSecrets: boolean },
) {
  const bodyRecord = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const bodyValues = declaredVariableValues(pkg, bodyRecord?.variables, { rejectInvalid: true });
  const storedPrinterValues = await printerVariableValuesForRequest(
    request,
    env,
    bodyRecord?.printerId,
  );
  // Legacy printer rows predate strict scalar validation. Ignore any malformed
  // stored entry rather than letting one stale value break every render.
  const printerValues = declaredVariableValues(
    pkg,
    // Stored values are convenience defaults, never a source for declared
    // secrets. A secret may only arrive in the current authenticated POST body.
    omitSecretVariableValues(pkg, storedPrinterValues),
    { rejectInvalid: false },
  );
  const values = {
    ...printerValues,
    ...bodyValues,
  };

  return options.allowSecrets ? values : omitSecretVariableValues(pkg, values);
}

// New ZIP downloads are intentionally ephemeral and never written to R2. Keep
// the historical prefix exported while the scheduled reaper drains artifacts
// created by older deployments.
export const renderedZipArtifactPrefix = "artifacts/rendered-zips/";

// Legacy lifecycle cleanup for the former rendered-zip cache (#279). Rendered
// downloads are no longer persisted, but the scheduled worker must continue to
// reap existing objects past their `expiresAt`. Objects written before expiry
// metadata existed are reaped once their upload age passes the same TTL.
export async function removeExpiredRenderedZipArtifacts(
  env: Env,
  referenceIso = nowIso(),
  maxDeletePerRun = 500,
) {
  const legacyCutoffMs = Date.parse(referenceIso) - renderedZipArtifactTtlSeconds * 1000;
  let cursor: string | undefined;
  let removed = 0;

  for (let batch = 0; batch < 20 && removed < maxDeletePerRun; batch += 1) {
    const listing = await env.BLOBS.list({
      cursor,
      include: ["customMetadata"],
      limit: 200,
      prefix: renderedZipArtifactPrefix,
    });

    const remainingAllowance = maxDeletePerRun - removed;
    const expiredKeys = listing.objects
      .filter((object) => {
        const expiresAt = object.customMetadata?.expiresAt;
        if (typeof expiresAt === "string" && expiresAt) {
          return expiresAt <= referenceIso;
        }
        return object.uploaded instanceof Date && object.uploaded.getTime() <= legacyCutoffMs;
      })
      .map((object) => object.key)
      .slice(0, remainingAllowance);

    if (expiredKeys.length) {
      await Promise.all(expiredKeys.map((key) => env.BLOBS.delete(key)));
      removed += expiredKeys.length;
    }

    if (!listing.truncated) {
      break;
    }
    cursor = listing.cursor;
  }

  return removed;
}
