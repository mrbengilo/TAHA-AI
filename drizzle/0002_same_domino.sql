CREATE TABLE `channel_media_links` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`media_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_channel_media_links_workspace_channel_media` ON `channel_media_links` (`workspace_id`,`channel_id`,`media_id`);--> statement-breakpoint
CREATE INDEX `idx_channel_media_links_workspace_channel_created` ON `channel_media_links` (`workspace_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_channel_media_links_media` ON `channel_media_links` (`media_id`);--> statement-breakpoint
ALTER TABLE `media_assets` ADD `channel_id` text;--> statement-breakpoint
CREATE INDEX `idx_media_assets_workspace_channel_created` ON `media_assets` (`workspace_id`,`channel_id`,`created_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `channel_media_links` (`id`, `workspace_id`, `channel_id`, `media_id`, `created_by`, `created_at`)
SELECT lower(hex(randomblob(16))), dm.`workspace_id`, d.`target_provider`, dm.`media_id`, NULL, dm.`created_at`
FROM `content_draft_media` dm
JOIN `content_drafts` d ON d.`id` = dm.`draft_id` AND d.`workspace_id` = dm.`workspace_id`
JOIN `media_assets` m ON m.`id` = dm.`media_id` AND m.`workspace_id` = dm.`workspace_id`
WHERE d.`target_provider` IN ('google_drive', 'google_sheets', 'facebook', 'zalo_personal', 'tiktok_shop', 'shopee', 'website');--> statement-breakpoint
PRAGMA optimize;
