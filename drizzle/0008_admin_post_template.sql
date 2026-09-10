CREATE TABLE `post_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `template_key` text NOT NULL,
  `name` text NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `fingerprint` text NOT NULL,
  `config_json` text DEFAULT '{}' NOT NULL CHECK (json_valid(`config_json`)),
  `updated_by` text,
  `revision_token` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_post_templates_workspace_key` ON `post_templates` (`workspace_id`,`template_key`);
--> statement-breakpoint
CREATE INDEX `idx_post_templates_workspace_updated` ON `post_templates` (`workspace_id`,`updated_at`);
