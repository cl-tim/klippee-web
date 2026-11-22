import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Application D1 models. SQL migrations remain the
// authoritative schema, including foreign keys, CHECK constraints and indexes.
// These definitions are not input to a migration generator.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), displayName: text("display_name").notNull(), avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const userIdentities = sqliteTable("user_identities", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), provider: text("provider").notNull(),
  providerUserId: text("provider_user_id").notNull(), providerUsername: text("provider_username").notNull(), avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), sessionHash: text("session_hash").notNull(),
  expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull(),
});
export const oauthStates = sqliteTable("oauth_states", {
  id: text("id").primaryKey(), provider: text("provider").notNull(), redirectTo: text("redirect_to"),
  expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull(), pkceVerifier: text("pkce_verifier"),
});
export const userAppState = sqliteTable("user_app_state", {
  userId: text("user_id").primaryKey(), stateJson: text("state_json").notNull(), updatedAt: text("updated_at").notNull(),
});

export const diagnosticUploads = sqliteTable("diagnostic_uploads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  printerId: text("printer_id").notNull(),
  repositoryId: text("repository_id").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  originalSizeBytes: integer("original_size_bytes").notNull(),
  truncated: integer("truncated").notNull().default(0),
  r2Key: text("r2_key").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const logImprovementSubmissions = sqliteTable("log_improvement_submissions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  originalFileName: text("original_file_name").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  originalSizeBytes: integer("original_size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  r2Key: text("r2_key").notNull(),
  consentVersion: text("consent_version").notNull(),
  consentedAt: text("consented_at").notNull(),
  redactionConfirmed: integer("redaction_confirmed").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const canonicalBlobs = sqliteTable("canonical_blobs", {
  sha256: text("sha256").primaryKey(), sizeBytes: integer("size_bytes").notNull(),
  chargeBytes: integer("charge_bytes").notNull(), createdAt: text("created_at").notNull(), storedAt: text("stored_at"),
});
export const userBlobClaims = sqliteTable("user_blob_claims", {
  userId: text("user_id").notNull(), sha256: text("sha256").notNull(), sizeBytes: integer("size_bytes").notNull(),
  chargeBytes: integer("charge_bytes").notNull(), createdAt: text("created_at").notNull(),
});
export const canonicalBlobBudgetTotal = sqliteTable("canonical_blob_budget_total", {
  id: integer("id").primaryKey(), chargeBytes: integer("charge_bytes").notNull(),
});
export const userBlobBudgetTotals = sqliteTable("user_blob_budget_totals", {
  userId: text("user_id").primaryKey(), chargeBytes: integer("charge_bytes").notNull(),
});
export const canonicalBlobBudgetReservations = sqliteTable("canonical_blob_budget_reservations", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), status: text("status", { enum: ["ok", "service", "user"] }).notNull(),
  createdAt: text("created_at").notNull(),
});
export const canonicalBlobRepositoryVersionRefs = sqliteTable("canonical_blob_repository_version_refs", {
  versionId: text("version_id").notNull(), sha256: text("sha256").notNull(),
});
export const canonicalBlobPendingRefs = sqliteTable("canonical_blob_pending_refs", {
  repositoryId: text("repository_id").notNull(), sha256: text("sha256").notNull(),
});
export const canonicalBlobPrivatePackageRefs = sqliteTable("canonical_blob_private_package_refs", {
  privatePackageId: text("private_package_id").notNull(), sha256: text("sha256").notNull(),
});
export const canonicalBlobPublicPackageRefs = sqliteTable("canonical_blob_public_package_refs", {
  publicPackageId: text("public_package_id").notNull(), sha256: text("sha256").notNull(),
});
export const canonicalBlobWriteLeases = sqliteTable("canonical_blob_write_leases", {
  leaseId: text("lease_id").notNull(), userId: text("user_id").notNull(), sha256: text("sha256").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(),
});
export const canonicalBlobGcCandidates = sqliteTable("canonical_blob_gc_candidates", {
  r2Key: text("r2_key").primaryKey(), sha256: text("sha256").notNull(),
  firstSeenAt: text("first_seen_at").notNull(), lastCheckedAt: text("last_checked_at").notNull(), reclaimAfter: text("reclaim_after").notNull(),
  objectSizeBytes: integer("object_size_bytes"), objectEtag: text("object_etag"), objectVersion: text("object_version"),
  objectUploadedAt: text("object_uploaded_at"), deleteToken: text("delete_token"), deleteStartedAt: text("delete_started_at"), lastError: text("last_error"),
});
export const canonicalBlobGcEvents = sqliteTable("canonical_blob_gc_events", {
  id: text("id").primaryKey(), r2Key: text("r2_key").notNull(), sha256: text("sha256").notNull(), state: text("state").notNull(),
  objectSizeBytes: integer("object_size_bytes"), objectEtag: text("object_etag"), objectVersion: text("object_version"),
  objectUploadedAt: text("object_uploaded_at"), startedAt: text("started_at").notNull(), completedAt: text("completed_at"), outcome: text("outcome"), error: text("error"),
});

export const privatePackages = sqliteTable("private_packages", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  packageId: text("package_id").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  packageJson: text("package_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const companionAssets = sqliteTable("companion_assets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind", { enum: ["slicer", "filament", "machine", "process"] }).notNull(),
  title: text("title").notNull(),
  assetJson: text("asset_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  latestVersionId: text("latest_version_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  pendingFilesJson: text("pending_files_json"),
  pendingUpdatedAt: text("pending_updated_at"),
});

export const syncTokens = sqliteTable("sync_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  repositoryId: text("repository_id").notNull(),
  printerId: text("printer_id"),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  scopesJson: text("scopes_json").notNull(),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
});

export const orcaCaptureGrants = sqliteTable("orca_capture_grants", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  printerId: text("printer_id"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  scope: text("scope").notNull().default("setup"),
  deviceId: text("device_id"),
});

export const orcaDevices = sqliteTable("orca_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
  uploadsEnabled: integer("uploads_enabled").notNull().default(0),
});

export const orcaSetups = sqliteTable("orca_setups", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  printerId: text("printer_id"),
  summaryJson: text("summary_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const orcaLibraryImports = sqliteTable("orca_library_imports", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  summaryJson: text("summary_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const orcaLibraryNodes = sqliteTable("orca_library_nodes", {
  userId: text("user_id").notNull(),
  nodeId: text("node_id").notNull(),
  nodeJson: text("node_json").notNull(),
});

export const orcaLibraries = sqliteTable("orca_libraries", {
  userId: text("user_id").primaryKey(),
  importId: text("import_id").notNull(),
  summaryJson: text("summary_json").notNull(),
  currentJson: text("current_json").notNull(),
});

export const orcaProfilePrinters = sqliteTable("orca_profile_printers", {
  userId: text("user_id").notNull(),
  profileId: text("profile_id").notNull(),
  printerId: text("printer_id").notNull(),
});

export const repositoryVersions = sqliteTable("repository_versions", {
  id: text("id").primaryKey(),
  repositoryId: text("repository_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  previousVersionId: text("previous_version_id"),
  message: text("message").notNull(),
  source: text("source").notNull(),
  filesJson: text("files_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const physicalPrinters = sqliteTable("printers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  make: text("make").notNull().default(""),
  model: text("model").notNull().default(""),
  source: text("source").notNull().default("manual"),
  definitionJson: text("definition_json").notNull().default("{}"),
  packageIdsJson: text("package_ids_json").notNull().default("[]"),
  variableValuesJson: text("variable_values_json").notNull().default("{}"),
  repositoryId: text("repository_id"),
  latestVersionId: integer("latest_version_id").notNull().default(0),
  appliedVersionId: integer("applied_version_id").notNull().default(0),
  knownGoodVersionId: integer("known_good_version_id").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  hostInfoJson: text("host_info_json").notNull().default("{}"),
  hostInfoUpdatedAt: text("host_info_updated_at"),
  appliedAt: text("applied_at"),
});

export const publicPackages = sqliteTable("public_packages", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sourcePackageId: text("source_package_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  packageJson: text("package_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  publishedAt: text("published_at").notNull(),
  printerFacet: text("printer_facet").notNull().default(""),
  tagsFacet: text("tags_facet").notNull().default(""),
  searchText: text("search_text").notNull().default(""),
  repositoryId: text("repository_id"),
  printerId: text("printer_id"),
  approvedVersionId: text("approved_version_id"),
  autoUpdateEnabled: integer("auto_update_enabled").notNull().default(0),
  autoUpdateError: text("auto_update_error"),
});

export const publicCompanionAssets = sqliteTable("public_companion_assets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sourceAssetId: text("source_asset_id").notNull(),
  slug: text("slug").notNull(),
  kind: text("kind", { enum: ["slicer", "filament", "machine", "process"] }).notNull(),
  title: text("title").notNull(),
  assetJson: text("asset_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  publishedAt: text("published_at").notNull(),
  orcaProfileId: text("orca_profile_id"),
  autoUpdateEnabled: integer("auto_update_enabled").notNull().default(0),
  autoUpdateError: text("auto_update_error"),
  autoUpdateImportId: text("auto_update_import_id"),
  printerConfigId: text("printer_config_id"),
});
