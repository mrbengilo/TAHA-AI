CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`product_id` text NOT NULL,
	`source_media_id` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_image_count` integer DEFAULT 6 NOT NULL,
	`completed_image_count` integer DEFAULT 0 NOT NULL,
	`target_providers_json` text DEFAULT '[]' NOT NULL,
	`content_json` text,
	`output_media_ids_json` text DEFAULT '[]' NOT NULL,
	`text_model` text,
	`image_model` text,
	`prompt_version` text DEFAULT 'taha-product-v1' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_media_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_automation_runs_workspace_request_key` ON `automation_runs` (`workspace_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_automation_runs_active_product` ON `automation_runs` (`workspace_id`,`product_id`) WHERE `status` IN ('queued', 'processing');--> statement-breakpoint
CREATE INDEX `idx_automation_runs_workspace_status_created` ON `automation_runs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_runs_product_created` ON `automation_runs` (`product_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step_type` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`available_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`result_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_automation_steps_run_type_ordinal` ON `automation_steps` (`run_id`,`step_type`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_automation_steps_status_available` ON `automation_steps` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_steps_run_status_ordinal` ON `automation_steps` (`run_id`,`status`,`ordinal`);
