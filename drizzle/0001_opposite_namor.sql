CREATE UNIQUE INDEX `uq_products_workspace_sku` ON `products` (`workspace_id`,`base_sku`);--> statement-breakpoint
PRAGMA optimize;
