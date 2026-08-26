-- Monitor (follow a company, be told when it moves) and Lookup Async (retry a lookup until a
-- source answers). Two independent features sharing one delivery mechanism: a signed POST to an
-- address the account controls, which is what `user_delivery` records one attempt at a time.

-- A default address per feature, and one signing secret for both. Two URL columns and not one
-- because the features are independent: a customer routing change events to one service and
-- finished lookups to another must not have to name the address on every row to do it. The secret
-- is shared because it identifies the sender, not the feature.
ALTER TABLE `user`
    ADD COLUMN `monitor_url` VARCHAR(2048) NULL AFTER `inactivity_warned_at`,
    ADD COLUMN `lookup_async_url` VARCHAR(2048) NULL AFTER `monitor_url`,
    ADD COLUMN `callback_secret_sealed` VARCHAR(255) NULL AFTER `lookup_async_url`;

-- One followed company per row. `last_payload_hash` is the same 128-bit digest `company` keeps,
-- written by the same `payloadHash()`, so "has it changed" is one fixed-width comparison.
-- `last_delivered_at` older than `last_changed_at` means the last change was never accepted by the
-- receiving end: a state of its own, and not the same thing as nothing having changed.
CREATE TABLE `user_monitor` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `vat_number` VARCHAR(20) NOT NULL,
    `url` VARCHAR(2048) NULL,
    `last_payload_hash` BINARY(16) NULL,
    `last_payload` JSON NULL,
    `last_source` VARCHAR(32) NULL,
    `last_checked_at` DATETIME(0) NULL,
    `last_changed_at` DATETIME(0) NULL,
    `last_delivered_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_user_monitor_public_id`(`public_id`),
    INDEX `idx_user_monitor_user`(`user_id`, `created_at`),
    UNIQUE INDEX `uq_user_monitor_user_vat`(`user_id`, `vat_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- `idx_user_async_lookup_due` is the cron's only query: pending rows whose retry date has passed.
-- `delivered_at` null on a finished row means the answer exists and never reached the customer.
CREATE TABLE `user_async_lookup` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `vat_number` VARCHAR(20) NOT NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'single',
    `url` VARCHAR(2048) NULL,
    `status` ENUM('pending', 'success', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `retry_after` DATETIME(0) NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `completed_at` DATETIME(0) NULL,
    `delivered_at` DATETIME(0) NULL,
    `response` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_user_async_lookup_public_id`(`public_id`),
    INDEX `idx_user_async_lookup_due`(`status`, `retry_after`),
    INDEX `idx_user_async_lookup_user`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- What each attempt concluded and when. A table and not a counter: "it has failed nine times"
-- is not the question, "what has it been getting" is.
CREATE TABLE `user_async_lookup_attempt` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `async_lookup_id` BIGINT UNSIGNED NOT NULL,
    `attempted_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `outcome` VARCHAR(16) NOT NULL,
    `http_status` SMALLINT UNSIGNED NULL,
    `error_code` VARCHAR(32) NULL,
    `fault` VARCHAR(32) NULL,
    `duration_ms` INTEGER UNSIGNED NULL,

    INDEX `idx_user_async_lookup_attempt_parent`(`async_lookup_id`, `attempted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per delivery *attempt*, for both features. Exactly one of `monitor_id` and
-- `async_lookup_id` is ever set; the columns either side of them are identical for both, and the
-- console renders the same table on both detail pages. `payload` is what makes a resend possible:
-- it is the exact body that went out, so sending it again sends the same thing.
CREATE TABLE `user_delivery` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `monitor_id` BIGINT UNSIGNED NULL,
    `async_lookup_id` BIGINT UNSIGNED NULL,
    `event` VARCHAR(24) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `payload` JSON NOT NULL,
    `attempt` TINYINT UNSIGNED NOT NULL,
    `http_status` SMALLINT UNSIGNED NULL,
    `error` VARCHAR(255) NULL,
    `duration_ms` INTEGER UNSIGNED NULL,
    `sent_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_user_delivery_public_id`(`public_id`),
    INDEX `idx_user_delivery_monitor`(`monitor_id`, `sent_at`),
    INDEX `idx_user_delivery_async`(`async_lookup_id`, `sent_at`),
    INDEX `idx_user_delivery_user`(`user_id`, `sent_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_monitor` ADD CONSTRAINT `user_monitor_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_async_lookup` ADD CONSTRAINT `user_async_lookup_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_async_lookup_attempt` ADD CONSTRAINT `user_async_lookup_attempt_async_lookup_id_fkey` FOREIGN KEY (`async_lookup_id`) REFERENCES `user_async_lookup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_delivery` ADD CONSTRAINT `user_delivery_monitor_id_fkey` FOREIGN KEY (`monitor_id`) REFERENCES `user_monitor`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_delivery` ADD CONSTRAINT `user_delivery_async_lookup_id_fkey` FOREIGN KEY (`async_lookup_id`) REFERENCES `user_async_lookup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
