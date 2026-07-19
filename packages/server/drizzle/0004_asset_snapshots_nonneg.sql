PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_asset_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`month` text NOT NULL,
	`value_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_asset_snapshots_value_nonneg" CHECK("__new_asset_snapshots"."value_cents" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_asset_snapshots`("id", "asset_id", "month", "value_cents", "created_at") SELECT "id", "asset_id", "month", "value_cents", "created_at" FROM `asset_snapshots`;--> statement-breakpoint
DROP TABLE `asset_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_asset_snapshots` RENAME TO `asset_snapshots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asset_snapshots_asset_month` ON `asset_snapshots` (`asset_id`,`month`);