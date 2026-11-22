import { variablesFromFiles } from "../src/packageBuilder";
import type { ConfigFile, PackageVariable } from "../src/types";

/**
 * Rebuild a package's variable schema from the placeholders that are present in
 * its current files. Existing definitions are metadata only: they may enrich a
 * still-present variable, but cannot keep a removed variable in the response.
 */
export function variableSchemaFromFiles(files: ConfigFile[], existing: PackageVariable[] = []) {
  const existingByName = new Map(existing.map((variable) => [variable.name, variable]));

  return variablesFromFiles(files, []).map((detected) => {
    const previous = existingByName.get(detected.name);
    if (!previous) {
      return detected;
    }

    return {
      ...previous,
      // Secret inference from the live files is allowed to tighten an older
      // definition, but stale metadata must never make a secret public.
      secret: previous.secret || detected.secret,
    };
  });
}
