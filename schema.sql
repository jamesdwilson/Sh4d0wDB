-- ShadowDB PostgreSQL schema
-- Baseline schema for startup identity + memories hybrid search.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS startup (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  reinforce BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  content_pyramid TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  record_type TEXT NOT NULL DEFAULT 'fact',
  summary TEXT,
  source_file TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding VECTOR(768),
  fts TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(content_pyramid, '') || ' ' ||
      coalesce(content, '')
    )
  ) STORED,
  contradicted BOOLEAN NOT NULL DEFAULT FALSE,
  superseded_by BIGINT REFERENCES memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (embedding IS NULL OR vector_dims(embedding) = 768)
);

CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS memories_superseded_idx ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS memories_contradicted_idx ON memories(contradicted);

CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING GIN (fts);
CREATE INDEX IF NOT EXISTS memories_content_trgm_idx ON memories USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx
  ON memories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION shadowdb_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS startup_set_updated_at ON startup;
CREATE TRIGGER startup_set_updated_at
BEFORE UPDATE ON startup
FOR EACH ROW
EXECUTE FUNCTION shadowdb_set_updated_at();

DROP TRIGGER IF EXISTS memories_set_updated_at ON memories;
CREATE TRIGGER memories_set_updated_at
BEFORE UPDATE ON memories
FOR EACH ROW
EXECUTE FUNCTION shadowdb_set_updated_at();
