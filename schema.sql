-- ShadowDB PostgreSQL schema
-- Memory plugin for OpenClaw — semantic search + FTS + trigram hybrid retrieval.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Primer table — core identity/rules injected before agent runs
CREATE TABLE IF NOT EXISTS primer (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  always BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Main memories table — the knowledge base
CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  title TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  record_type TEXT NOT NULL DEFAULT 'fact',
  tags TEXT[] NOT NULL DEFAULT '{}',
  embedding VECTOR(768),
  fts TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  CHECK (embedding IS NULL OR vector_dims(embedding) = 768)
);

-- Indexes
CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS memories_deleted_at_idx ON memories(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING GIN (fts);
CREATE INDEX IF NOT EXISTS memories_content_trgm_idx ON memories USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING GIN (tags);
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx
  ON memories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION shadowdb_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS primer_set_updated_at ON primer;
CREATE TRIGGER primer_set_updated_at
BEFORE UPDATE ON primer
FOR EACH ROW
EXECUTE FUNCTION shadowdb_set_updated_at();

DROP TRIGGER IF EXISTS memories_set_updated_at ON memories;
CREATE TRIGGER memories_set_updated_at
BEFORE UPDATE ON memories
FOR EACH ROW
EXECUTE FUNCTION shadowdb_set_updated_at();
