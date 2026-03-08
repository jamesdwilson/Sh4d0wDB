-- Migration 001: Add confidence, decay, timeless, source, and relevance_tier to memories
-- Direction: UP
-- Reversible: YES (see DOWN below)
-- Safe: all columns have defaults — no existing rows break

-- UP
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS confidence             FLOAT       NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS confidence_decay_rate  FLOAT       NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS last_verified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_timeless            BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source                 TEXT,
  ADD COLUMN IF NOT EXISTS source_id              TEXT,
  ADD COLUMN IF NOT EXISTS relevance_tier         SMALLINT    NOT NULL DEFAULT 1;

-- Index for filtering by tier (used in every search to exclude archived records)
CREATE INDEX IF NOT EXISTS idx_memories_relevance_tier
  ON memories(relevance_tier)
  WHERE deleted_at IS NULL;

-- Index for source deduplication (idempotent ingestion keyed on source_id)
CREATE INDEX IF NOT EXISTS idx_memories_source_id
  ON memories(source_id)
  WHERE source_id IS NOT NULL;

-- Apply timeless flag to existing records by category and record_type
UPDATE memories
  SET is_timeless = TRUE,
      confidence_decay_rate = 0.0
  WHERE record_type IN ('rule', 'directive', 'playbook')
     OR category IN ('rules', 'directives', 'system', 'config', 'skills');

-- Apply slow decay to contacts/dossiers (half-life 180 days: ln(2)/180 ≈ 0.003851)
UPDATE memories
  SET confidence_decay_rate = 0.003851
  WHERE record_type IN ('contact', 'dossier', 'person', 'atom')
    AND is_timeless = FALSE;

-- Apply medium decay to general facts/sections (half-life 90 days: ln(2)/90 ≈ 0.007702)
UPDATE memories
  SET confidence_decay_rate = 0.007702
  WHERE record_type IN ('fact', 'section', 'index')
    AND is_timeless = FALSE
    AND confidence_decay_rate = 0.0;

-- DOWN (reverse with: psql shadow -f 001_confidence_decay_down.sql)
-- ALTER TABLE memories
--   DROP COLUMN IF EXISTS confidence,
--   DROP COLUMN IF EXISTS confidence_decay_rate,
--   DROP COLUMN IF EXISTS last_verified_at,
--   DROP COLUMN IF EXISTS is_timeless,
--   DROP COLUMN IF EXISTS source,
--   DROP COLUMN IF EXISTS source_id,
--   DROP COLUMN IF EXISTS relevance_tier;
-- DROP INDEX IF EXISTS idx_memories_relevance_tier;
-- DROP INDEX IF EXISTS idx_memories_source_id;
