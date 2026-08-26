-- When a bulk artefact was last read to the end; null while it never has been.
ALTER TABLE `bulk` ADD COLUMN `imported_at` DATETIME(0) NULL AFTER `created_at`;
