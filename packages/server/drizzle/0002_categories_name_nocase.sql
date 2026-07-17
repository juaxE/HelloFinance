DROP INDEX IF EXISTS `uq_categories_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_categories_name` ON `categories` ("name" collate nocase);