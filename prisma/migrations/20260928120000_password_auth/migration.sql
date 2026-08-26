-- Email + password replaces the magic link.
--
-- Existing accounts get no password (they set one through "forgotten password", which also
-- verifies their address) and no verified address: an account was created the moment a link was
-- *asked for*, so its existence proves nothing about the mailbox. The first-steps panel is marked
-- dismissed for all of them — it is for people who have just signed up.
ALTER TABLE `user`
    ADD COLUMN `password_hash` VARCHAR(255) NULL,
    ADD COLUMN `password_changed_at` DATETIME(0) NULL,
    ADD COLUMN `email_verified_at` DATETIME(0) NULL,
    ADD COLUMN `onboarding_dismissed_at` DATETIME(0) NULL;

UPDATE `user` SET `onboarding_dismissed_at` = CURRENT_TIMESTAMP(0);

-- The same table now carries verification and reset links; old rows are magic links.
ALTER TABLE `auth_login_token`
    ADD COLUMN `purpose` ENUM('login', 'verify_email', 'reset_password') NOT NULL DEFAULT 'login' AFTER `user_id`,
    DROP INDEX `idx_login_tokens_user`,
    ADD INDEX `idx_login_tokens_user`(`user_id`, `purpose`, `created_at`);

-- CreateTable
CREATE TABLE `rate_limit_auth` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(16) NOT NULL,
    `ip` VARCHAR(45) NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_auth_attempts_ip`(`kind`, `ip`, `created_at`),
    INDEX `idx_auth_attempts_user`(`kind`, `user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
