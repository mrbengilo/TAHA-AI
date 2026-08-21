import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const jsonText = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  timezone: text("timezone").notNull().default("Asia/Ho_Chi_Minh"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [uniqueIndex("uq_workspaces_slug").on(table.slug)]);

export const channelConnections = sqliteTable("channel_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  provider: text("provider", { enum: ["google", "facebook", "zalo_personal", "shopee", "tiktok_shop", "website"] }).notNull(),
  role: text("role", { enum: ["source", "publisher", "commerce", "both"] }).notNull(),
  displayName: text("display_name").notNull(),
  externalAccountId: text("external_account_id"),
  status: text("status", { enum: ["pending", "connected", "expired", "revoked", "error", "disabled"] }).notNull().default("pending"),
  publishMode: text("publish_mode", { enum: ["api", "assisted", "export_only"] }).notNull().default("api"),
  scopes: jsonText<string[]>("scopes_json").notNull().default([]),
  capabilities: jsonText<string[]>("capabilities_json").notNull().default([]),
  config: jsonText<Record<string, unknown>>("config_json").notNull().default({}),
  authCiphertext: text("auth_ciphertext"),
  authIv: text("auth_iv"),
  authKeyVersion: integer("auth_key_version"),
  tokenExpiresAt: timestamp("token_expires_at"),
  lastVerifiedAt: timestamp("last_verified_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  index("idx_channel_connections_workspace_provider").on(table.workspaceId, table.provider),
  index("idx_channel_connections_workspace_status").on(table.workspaceId, table.status),
  uniqueIndex("uq_channel_connections_external").on(table.workspaceId, table.provider, table.externalAccountId),
]);

export const oauthStates = sqliteTable("oauth_states", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  provider: text("provider").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  returnTo: text("return_to").notNull().default("/connections"),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_oauth_states_nonce_hash").on(table.nonceHash),
  index("idx_oauth_states_expiry").on(table.provider, table.expiresAt),
]);

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  sourceConnectionId: text("source_connection_id").references(() => channelConnections.id),
  sourceExternalId: text("source_external_id"),
  sourceModifiedAt: timestamp("source_modified_at"),
  sourceFingerprint: text("source_fingerprint"),
  baseSku: text("base_sku").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull().default(""),
  brand: text("brand"),
  category: text("category"),
  currency: text("currency").notNull().default("VND"),
  status: text("status", { enum: ["draft", "active", "paused", "archived"] }).notNull().default("draft"),
  metadata: jsonText<Record<string, unknown>>("metadata_json").notNull().default({}),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uq_products_workspace_slug").on(table.workspaceId, table.slug),
  uniqueIndex("uq_products_workspace_sku").on(table.workspaceId, table.baseSku),
  uniqueIndex("uq_products_source_external").on(table.workspaceId, table.sourceConnectionId, table.sourceExternalId),
  index("idx_products_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
]);

export const productVariants = sqliteTable("product_variants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  productId: text("product_id").notNull().references(() => products.id),
  sku: text("sku").notNull(),
  title: text("title").notNull().default("Mặc định"),
  optionValues: jsonText<Record<string, string>>("option_values_json").notNull().default({}),
  priceMinor: integer("price_minor").notNull().default(0),
  compareAtPriceMinor: integer("compare_at_price_minor"),
  costMinor: integer("cost_minor"),
  inventoryQuantity: integer("inventory_quantity").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status", { enum: ["active", "inactive", "archived"] }).notNull().default("active"),
  metadata: jsonText<Record<string, unknown>>("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_product_variants_workspace_sku").on(table.workspaceId, table.sku),
  index("idx_product_variants_product_status_sort").on(table.productId, table.status, table.sortOrder),
]);

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  sourceConnectionId: text("source_connection_id").references(() => channelConnections.id),
  channelId: text("channel_id", {
    enum: ["google_drive", "google_sheets", "facebook", "zalo_personal", "tiktok_shop", "shopee", "website"],
  }),
  mediaType: text("media_type", { enum: ["image", "video"] }).notNull(),
  origin: text("origin", { enum: ["source", "uploaded", "generated", "derived"] }).notNull(),
  storageProvider: text("storage_provider", { enum: ["google_drive", "r2", "external"] }).notNull(),
  externalId: text("external_id"),
  storageKey: text("storage_key"),
  remoteUrl: text("remote_url"),
  mimeType: text("mime_type"),
  byteSize: integer("byte_size"),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  sha256: text("sha256"),
  altText: text("alt_text"),
  generationPrompt: text("generation_prompt"),
  status: text("status", { enum: ["pending", "processing", "ready", "failed", "archived"] }).notNull().default("pending"),
  errorMessage: text("error_message"),
  metadata: jsonText<Record<string, unknown>>("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_media_assets_external").on(table.workspaceId, table.storageProvider, table.externalId),
  index("idx_media_assets_workspace_channel_created").on(table.workspaceId, table.channelId, table.createdAt),
  index("idx_media_assets_workspace_status_created").on(table.workspaceId, table.status, table.createdAt),
  index("idx_media_assets_workspace_sha256").on(table.workspaceId, table.sha256),
]);

export const channelMediaLinks = sqliteTable("channel_media_links", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  channelId: text("channel_id", {
    enum: ["google_drive", "google_sheets", "facebook", "zalo_personal", "tiktok_shop", "shopee", "website"],
  }).notNull(),
  mediaId: text("media_id").notNull().references(() => mediaAssets.id),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_channel_media_links_workspace_channel_media").on(table.workspaceId, table.channelId, table.mediaId),
  index("idx_channel_media_links_workspace_channel_created").on(table.workspaceId, table.channelId, table.createdAt),
  index("idx_channel_media_links_media").on(table.mediaId),
]);

export const productMedia = sqliteTable("product_media", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  productId: text("product_id").notNull().references(() => products.id),
  variantId: text("variant_id").references(() => productVariants.id),
  mediaId: text("media_id").notNull().references(() => mediaAssets.id),
  role: text("role", { enum: ["primary", "gallery", "source", "generated"] }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("idx_product_media_product_sort").on(table.productId, table.sortOrder),
  index("idx_product_media_variant_sort").on(table.variantId, table.sortOrder),
  index("idx_product_media_media").on(table.mediaId),
]);

export const contentDrafts = sqliteTable("content_drafts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  productId: text("product_id").notNull().references(() => products.id),
  targetProvider: text("target_provider").notNull(),
  contentType: text("content_type", { enum: ["social_post", "product_listing", "short_video_caption", "website_article"] }).notNull(),
  language: text("language").notNull().default("vi"),
  title: text("title"),
  body: text("body").notNull().default(""),
  hashtags: jsonText<string[]>("hashtags_json").notNull().default([]),
  platformData: jsonText<Record<string, unknown>>("platform_data_json").notNull().default({}),
  status: text("status", { enum: ["draft", "in_review", "approved", "rejected", "archived"] }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  generator: text("generator"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  generationMeta: jsonText<Record<string, unknown>>("generation_meta_json").notNull().default({}),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  archivedAt: timestamp("archived_at"),
}, (table) => [
  index("idx_content_drafts_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
  index("idx_content_drafts_product_provider_updated").on(table.productId, table.targetProvider, table.updatedAt),
]);

export const contentDraftMedia = sqliteTable("content_draft_media", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  draftId: text("draft_id").notNull().references(() => contentDrafts.id),
  mediaId: text("media_id").notNull().references(() => mediaAssets.id),
  role: text("role", { enum: ["primary", "attachment", "thumbnail"] }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("idx_content_draft_media_draft_sort").on(table.draftId, table.sortOrder),
  uniqueIndex("uq_content_draft_media_role").on(table.draftId, table.mediaId, table.role),
]);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  draftId: text("draft_id").notNull().references(() => contentDrafts.id),
  connectionId: text("connection_id").notNull().references(() => channelConnections.id),
  status: text("status", { enum: ["draft", "active", "paused", "completed", "cancelled"] }).notNull().default("draft"),
  scheduleKind: text("schedule_kind", { enum: ["once", "daily", "weekly"] }).notNull(),
  runAt: timestamp("run_at"),
  localTime: text("local_time"),
  weekdays: jsonText<number[]>("weekdays_json").notNull().default([]),
  timezone: text("timezone").notNull().default("Asia/Ho_Chi_Minh"),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  endsAt: timestamp("ends_at"),
  executionMode: text("execution_mode", { enum: ["inherit", "auto", "assisted"] }).notNull().default("inherit"),
  publishOptions: jsonText<Record<string, unknown>>("publish_options_json").notNull().default({}),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  index("idx_schedules_status_next_run").on(table.status, table.nextRunAt),
  index("idx_schedules_workspace_status_next_run").on(table.workspaceId, table.status, table.nextRunAt),
  index("idx_schedules_connection_status").on(table.workspaceId, table.connectionId, table.status),
]);

export const publishJobs = sqliteTable("publish_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  scheduleId: text("schedule_id").references(() => schedules.id),
  connectionId: text("connection_id").notNull().references(() => channelConnections.id),
  productId: text("product_id").references(() => products.id),
  draftId: text("draft_id").references(() => contentDrafts.id),
  jobKind: text("job_kind", { enum: ["social_post", "listing_upsert", "listing_unpublish", "inventory_sync"] }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: ["queued", "awaiting_confirmation", "publishing", "retry_wait", "blocked", "published", "failed", "cancelled"] }).notNull().default("queued"),
  scheduledFor: timestamp("scheduled_for").notNull(),
  availableAt: timestamp("available_at").notNull(),
  payloadSnapshot: jsonText<Record<string, unknown>>("payload_snapshot_json").notNull().default({}),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  externalPostId: text("external_post_id"),
  externalUrl: text("external_url"),
  providerResponse: jsonText<Record<string, unknown>>("provider_response_json").notNull().default({}),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  manualActionBy: text("manual_action_by"),
  manualActionAt: timestamp("manual_action_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_publish_jobs_dedupe_key").on(table.dedupeKey),
  index("idx_publish_jobs_status_available").on(table.status, table.availableAt),
  index("idx_publish_jobs_workspace_status_scheduled").on(table.workspaceId, table.status, table.scheduledFor),
  index("idx_publish_jobs_schedule_time").on(table.scheduleId, table.scheduledFor),
]);

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  productId: text("product_id").notNull().references(() => products.id),
  sourceMediaId: text("source_media_id").notNull().references(() => mediaAssets.id),
  requestKey: text("request_key").notNull(),
  status: text("status", {
    enum: ["queued", "processing", "completed", "failed", "cancelled"],
  }).notNull().default("queued"),
  requestedImageCount: integer("requested_image_count").notNull().default(6),
  completedImageCount: integer("completed_image_count").notNull().default(0),
  targetProviders: jsonText<string[]>("target_providers_json").notNull().default([]),
  content: jsonText<Record<string, unknown>>("content_json"),
  outputMediaIds: jsonText<string[]>("output_media_ids_json").notNull().default([]),
  textModel: text("text_model"),
  imageModel: text("image_model"),
  promptVersion: text("prompt_version").notNull().default("taha-product-v1"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  uniqueIndex("uq_automation_runs_workspace_request_key").on(table.workspaceId, table.requestKey),
  uniqueIndex("uq_automation_runs_active_product")
    .on(table.workspaceId, table.productId)
    .where(sql`${table.status} IN ('queued', 'processing')`),
  index("idx_automation_runs_workspace_status_created").on(table.workspaceId, table.status, table.createdAt),
  index("idx_automation_runs_product_created").on(table.productId, table.createdAt),
]);

export const automationSteps = sqliteTable("automation_steps", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  runId: text("run_id").notNull().references(() => automationRuns.id),
  stepType: text("step_type", { enum: ["content", "image", "finalize"] }).notNull(),
  ordinal: integer("ordinal").notNull().default(0),
  status: text("status", {
    enum: ["queued", "processing", "retry_wait", "completed", "failed", "cancelled"],
  }).notNull().default("queued"),
  availableAt: timestamp("available_at").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  result: jsonText<Record<string, unknown>>("result_json").notNull().default({}),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  uniqueIndex("uq_automation_steps_run_type_ordinal").on(table.runId, table.stepType, table.ordinal),
  index("idx_automation_steps_status_available").on(table.status, table.availableAt),
  index("idx_automation_steps_run_status_ordinal").on(table.runId, table.status, table.ordinal),
]);

export const channelMappings = sqliteTable("channel_mappings", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  connectionId: text("connection_id").notNull().references(() => channelConnections.id),
  entityType: text("entity_type", { enum: ["product", "variant", "post"] }).notNull(),
  entityId: text("entity_id").notNull(),
  externalId: text("external_id").notNull(),
  externalParentId: text("external_parent_id"),
  externalUrl: text("external_url"),
  syncStatus: text("sync_status").notNull().default("synced"),
  remoteUpdatedAt: timestamp("remote_updated_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  metadata: jsonText<Record<string, unknown>>("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_channel_mappings_local").on(table.connectionId, table.entityType, table.entityId),
  uniqueIndex("uq_channel_mappings_external").on(table.connectionId, table.entityType, table.externalId),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  actorType: text("actor_type", { enum: ["user", "system", "scheduler", "connector"] }).notNull(),
  actorId: text("actor_id"),
  actorLabel: text("actor_label"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  requestId: text("request_id"),
  before: jsonText<Record<string, unknown>>("before_json"),
  after: jsonText<Record<string, unknown>>("after_json"),
  metadata: jsonText<Record<string, unknown>>("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("idx_audit_logs_workspace_created").on(table.workspaceId, table.createdAt),
  index("idx_audit_logs_entity_created").on(table.workspaceId, table.entityType, table.entityId, table.createdAt),
  index("idx_audit_logs_request").on(table.requestId),
]);
