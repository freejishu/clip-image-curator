import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const before = db.prepare('SELECT COUNT(*) c FROM images').get().c;
const r = db.prepare('DELETE FROM images WHERE local_path IS NULL AND user_label IS NULL').run();
const after = db.prepare('SELECT COUNT(*) c FROM images').get().c;
console.log(`删除无文件未标注脏数据: ${r.changes} 条 (${before} -> ${after})`);
