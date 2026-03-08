-- Migration 002: Add documents, pattern_events, and ingestion_runs tables
-- Direction: UP
-- Reversible: YES (see DOWN below)
-- Safe: new tables only, no changes to existing tables

-- UP

-- documents: parent record for each ingested external source
CREATE TABLE IF NOT EXISTS documents (
  id              BIGSERIAL       PRIMARY KEY,
  source          TEXT            NOT NULL,           -- 'gmail'|'pdf'|'linkedin'|'notes'
  source_id       TEXT            NOT NULL UNIQUE,    -- gmail thread id, file path hash, etc.
  title           TEXT,
  doc_type        TEXT,                               -- 'email'|'contract'|'message'|'note'
  parties         TEXT[]          NOT NULL DEFAULT '{}',
  date            TIMESTAMPTZ,                        -- document date (not ingestion date)
  ingested_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  last_activity   TIMESTAMPTZ,                        -- last email reply, last file edit, etc.
  interestingness FLOAT,                              -- LLM score 0-1
  chunk_count     INTEGER         NOT NULL DEFAULT 0,
  metadata        JSONB           NOT NULL DEFAULT '{}',
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_documents_source
  ON documents(source);

CREATE INDEX IF NOT EXISTS idx_documents_source_id
  ON documents(source_id);

CREATE INDEX IF NOT EXISTS idx_documents_date
  ON documents(date DESC NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_parties
  ON documents USING GIN(parties);

CREATE INDEX IF NOT EXISTS idx_documents_metadata
  ON documents USING GIN(metadata jsonb_path_ops);

-- pattern_events: detected cross-document intelligence patterns
CREATE TABLE IF NOT EXISTS pattern_events (
  id              BIGSERIAL       PRIMARY KEY,
  pattern_type    TEXT            NOT NULL,   -- 'contradiction'|'relationship_graph'|'temporal_drift'|'recurring_term'|'stale_contact'
  confidence      FLOAT           NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  summary         TEXT            NOT NULL,   -- one-line human-readable description
  detail          TEXT,                       -- full explanation with evidence
  record_ids      INTEGER[]       NOT NULL DEFAULT '{}',  -- memories.id references
  document_ids    BIGINT[]        NOT NULL DEFAULT '{}',  -- documents.id references
  detected_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  surfaced_at     TIMESTAMPTZ,                -- when James was notified
  resolved_at     TIMESTAMPTZ,               -- when James dismissed/resolved
  metadata        JSONB           NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pattern_events_type
  ON pattern_events(pattern_type);

CREATE INDEX IF NOT EXISTS idx_pattern_events_detected
  ON pattern_events(detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_events_unresolved
  ON pattern_events(detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pattern_events_confidence
  ON pattern_events(confidence DESC)
  WHERE resolved_at IS NULL;

-- ingestion_runs: audit log for every ingestion job
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id              BIGSERIAL       PRIMARY KEY,
  source          TEXT            NOT NULL,   -- 'gmail'|'pdf'|'linkedin'|'notes'
  started_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  status          TEXT            NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed','cancelled')),
  records_seen    INTEGER         NOT NULL DEFAULT 0,
  records_kept    INTEGER         NOT NULL DEFAULT 0,   -- passed interestingness filter
  records_new     INTEGER         NOT NULL DEFAULT 0,   -- new (not already in DB)
  error           TEXT,
  metadata        JSONB           NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source
  ON ingestion_runs(source, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status
  ON ingestion_runs(status)
  WHERE status = 'running';

-- DOWN
-- DROP TABLE IF EXISTS ingestion_runs;
-- DROP TABLE IF EXISTS pattern_events;
-- DROP TABLE IF EXISTS documents;
