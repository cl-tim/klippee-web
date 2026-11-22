import type { CanonicalBlobReclaimer } from "./canonicalBlobReclaimer";
import type { CompanionAssetKind } from "../src/types";

export type OAuthProvider = "github" | "discord";

export type RateLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
  ASSETS: Fetcher;
  BLOBS: R2Bucket;
  DB: D1Database;
  APP_ORIGIN: string;
  AUTH_RATE_LIMITER?: RateLimiter;
  CAD_CONTAINER: DurableObjectNamespace;
  CANONICAL_BLOB_RECLAIMER: DurableObjectNamespace<CanonicalBlobReclaimer>;
  CAD_API_BASE?: string;
  CAD_RATE_LIMITER?: RateLimiter;
  DIAGNOSTIC_UPLOAD_RATE_LIMITER: RateLimiter;
  LOG_IMPROVEMENT_RATE_LIMITER: RateLimiter;
  PACKAGE_RATE_LIMITER?: RateLimiter;
  LOCAL_AUTH_BYPASS?: string;
  SELF_HOSTED_AUTH_MODE?: string;
  LOG_IMPROVEMENT_REVIEW_TOKEN?: string;
  STORAGE_MAINTENANCE_TOKEN?: string;
  STORAGE_RECLAIM_TEST_HOOK?: Fetcher;
  PUBLIC_LISTING_PATCH_TEST_HOOK?: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
};

export type UserRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

export type IdentityRow = {
  user_id: string;
};

export type LinkedProviderRow = {
  provider: OAuthProvider;
};

export type ProviderProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type OAuthStateRow = {
  provider: OAuthProvider;
  redirect_to: string | null;
  expires_at: string;
  pkce_verifier: string | null;
};

export type AppStateRow = {
  state_json: string;
  updated_at: string;
};

export type RepositoryRow = {
  created_at: string;
  id: string;
  latest_version_id: string | null;
  name: string;
  /** Staged desired config (manifest JSON) awaiting capture on a printer apply. */
  pending_files_json?: string | null;
  pending_updated_at?: string | null;
  title: string;
  updated_at: string;
};

export type RepositoryVersionRow = {
  created_at: string;
  files_json: string;
  id: string;
  message: string;
  previous_version_id: string | null;
  source: string;
  version_number: number;
};

export type SyncTokenRow = {
  created_at: string;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  printer_id: string | null;
  scopes_json: string;
  token_prefix: string;
};

export type DiagnosticUploadRow = {
  content_type: string;
  created_at: string;
  expires_at: string;
  file_name: string;
  id: string;
  original_size_bytes: number;
  printer_id: string;
  printer_name?: string;
  r2_key: string;
  repository_id: string;
  size_bytes: number;
  truncated: number;
  user_id: string;
};

export type LogImprovementSubmissionRow = {
  consent_version: string;
  consented_at: string;
  created_at: string;
  expires_at: string;
  file_name: string;
  id: string;
  original_file_name: string;
  original_size_bytes: number;
  r2_key: string;
  redaction_confirmed: number;
  sha256: string;
  size_bytes: number;
  user_id: string;
};

export type PrivatePackageRow = {
  created_at: string;
  package_json: string;
  updated_at: string;
};

export type PublicPackageRow = {
  approved_version_id?: string | null;
  created_at: string;
  package_json: string;
  published_at: string;
  printer_id?: string | null;
  repository_id: string | null;
  slug: string;
  updated_at: string;
};

export type CompanionAssetRow = {
  asset_json: string;
  created_at: string;
  id: string;
  kind: CompanionAssetKind | "slicer";
  title: string;
  updated_at: string;
};

export type PublicCompanionAssetRow = CompanionAssetRow & {
  published_at: string;
  slug: string;
  source_asset_id: string;
  orca_profile_id?: string | null;
  auto_update_enabled?: number;
  auto_update_error?: string | null;
  auto_update_import_id?: string | null;
  printer_config_id?: string | null;
  printer_config_slug?: string | null;
  printer_config_title?: string | null;
};

export type PrinterRow = {
  applied_at?: string | null;
  applied_version_id: number;
  created_at: string;
  definition_json: string;
  description: string;
  host_info_json: string;
  host_info_updated_at: string | null;
  id: string;
  latest_version_id: number;
  make: string;
  model: string;
  name: string;
  package_ids_json: string;
  repository_id: string | null;
  source: string;
  updated_at: string;
  variable_values_json: string;
};

export type VariableValues = Record<string, string | number | boolean | null | undefined>;

export type D1Client = Pick<D1Database, "batch" | "prepare">;

export type StoredConfigFile = {
  content: string;
  path: string;
  public: boolean;
  role: string;
};

export type RepositoryFilesManifest = {
  byteLength: number;
  fileCount: number;
  key: string;
  sha256: string;
  storage: "r2";
  version: 1;
};
