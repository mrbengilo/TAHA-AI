-- Store exactly one generated article per product/SKU. Channel drafts remain
-- delivery snapshots so each provider can track its own schedule and receipt,
-- but they all originate from this single canonical record.
CREATE TABLE `product_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`hashtags_json` text DEFAULT '[]' NOT NULL CHECK (json_valid(`hashtags_json`)),
	`article_version` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`source_corrections_json` text DEFAULT '[]' NOT NULL CHECK (json_valid(`source_corrections_json`)),
	`generator` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_articles_workspace_product` ON `product_articles` (`workspace_id`,`product_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_articles_workspace_sku` ON `product_articles` (`workspace_id`,`sku`);
--> statement-breakpoint
CREATE INDEX `idx_product_articles_workspace_updated` ON `product_articles` (`workspace_id`,`updated_at`);
--> statement-breakpoint
-- Migration 0006 has not written a customer draft yet. Mark its bounded retry
-- for the canonical v3 writer and remove any stale per-channel payload fields.
UPDATE automation_runs
SET prompt_version = 'taha-approved-template-v3',
  content_json = json_set(json_remove(COALESCE(content_json, '{}'),
    '$.canonicalArticle', '$.channels', '$.facebook', '$.website', '$.zalo', '$.zalo_personal',
    '$.tiktokShop', '$.tiktok_shop', '$.shopee', '$.productDescription', '$.productTitle', '$.hashtags'),
    '$.sharedArticleVersion', 'sku-canonical-v1'),
  updated_at = unixepoch() * 1000
WHERE status IN ('queued','processing')
  AND json_extract(content_json, '$.templateRecovery') = 'facebook-structure-v2';
