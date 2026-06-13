const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('folder','entry')),
    description TEXT DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK(kind IN ('image','markdown','latex','word','text')),
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    rendered_html TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_node ON attachments(node_id);

  CREATE TABLE IF NOT EXISTS levels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    author      TEXT DEFAULT '',
    description TEXT DEFAULT '',
    data        TEXT NOT NULL,
    width       INTEGER NOT NULL DEFAULT 60,
    height      INTEGER NOT NULL DEFAULT 20,
    plays       INTEGER NOT NULL DEFAULT 0,
    edit_key    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- ── 鎏金枢界 · 新数据库（档案库） ──
  CREATE TABLE IF NOT EXISTS arc_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    category    TEXT DEFAULT '未分类',
    summary     TEXT DEFAULT '',
    content     TEXT DEFAULT '',
    tags        TEXT DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- ── 鎏金枢界 · 论坛（共鸣场） ──
  CREATE TABLE IF NOT EXISTS forum_threads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER REFERENCES arc_entries(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    author      TEXT DEFAULT '旅人',
    content     TEXT DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS forum_posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
    author      TEXT DEFAULT '旅人',
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_threads_entry ON forum_threads(entry_id);
  CREATE INDEX IF NOT EXISTS idx_posts_thread ON forum_posts(thread_id);
`);

module.exports = db;
