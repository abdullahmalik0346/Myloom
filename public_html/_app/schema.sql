-- MyLoom :: MySQL schema
-- Compatible with MySQL 5.7+ / MariaDB 10.3+ (cPanel default)
-- All tables use InnoDB + utf8mb4.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `users` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(120) NOT NULL,
  `email`           VARCHAR(190) NOT NULL,
  `password_hash`   VARCHAR(255) NOT NULL,
  `avatar`          VARCHAR(255) DEFAULT NULL,
  `is_admin`        TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`       TINYINT(1) NOT NULL DEFAULT 1,
  `email_verified`  TINYINT(1) NOT NULL DEFAULT 0,
  `verify_token`    VARCHAR(64) DEFAULT NULL,
  `timezone`        VARCHAR(64) NOT NULL DEFAULT 'UTC',
  `notify_view`     TINYINT(1) NOT NULL DEFAULT 1,
  `notify_comment`  TINYINT(1) NOT NULL DEFAULT 1,
  `notify_reaction` TINYINT(1) NOT NULL DEFAULT 1,
  `last_login_at`   DATETIME DEFAULT NULL,
  `created_at`      DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workspaces` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(150) NOT NULL,
  `slug`            VARCHAR(80) NOT NULL,
  `owner_id`        INT UNSIGNED NOT NULL,
  `logo`            VARCHAR(255) DEFAULT NULL,
  `accent_color`    VARCHAR(9) NOT NULL DEFAULT '#625df5',
  `hide_branding`   TINYINT(1) NOT NULL DEFAULT 0,
  `default_cta_label` VARCHAR(80) DEFAULT NULL,
  `default_cta_url`   VARCHAR(500) DEFAULT NULL,
  `storage_used`    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ws_slug` (`slug`),
  KEY `idx_ws_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workspace_members` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  INT UNSIGNED NOT NULL,
  `user_id`       INT UNSIGNED NOT NULL,
  `role`          ENUM('owner','admin','member','viewer') NOT NULL DEFAULT 'member',
  `created_at`    DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_member` (`workspace_id`,`user_id`),
  KEY `idx_member_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `invites` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  INT UNSIGNED NOT NULL,
  `email`         VARCHAR(190) NOT NULL,
  `role`          ENUM('admin','member','viewer') NOT NULL DEFAULT 'member',
  `token`         VARCHAR(64) NOT NULL,
  `invited_by`    INT UNSIGNED NOT NULL,
  `expires_at`    DATETIME NOT NULL,
  `accepted_at`   DATETIME DEFAULT NULL,
  `created_at`    DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_invite_token` (`token`),
  KEY `idx_invite_ws` (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `spaces` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `workspace_id`  INT UNSIGNED NOT NULL,
  `parent_id`     INT UNSIGNED DEFAULT NULL,
  `name`          VARCHAR(150) NOT NULL,
  `color`         VARCHAR(9) NOT NULL DEFAULT '#625df5',
  `is_private`    TINYINT(1) NOT NULL DEFAULT 0,
  `created_by`    INT UNSIGNED NOT NULL,
  `created_at`    DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_space_ws` (`workspace_id`),
  KEY `idx_space_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `videos` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uid`           VARCHAR(22) NOT NULL,
  `workspace_id`  INT UNSIGNED NOT NULL,
  `space_id`      INT UNSIGNED DEFAULT NULL,
  `owner_id`      INT UNSIGNED NOT NULL,
  `title`         VARCHAR(255) NOT NULL DEFAULT 'Untitled recording',
  `description`   TEXT,
  `file_path`     VARCHAR(255) DEFAULT NULL,
  `mime`          VARCHAR(80) NOT NULL DEFAULT 'video/webm',
  `size_bytes`    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `duration`      DECIMAL(10,2) NOT NULL DEFAULT 0,
  `width`         INT UNSIGNED NOT NULL DEFAULT 0,
  `height`        INT UNSIGNED NOT NULL DEFAULT 0,
  `thumbnail`     VARCHAR(255) DEFAULT NULL,
  `gif_preview`   VARCHAR(255) DEFAULT NULL,
  `status`        ENUM('recording','processing','ready','failed') NOT NULL DEFAULT 'processing',
  `source`        ENUM('screen','camera','screen_camera','upload') NOT NULL DEFAULT 'screen',
  `visibility`    ENUM('private','workspace','link','public') NOT NULL DEFAULT 'link',
  `password_hash` VARCHAR(255) DEFAULT NULL,
  `expires_at`    DATETIME DEFAULT NULL,
  `allow_comments`  TINYINT(1) NOT NULL DEFAULT 1,
  `allow_reactions` TINYINT(1) NOT NULL DEFAULT 1,
  `allow_download`  TINYINT(1) NOT NULL DEFAULT 1,
  `require_email`   TINYINT(1) NOT NULL DEFAULT 0,
  `trim_start`    DECIMAL(10,2) NOT NULL DEFAULT 0,
  `trim_end`      DECIMAL(10,2) DEFAULT NULL,
  `segments`      TEXT DEFAULT NULL,
  `cta_label`     VARCHAR(80) DEFAULT NULL,
  `cta_url`       VARCHAR(500) DEFAULT NULL,
  `is_starred`    TINYINT(1) NOT NULL DEFAULT 0,
  `view_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `unique_viewers` INT UNSIGNED NOT NULL DEFAULT 0,
  `summary`       TEXT,
  `deleted_at`    DATETIME DEFAULT NULL,
  `created_at`    DATETIME NOT NULL,
  `updated_at`    DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_video_uid` (`uid`),
  KEY `idx_video_ws` (`workspace_id`,`deleted_at`),
  KEY `idx_video_owner` (`owner_id`),
  KEY `idx_video_space` (`space_id`),
  FULLTEXT KEY `ft_video_text` (`title`,`description`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `video_chapters` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`   INT UNSIGNED NOT NULL,
  `start_time` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `title`      VARCHAR(200) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_chapter_video` (`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `transcripts` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`   INT UNSIGNED NOT NULL,
  `lang`       VARCHAR(12) NOT NULL DEFAULT 'en',
  `label`      VARCHAR(60) NOT NULL DEFAULT 'English',
  `segments`   MEDIUMTEXT,
  `plain_text` MEDIUMTEXT,
  `source`     ENUM('browser','api','manual') NOT NULL DEFAULT 'browser',
  `is_default` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tr_video` (`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `comments` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`    INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED DEFAULT NULL,
  `guest_name`  VARCHAR(120) DEFAULT NULL,
  `guest_email` VARCHAR(190) DEFAULT NULL,
  `parent_id`   INT UNSIGNED DEFAULT NULL,
  `body`        TEXT NOT NULL,
  `at_time`     DECIMAL(10,2) DEFAULT NULL,
  `is_resolved` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at`  DATETIME DEFAULT NULL,
  `created_at`  DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_comment_video` (`video_id`,`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reactions` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`   INT UNSIGNED NOT NULL,
  `comment_id` INT UNSIGNED DEFAULT NULL,
  `user_id`    INT UNSIGNED DEFAULT NULL,
  `session_key` VARCHAR(64) DEFAULT NULL,
  `emoji`      VARCHAR(16) NOT NULL,
  `at_time`    DECIMAL(10,2) DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_reaction_video` (`video_id`),
  KEY `idx_reaction_comment` (`comment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `views` (
  `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`     INT UNSIGNED NOT NULL,
  `user_id`      INT UNSIGNED DEFAULT NULL,
  `session_key`  VARCHAR(64) NOT NULL,
  `viewer_name`  VARCHAR(120) DEFAULT NULL,
  `viewer_email` VARCHAR(190) DEFAULT NULL,
  `ip_hash`      VARCHAR(64) DEFAULT NULL,
  `user_agent`   VARCHAR(255) DEFAULT NULL,
  `referrer`     VARCHAR(255) DEFAULT NULL,
  `device`       VARCHAR(20) DEFAULT NULL,
  `watched_sec`  DECIMAL(10,2) NOT NULL DEFAULT 0,
  `percent`      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `completed`    TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`   DATETIME NOT NULL,
  `updated_at`   DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_view_session` (`video_id`,`session_key`),
  KEY `idx_view_video` (`video_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `engagement` (
  `video_id` INT UNSIGNED NOT NULL,
  `bucket`   TINYINT UNSIGNED NOT NULL,
  `plays`    INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`video_id`,`bucket`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `share_links` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `video_id`      INT UNSIGNED NOT NULL,
  `token`         VARCHAR(32) NOT NULL,
  `label`         VARCHAR(120) DEFAULT NULL,
  `password_hash` VARCHAR(255) DEFAULT NULL,
  `expires_at`    DATETIME DEFAULT NULL,
  `max_views`     INT UNSIGNED DEFAULT NULL,
  `view_count`    INT UNSIGNED NOT NULL DEFAULT 0,
  `allow_download` TINYINT(1) NOT NULL DEFAULT 1,
  `revoked`       TINYINT(1) NOT NULL DEFAULT 0,
  `created_by`    INT UNSIGNED NOT NULL,
  `created_at`    DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_share_token` (`token`),
  KEY `idx_share_video` (`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notifications` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED NOT NULL,
  `type`       VARCHAR(40) NOT NULL,
  `video_id`   INT UNSIGNED DEFAULT NULL,
  `actor`      VARCHAR(150) DEFAULT NULL,
  `body`       VARCHAR(500) DEFAULT NULL,
  `read_at`    DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`,`read_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uploads` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `upload_key`  VARCHAR(48) NOT NULL,
  `video_id`    INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED NOT NULL,
  `received`    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `chunks`      INT UNSIGNED NOT NULL DEFAULT 0,
  `finished`    TINYINT(1) NOT NULL DEFAULT 0,
  `temp_path`   VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME NOT NULL,
  `updated_at`  DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_upload_key` (`upload_key`),
  KEY `idx_upload_video` (`video_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `password_resets` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED NOT NULL,
  `token`      VARCHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `used_at`    DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_reset_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `settings` (
  `k` VARCHAR(80) NOT NULL,
  `v` TEXT,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `annotations` (
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
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
