import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'curator.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_url TEXT,
  file_url TEXT NOT NULL,
  preview_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  width INTEGER, height INTEGER, rating TEXT,
  local_path TEXT,
  embedding BLOB,
  user_label TEXT CHECK(user_label IN ('like','dislike','skip') OR user_label IS NULL),
  pred_score REAL,
  pred_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  labeled_at TEXT,
  UNIQUE(source, source_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  proxy TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  seen INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0,
  target INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS image_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS image_group_members (
  group_id INTEGER NOT NULL,
  image_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY(group_id, image_id)
);
CREATE TABLE IF NOT EXISTS group_covers (
  image_id INTEGER PRIMARY KEY  -- 用户手动指定的组封面（跟随图片，组重洗后不丢）
);
`);

// 老库迁移：补 seen 列（已存在则忽略）
try {
  db.exec('ALTER TABLE images ADD COLUMN parent_id INTEGER');
} catch { /* column already exists */ }
try {
  db.exec('ALTER TABLE tasks ADD COLUMN seen INTEGER NOT NULL DEFAULT 0');
} catch { /* column already exists */ }
try {
  db.exec('ALTER TABLE tasks ADD COLUMN finished_at TEXT');
} catch { /* column already exists */ }
// 兜底（幂等）：任何路径漏写 finished_at 的终态任务，用 updated_at 补上（耗时不再虚增）
db.exec(`UPDATE tasks SET finished_at = updated_at WHERE finished_at IS NULL AND status IN ('done','paused','error')`);

export interface ImageRow {
  id: number; source: string; source_id: string; page_url: string | null;
  file_url: string; preview_url: string | null; tags: string;
  width: number | null; height: number | null; rating: string | null;
  local_path: string | null; embedding: Buffer | null;
  user_label: 'like' | 'dislike' | 'skip' | null;
  parent_id: number | null;
  pred_score: number | null; pred_version: number | null;
  created_at: string; labeled_at: string | null;
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
