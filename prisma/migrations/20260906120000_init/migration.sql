-- CreateTable
CREATE TABLE `company` (
    `vat_number` VARCHAR(20) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `date_start` DATE NOT NULL,
    `date_end` DATE NOT NULL,
    `status` ENUM('active', 'inactive', 'not_registered', 'unknown') NOT NULL DEFAULT 'unknown',
    `national_id` VARCHAR(32) NULL,
    `name` VARCHAR(255) NULL,
    `legal_form` VARCHAR(128) NULL,
    `address_line1` VARCHAR(255) NULL,
    `address_line2` VARCHAR(255) NULL,
    `postal_code` VARCHAR(16) NULL,
    `city` VARCHAR(128) NULL,
    `address_country` CHAR(2) NULL,
    `company_last_updated_at` DATETIME(0) NULL,
    `bulk_id` BIGINT UNSIGNED NULL,
    `proof` VARCHAR(255) NULL,
    `payload_hash` BINARY(16) NOT NULL,

    INDEX `idx_company_bulk`(`bulk_id`),
    PRIMARY KEY (`vat_number`, `source`, `date_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bulk` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(32) NOT NULL,
    `url` VARCHAR(1024) NOT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `date` DATE NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_bulk_source_file`(`source`, `file_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `log_import` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `country_code` CHAR(2) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `started_at` DATETIME(0) NOT NULL,
    `finished_at` DATETIME(0) NULL,
    `status` ENUM('running', 'success', 'failed') NOT NULL DEFAULT 'running',
    `file_name` VARCHAR(255) NULL,
    `file_date` DATE NULL,
    `counters` JSON NULL,
    `error` TEXT NULL,

    INDEX `idx_import_runs_country`(`country_code`, `started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `log_source_call` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(32) NOT NULL,
    `vat_number` VARCHAR(20) NOT NULL,
    `operation` VARCHAR(32) NULL,
    `attempt` TINYINT UNSIGNED NOT NULL,
    `called_at` DATETIME(3) NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `outcome` VARCHAR(32) NOT NULL,
    `error` BOOLEAN NOT NULL,
    `fault` VARCHAR(255) NULL,
    `http_status` SMALLINT UNSIGNED NULL,
    `has_name` BOOLEAN NULL,
    `has_address` BOOLEAN NULL,
    `has_proof` BOOLEAN NULL,

    INDEX `idx_log_source_call_called_at`(`called_at`),
    INDEX `idx_log_source_call_source`(`source`, `called_at`),
    INDEX `idx_log_source_call_vat_number`(`vat_number`, `called_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `log_lookup` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `vat_number` VARCHAR(20) NULL,
    `status` VARCHAR(32) NOT NULL,
    `success` BOOLEAN NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `timings` JSON NOT NULL,
    `source` VARCHAR(32) NULL,
    `source_date` DATE NULL,
    `fault` VARCHAR(255) NULL,
    `attempts` TINYINT UNSIGNED NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'single',
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `user_id` BIGINT UNSIGNED NULL,
    `secret_key_id` BIGINT UNSIGNED NULL,

    INDEX `idx_lookup_logs_vat_number`(`vat_number`, `created_at`),
    INDEX `idx_lookup_logs_secret_key`(`secret_key_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_audit` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `secret_key_id` BIGINT UNSIGNED NULL,
    `vat_number` VARCHAR(20) NOT NULL,
    `http_status` SMALLINT UNSIGNED NOT NULL,
    `error_code` VARCHAR(32) NULL,
    `company_name` VARCHAR(255) NULL,
    `source` VARCHAR(32) NULL,
    `source_date` DATE NULL,
    `sources` JSON NOT NULL,
    `proof` VARCHAR(255) NULL,
    `kind` VARCHAR(8) NOT NULL DEFAULT 'single',
    `response` JSON NOT NULL,
    `fetched_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_audit_lookups_public_id`(`public_id`),
    INDEX `idx_audit_lookups_user_vat`(`user_id`, `vat_number`, `fetched_at`),
    INDEX `idx_audit_lookups_user_fetched`(`user_id`, `fetched_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `plan` ENUM('free', 'pro') NOT NULL DEFAULT 'free',
    `locale` CHAR(2) NOT NULL DEFAULT 'en',
    `status` ENUM('active', 'suspended', 'deleted') NOT NULL DEFAULT 'active',
    `stripe_customer_id` VARCHAR(64) NULL,
    `stripe_subscription_id` VARCHAR(64) NULL,
    `subscription_status` VARCHAR(32) NULL,
    `current_period_end` DATETIME(0) NULL,
    `cancel_at` DATETIME(0) NULL,
    `terms_version` VARCHAR(32) NULL,
    `terms_accepted_at` DATETIME(0) NULL,
    `terms_accepted_ip` VARCHAR(45) NULL,
    `deleted_at` DATETIME(0) NULL,
    `inactivity_warned_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    UNIQUE INDEX `uq_accounts_email`(`email`),
    UNIQUE INDEX `uq_accounts_stripe_customer`(`stripe_customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_login_token` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `consumed_at` DATETIME(0) NULL,
    `request_ip` VARCHAR(45) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_login_tokens_hash`(`token_hash`),
    INDEX `idx_login_tokens_user`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_console_lookup` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ip` VARCHAR(45) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_console_vat_lookups_ip`(`ip`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_site_lookup` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ip` VARCHAR(45) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_site_vat_lookups_ip`(`ip`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_session` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `last_seen_at` DATETIME(0) NOT NULL,
    `user_agent` VARCHAR(255) NULL,
    `ip` VARCHAR(45) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_sessions_hash`(`token_hash`),
    INDEX `idx_sessions_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_api_secret_token` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `last4` CHAR(4) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `secret_sealed` VARCHAR(255) NULL,
    `last_used_at` DATETIME(0) NULL,
    `revoked_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_secret_keys_hash`(`key_hash`),
    INDEX `idx_secret_keys_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_usage_period` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `period_start` DATETIME(0) NOT NULL,
    `period_end` DATETIME(0) NOT NULL,
    `plan` ENUM('free', 'pro') NOT NULL,
    `quota` INTEGER NOT NULL,
    `used` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_usage_periods_user_start`(`user_id`, `period_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_company` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `company_name` VARCHAR(255) NOT NULL,
    `vat_number` VARCHAR(20) NULL,
    `line1` VARCHAR(255) NOT NULL,
    `line2` VARCHAR(255) NULL,
    `postal_code` VARCHAR(16) NOT NULL,
    `city` VARCHAR(128) NOT NULL,
    `country` CHAR(2) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stripe_event` (
    `id` VARCHAR(64) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `received_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `company` ADD CONSTRAINT `company_bulk_id_fkey` FOREIGN KEY (`bulk_id`) REFERENCES `bulk`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_login_token` ADD CONSTRAINT `auth_login_token_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_session` ADD CONSTRAINT `auth_session_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_api_secret_token` ADD CONSTRAINT `user_api_secret_token_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_usage_period` ADD CONSTRAINT `user_usage_period_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_company` ADD CONSTRAINT `user_company_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
