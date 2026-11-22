import type { OrcaCapture, OrcaLibrarySummary } from "../src/features/orca/orcaCapture";
import { parseStoredCompanionAsset } from "./companionAssets";
import { writeDb } from "./db";
import { buildOrcaPublication, orcaPublicationProfiles } from "./orcaPublication";
import type { Env } from "./types";
import { OrcaLibraryRepository } from "./repositories/OrcaLibraryRepository";
import { OrcaPublicationRepository } from "./repositories/OrcaPublicationRepository";
import { nowIso } from "./util";

export async function updateAutomaticOrcaPublications(env: Env, userId: string, expectedImport?: string, onlySourceId?: string) {
  const db = writeDb(env);
  const enabled = await OrcaLibraryRepository.hasAutomaticPublications(db, userId, onlySourceId);
  if (!enabled) return;
  const [libraries, presets, publications] = await OrcaLibraryRepository.getAutomaticSnapshot(db, userId, onlySourceId);
  const library = libraries[0];
  if (!library || !publications.length) return;
  const summary: OrcaLibrarySummary = JSON.parse(library.summary_json);
  if (expectedImport && summary.id !== expectedImport) return;
  const all: OrcaCapture["nodes"] = Object.fromEntries(presets.map(node => [node.node_id, JSON.parse(node.node_json)]));
  const profiles = orcaPublicationProfiles(summary, all);
  for (const listing of publications) {
    if (listing.orca_profile_id === null) continue;
    if (listing.auto_update_import_id === summary.id && !listing.auto_update_error) continue;
    const recordError = async (message: string) => {
      await OrcaPublicationRepository.updateAutomatic(db, userId, listing, summary.id, { autoUpdateError: message });
    };
    try {
      const built = await buildOrcaPublication(summary, all, listing.orca_profile_id, profiles);
      if (!built.candidate) {
        await recordError(built.status === 404 ? "This profile is missing from the latest import. Import it again, or disable automatic updates."
          : built.error ?? "This profile needs review before it can be updated.");
        continue;
      }
      const previous = parseStoredCompanionAsset(listing.asset_json);
      if (!previous) { await recordError("The published profile could not be read. Republish it manually."); continue; }
      const candidate = built.candidate;
      const unchanged = previous.content === candidate.content && JSON.stringify(previous.tags) === JSON.stringify(candidate.tags);
      if (unchanged) {
        // A repeated import is not a new public version. Previously approved,
        // unchanged warnings do not need another manual acknowledgement.
        await OrcaPublicationRepository.updateAutomatic(db, userId, listing, summary.id, { autoUpdateImportId: summary.id, autoUpdateError: null });
        continue;
      }
      if (candidate.findings.length) {
        await recordError("Automatic update needs review. Review the findings and republish manually; the last public version is still available.");
        continue;
      }
      const timestamp = nowIso();
      const asset = { ...previous, content: candidate.content, tags: candidate.tags, public: true,
        version: String(Number(previous.version || 0) + 1), updatedAt: timestamp };
      await OrcaPublicationRepository.updateAutomatic(db, userId, listing, summary.id, {
        assetJson: JSON.stringify(asset), updatedAt: timestamp, publishedAt: timestamp, autoUpdateImportId: summary.id, autoUpdateError: null,
      });
    } catch {
      await recordError("Automatic update to Shared Configs failed. Retry automatic updates or republish manually.");
    }
  }
}

/** Publishing must never undo or misreport a successfully saved private import. */
export async function tryUpdateAutomaticOrcaPublications(env: Env, userId: string, expectedImport?: string, onlySourceId?: string) {
  try { await updateAutomaticOrcaPublications(env, userId, expectedImport, onlySourceId); }
  catch { console.error(JSON.stringify({ event: "automatic_orca_publication_failed" })); }
}
