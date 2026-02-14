-- ShadowDB MySQL / MariaDB schema
-- Baseline schema for startup identity + memories FULLTEXT search.

CREATE TABLE IF NOT EXISTS startup (
  `key` VARCHAR(128) PRIMARY KEY,
  content LONGTEXT NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  reinforce TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title TEXT,
  content LONGTEXT NOT NULL,
  content_pyramid MEDIUMTEXT,
  category VARCHAR(128) NOT NULL DEFAULT 'general',
  record_type VARCHAR(64) NOT NULL DEFAULT 'fact',
  summary TEXT,
  source_file VARCHAR(1024),
  tags JSON NULL,
  metadata JSON NULL,
  embedding LONGBLOB NULL,
  contradicted TINYINT(1) NOT NULL DEFAULT 0,
  superseded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY memories_category_idx (category),
  KEY memories_created_at_idx (created_at),
  KEY memories_superseded_idx (superseded_by),
  KEY memories_contradicted_idx (contradicted),
  FULLTEXT KEY memories_fulltext_idx (title, summary, content, content_pyramid),
  CONSTRAINT memories_superseded_fk
    FOREIGN KEY (superseded_by) REFERENCES memories(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
