<?php
/**
 * Schema migrations.
 *
 * Runs automatically when the app boots and the stored schema version is behind
 * the code. Every statement must be safe to re-run (IF NOT EXISTS, or guarded by
 * a column check), because shared hosting gives us no migration tooling and the
 * upgrade path is "upload the new files".
 */
final class Migrations
{
    /** Bump this when adding a migration below. */
    public const VERSION = 5;

    public static function run(): void
    {
        $current = (int)Config::setting('schema_version', 0);
        if ($current >= self::VERSION) {
            return;
        }

        try {
            if ($current < 2) {
                self::v2Annotations();
            }
            if ($current < 3) {
                self::v3ReplaceMedia();
            }
            if ($current < 4) {
                self::v4Segments();
            }
            if ($current < 5) {
                self::v5ApiTokens();
            }
            Config::putSetting('schema_version', (string)self::VERSION);
        } catch (Throwable $e) {
            // A failed migration must not take the whole app down; log and carry
            // on so the rest of the site still works.
            error_log('[myloom][migrate] ' . $e->getMessage());
        }
    }

    /**
     * v5 — API tokens, so the browser extension can authenticate.
     * A session cookie is no use to it: cookies are SameSite=Lax and are not
     * sent on the extension's cross-origin requests.
     */
    private static function v5ApiTokens(): void
    {
        Db::pdo()->exec(
            'CREATE TABLE IF NOT EXISTS `api_tokens` (
              `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
              `user_id`      INT UNSIGNED NOT NULL,
              `name`         VARCHAR(120) NOT NULL DEFAULT "Browser extension",
              `token_hash`   CHAR(64) NOT NULL,
              `prefix`       VARCHAR(12) NOT NULL,
              `workspace_id` INT UNSIGNED DEFAULT NULL,
              `last_used_at` DATETIME DEFAULT NULL,
              `revoked`      TINYINT(1) NOT NULL DEFAULT 0,
              `created_at`   DATETIME NOT NULL,
              PRIMARY KEY (`id`),
              UNIQUE KEY `uniq_token_hash` (`token_hash`),
              KEY `idx_token_user` (`user_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        );
    }

    /**
     * v4 — keep-segments. A video becomes an ordered list of ranges to play,
     * which covers cutting the middle out, stitching pieces and reordering.
     * A single segment is the same thing as the old trim.
     */
    private static function v4Segments(): void
    {
        $has = Db::one("SHOW COLUMNS FROM `videos` LIKE 'segments'");
        if (!$has) {
            Db::pdo()->exec('ALTER TABLE `videos` ADD COLUMN `segments` TEXT DEFAULT NULL AFTER `trim_end`');
        }
    }

    /** v3 — staging path so a re-encoded file can replace a video's media. */
    private static function v3ReplaceMedia(): void
    {
        $has = Db::one("SHOW COLUMNS FROM `uploads` LIKE 'temp_path'");
        if (!$has) {
            Db::pdo()->exec('ALTER TABLE `uploads` ADD COLUMN `temp_path` VARCHAR(255) DEFAULT NULL');
        }
    }

    /** v2 — on-video annotations (text, links, blur, shapes). */
    private static function v2Annotations(): void
    {
        Db::pdo()->exec(
            'CREATE TABLE IF NOT EXISTS `annotations` (
              `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
              `video_id`      INT UNSIGNED NOT NULL,
              `type`          ENUM("text","link","blur","rect","ellipse","arrow") NOT NULL DEFAULT "text",
              `start_time`    DECIMAL(10,2) NOT NULL DEFAULT 0,
              `end_time`      DECIMAL(10,2) NOT NULL DEFAULT 0,
              `x`             DECIMAL(6,5) NOT NULL DEFAULT 0.1,
              `y`             DECIMAL(6,5) NOT NULL DEFAULT 0.1,
              `w`             DECIMAL(6,5) NOT NULL DEFAULT 0.3,
              `h`             DECIMAL(6,5) NOT NULL DEFAULT 0.1,
              `body`          VARCHAR(500) DEFAULT NULL,
              `url`           VARCHAR(500) DEFAULT NULL,
              `color`         VARCHAR(9) NOT NULL DEFAULT "#ffffff",
              `background`    VARCHAR(9) DEFAULT NULL,
              `font_size`     DECIMAL(5,4) NOT NULL DEFAULT 0.05,
              `stroke_width`  DECIMAL(5,4) NOT NULL DEFAULT 0.006,
              `intensity`     TINYINT UNSIGNED NOT NULL DEFAULT 12,
              `z_index`       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
              `created_at`    DATETIME NOT NULL,
              PRIMARY KEY (`id`),
              KEY `idx_annotation_video` (`video_id`,`start_time`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        );
    }
}
