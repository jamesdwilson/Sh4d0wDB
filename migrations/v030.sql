-- ShadowDB v0.3.0 migration — Multi-Resolution Memory + Structured Metadata
-- Idempotent — safe to run multiple times.
-- Backward compatible — all existing records unchanged.

-- Structured metadata (JSONB) — queryable key-value pairs
ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Parent linking — document -> section -> atom hierarchy
ALTER TABLE memories ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES memories(id) ON DELETE SET NULL;

-- Priority — retrieval ranking weight (1-10, default 5)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;

-- Indexes
CREATE INDEX IF NOT EXISTS memories_metadata_idx ON memories USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS memories_parent_id_idx ON memories(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_priority_idx ON memories(priority);
