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
    public const VERSION = 3;

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
            Config::putSetting('schema_version', (string)self::VERSION);
        } catch (Throwable $e) {
            // A failed migration must not take the whole app down; log and carry
            // on so the rest of the site still works.
            error_log('[myloom][migrate] ' . $e->getMessage());
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
