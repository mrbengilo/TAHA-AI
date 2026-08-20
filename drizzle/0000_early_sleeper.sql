CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`request_id` text,
	`before_json` text,
	`after_json` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_workspace_created` ON `audit_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_entity_created` ON `audit_logs` (`workspace_id`,`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_request` ON `audit_logs` (`request_id`);--> statement-breakpoint
CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text NOT NULL,
	`external_account_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`publish_mode` text DEFAULT 'api' NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`auth_ciphertext` text,
	`auth_iv` text,
	`auth_key_version` integer,
	`token_expires_at` integer,
	`last_verified_at` integer,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_channel_connections_workspace_provider` ON `channel_connections` (`workspace_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_channel_connections_workspace_status` ON `channel_connections` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_channel_connections_external` ON `channel_connections` (`workspace_id`,`provider`,`external_account_id`);--> statement-breakpoint
CREATE TABLE `channel_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_parent_id` text,
	`external_url` text,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`remote_updated_at` integer,
	`last_synced_at` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_channel_mappings_local` ON `channel_mappings` (`connection_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_channel_mappings_external` ON `channel_mappings` (`connection_id`,`entity_type`,`external_id`);--> statement-breakpoint
CREATE TABLE `content_draft_media` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`media_id` text NOT NULL,
	`role` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `content_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_content_draft_media_draft_sort` ON `content_draft_media` (`draft_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_draft_media_role` ON `content_draft_media` (`draft_id`,`media_id`,`role`);--> statement-breakpoint
CREATE TABLE `content_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product_id` text NOT NULL,
	`target_provider` text NOT NULL,
	`content_type` text NOT NULL,
	`language` text DEFAULT 'vi' NOT NULL,
	`title` text,
	`body` text DEFAULT '' NOT NULL,
	`hashtags_json` text DEFAULT '[]' NOT NULL,
	`platform_data_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`generator` text,
	`model` text,
	`prompt_version` text,
	`generation_meta_json` text DEFAULT '{}' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_content_drafts_workspace_status_updated` ON `content_drafts` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_content_drafts_product_provider_updated` ON `content_drafts` (`product_id`,`target_provider`,`updated_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_connection_id` text,
	`media_type` text NOT NULL,
	`origin` text NOT NULL,
	`storage_provider` text NOT NULL,
	`external_id` text,
	`storage_key` text,
	`remote_url` text,
	`mime_type` text,
	`byte_size` integer,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`sha256` text,
	`alt_text` text,
	`generation_prompt` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_media_assets_external` ON `media_assets` (`workspace_id`,`storage_provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_workspace_status_created` ON `media_assets` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_workspace_sha256` ON `media_assets` (`workspace_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`return_to` text DEFAULT '/connections' NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_states_nonce_hash` ON `oauth_states` (`nonce_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_states_expiry` ON `oauth_states` (`provider`,`expires_at`);--> statement-breakpoint
CREATE TABLE `product_media` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`media_id` text NOT NULL,
	`role` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_product_media_product_sort` ON `product_media` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_product_media_variant_sort` ON `product_media` (`variant_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_product_media_media` ON `product_media` (`media_id`);--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`title` text DEFAULT 'Mặc định' NOT NULL,
	`option_values_json` text DEFAULT '{}' NOT NULL,
	`price_minor` integer DEFAULT 0 NOT NULL,
	`compare_at_price_minor` integer,
	`cost_minor` integer,
	`inventory_quantity` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_variants_workspace_sku` ON `product_variants` (`workspace_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_product_variants_product_status_sort` ON `product_variants` (`product_id`,`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_connection_id` text,
	`source_external_id` text,
	`source_modified_at` integer,
	`source_fingerprint` text,
	`base_sku` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`brand` text,
	`category` text,
	`currency` text DEFAULT 'VND' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_workspace_slug` ON `products` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_source_external` ON `products` (`workspace_id`,`source_connection_id`,`source_external_id`);--> statement-breakpoint
CREATE INDEX `idx_products_workspace_status_updated` ON `products` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `publish_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`schedule_id` text,
	`connection_id` text NOT NULL,
	`product_id` text,
	`draft_id` text,
	`job_kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`scheduled_for` integer NOT NULL,
	`available_at` integer NOT NULL,
	`payload_snapshot_json` text DEFAULT '{}' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`external_post_id` text,
	`external_url` text,
	`provider_response_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`manual_action_by` text,
	`manual_action_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `content_drafts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_publish_jobs_dedupe_key` ON `publish_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_status_available` ON `publish_jobs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_workspace_status_scheduled` ON `publish_jobs` (`workspace_id`,`status`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_schedule_time` ON `publish_jobs` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`schedule_kind` text NOT NULL,
	`run_at` integer,
	`local_time` text,
	`weekdays_json` text DEFAULT '[]' NOT NULL,
	`timezone` text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`ends_at` integer,
	`execution_mode` text DEFAULT 'inherit' NOT NULL,
	`publish_options_json` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `content_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_schedules_status_next_run` ON `schedules` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_schedules_workspace_status_next_run` ON `schedules` (`workspace_id`,`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_schedules_connection_status` ON `schedules` (`workspace_id`,`connection_id`,`status`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspaces_slug` ON `workspaces` (`slug`);--> statement-breakpoint
PRAGMA optimize;
