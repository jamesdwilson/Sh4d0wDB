-- ShadowDB SQLite schema
-- Baseline schema for startup identity + memories FTS5 search.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS startup (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  reinforce INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content TEXT NOT NULL,
  content_pyramid TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  record_type TEXT NOT NULL DEFAULT 'fact',
  summary TEXT,
  source_file TEXT,
  tags TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  contradicted INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS memories_superseded_idx ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS memories_contradicted_idx ON memories(contradicted);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  summary,
  content,
  content='memories',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, summary, content)
  VALUES('delete', old.id, old.title, old.summary, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, summary, content)
  VALUES('delete', old.id, old.title, old.summary, old.content);
  INSERT INTO memories_fts(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;
