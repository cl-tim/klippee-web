import type { ConfigFile } from "./types";

/**
 * Opaque identity for the effective configuration contents.
 *
 * Paths and exact text are the sync contract. Role/public metadata is omitted
 * deliberately because existing capture equality has always ignored it.
 */
export async function repositoryFilesRevision(
  files: Array<Pick<ConfigFile, "content" | "path">>,
) {
  const canonical = files
    .map((file) => [file.path, file.content] as const)
    .sort(([leftPath], [rightPath]) => (
      leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    ));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}
