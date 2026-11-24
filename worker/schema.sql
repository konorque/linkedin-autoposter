-- Очередь постов
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  lang TEXT NOT NULL,            -- uk / ru / en
  seq INTEGER NOT NULL,          -- 1 / 2 / 3: порядок публикации
  text TEXT NOT NULL,
  status TEXT NOT NULL,          -- draft / approved / published / skipped
  source_url TEXT,
  linkedin_post_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  published_day TEXT             -- дата публикации по Киеву, YYYY-MM-DD
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts (topic_id);

-- Настройки и состояние: токен LinkedIn, флаги, отметки времени
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
