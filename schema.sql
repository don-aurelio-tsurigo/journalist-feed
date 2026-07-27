-- Anlegen mit:
--   npx wrangler d1 execute tsri-news-feed-db --file=./schema.sql --remote
-- (--remote für die echte D1-Instanz, ohne --remote nur lokal für die Dev-DB)

CREATE TABLE IF NOT EXISTS news_items (
  id            TEXT PRIMARY KEY,   -- source-key + '::' + guid/link
  source        TEXT NOT NULL,      -- z.B. 'stadt-zuerich-medienmitteilungen'
  source_label  TEXT NOT NULL,      -- Anzeigename, z.B. 'Stadt Zürich – Medienmitteilungen'
  title         TEXT NOT NULL,
  link          TEXT NOT NULL,
  summary       TEXT,
  published_at  TEXT,               -- ISO-8601, kann NULL sein wenn Quelle kein Datum liefert
  fetched_at    TEXT NOT NULL,      -- ISO-8601, wann wir es reingezogen haben
  status        TEXT NOT NULL DEFAULT 'neu'  -- neu | interessant | beobachten | verworfen
);

CREATE INDEX IF NOT EXISTS idx_news_items_status ON news_items(status);
CREATE INDEX IF NOT EXISTS idx_news_items_source ON news_items(source);
CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items(published_at DESC);
