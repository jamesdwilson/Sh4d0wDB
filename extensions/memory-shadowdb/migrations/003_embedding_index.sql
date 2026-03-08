-- Migration 003: Add embedding_index vector(1536) for HNSW indexing
-- The full embedding vector(2560) is kept for reranking accuracy.
-- embedding_index is an MRL-truncated + L2-normalized slice of the first 1536 dims.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_index vector(1536);

-- Populate from existing embeddings (truncate first 1536 dims, normalize)
-- Use subvector to slice, then normalize via scalar division
DO $$
BEGIN
  -- Update each row: slice first 1536 dims and L2-normalize
  UPDATE memories m
  SET embedding_index = (
    SELECT (
      SELECT array_agg(v / norm)::_float8
      FROM (
        SELECT v, sqrt(sum(v*v) OVER ()) AS norm
        FROM unnest(subvector(m.embedding, 1, 1536)::float8[]) WITH ORDINALITY AS t(v, i)
      ) sub
    )::vector(1536)
  )
  WHERE embedding IS NOT NULL;
END $$;

-- Build HNSW index on the 1536d column
CREATE INDEX IF NOT EXISTS idx_memories_embedding_index_hnsw
  ON memories
  USING hnsw (embedding_index vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
