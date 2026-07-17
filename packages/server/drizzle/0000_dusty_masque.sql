CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'main' NOT NULL,
	`iban` text,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`opening_balance_date` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`month` text NOT NULL,
	`value_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asset_snapshots_asset_month` ON `asset_snapshots` (`asset_id`,`month`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`budget_id` integer NOT NULL,
	`template_id` integer,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`expected_day_of_month` integer,
	`match_normalized_counterparty` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `recurring_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_budget_lines_expected_day" CHECK(expected_day_of_month is null or expected_day_of_month between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`note` text,
	`materialized_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_budgets_month` ON `budgets` (`month`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`system_key` text,
	`is_income_source` integer DEFAULT false NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_categories_name` ON `categories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_categories_system_key` ON `categories` (`system_key`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank` text NOT NULL,
	`account_id` integer NOT NULL,
	`filename` text NOT NULL,
	`encoding_detected` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`inserted_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `labeling_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalized_counterparty` text NOT NULL,
	`category_id` integer NOT NULL,
	`example_raw` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_labeling_rules_normalized` ON `labeling_rules` (`normalized_counterparty`);--> statement-breakpoint
CREATE TABLE `recurring_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`interval_months` integer DEFAULT 1 NOT NULL,
	`expected_day_of_month` integer NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`match_normalized_counterparty` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_recurring_interval_months" CHECK(interval_months >= 1),
	CONSTRAINT "ck_recurring_expected_day" CHECK(expected_day_of_month between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`payment_date` text NOT NULL,
	`booking_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`type` text NOT NULL,
	`payer` text,
	`payee` text,
	`counterparty` text NOT NULL,
	`counterparty_iban` text,
	`counterparty_bic` text,
	`reference` text,
	`message` text,
	`archive_id` text,
	`content_hash` text NOT NULL,
	`category_id` integer,
	`category_source` text,
	`note` text,
	`import_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_transactions_category_source" CHECK((category_id is null) = (category_source is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transactions_archive_id` ON `transactions` (`archive_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_account_payment_date` ON `transactions` (`account_id`,`payment_date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_category` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_counterparty` ON `transactions` (`counterparty`);--> statement-breakpoint
CREATE INDEX `idx_transactions_import_id` ON `transactions` (`import_id`);