CREATE TABLE `staged_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`payment_date` text NOT NULL,
	`booking_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`type` text NOT NULL,
	`payer` text,
	`payee` text,
	`counterparty` text NOT NULL,
	`normalized_counterparty` text NOT NULL,
	`counterparty_iban` text,
	`reference` text,
	`message` text,
	`archive_id` text,
	`content_hash` text NOT NULL,
	`dup_state` text NOT NULL,
	`duplicate_account_id` integer,
	`before_opening` integer DEFAULT false NOT NULL,
	`proposed_category_id` integer,
	`proposed_source` text,
	`chosen_category_id` integer,
	`remember_rule` integer DEFAULT false NOT NULL,
	`note` text,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposed_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chosen_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_staged_transactions_import_id` ON `staged_transactions` (`import_id`);--> statement-breakpoint
CREATE INDEX `idx_staged_transactions_normalized` ON `staged_transactions` (`import_id`,`normalized_counterparty`);--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `counterparty_bic`;