-- Migration 004: entity_edges table
-- Stores directed edges between entity nodes in the `memories` table.
-- Used by EntityResolver.addEdge() and all Phase 5 graph queries.
--
-- Design decisions:
--   - fromId/toId reference memories.id (entity nodes stored in memories table)
--   - No FK constraints — edges survive entity soft-deletes (merge handles cleanup)
--   - Composite primary key (fromId, toId, type) — one edge per relationship type per pair
--   - confidence stored as REAL (0.0–1.0)
--   - source_id = which ingestion source produced this edge (for provenance)
--   - evidence_text = snippet that supports this edge (for explainability)
--
-- UP

CREATE TABLE IF NOT EXISTS memory_edges (
  from_id         INTEGER      NOT NULL,
  to_id           INTEGER      NOT NULL,
  type            TEXT         NOT NULL,
  confidence      REAL         NOT NULL DEFAULT 0.5,
  source_id       TEXT,
  evidence_text   TEXT,
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges (from_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to   ON memory_edges (to_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_type ON memory_edges (type);

-- DOWN
-- DROP TABLE IF EXISTS memory_edges;
-- DROP INDEX IF EXISTS idx_memory_edges_from;
-- DROP INDEX IF EXISTS idx_memory_edges_to;
-- DROP INDEX IF EXISTS idx_memory_edges_type;
