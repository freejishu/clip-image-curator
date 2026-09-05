import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
// 找 parent 不在库里的图（补全功能应该能补回来）
const rows = db.prepare(`
  SELECT i.id, i.source_id, i.parent_id, i.user_label FROM images i
  WHERE i.source = 'yandere' AND i.parent_id > 0
    AND NOT EXISTS (SELECT 1 FROM images p WHERE p.source = 'yandere' AND p.source_id = CAST(i.parent_id AS TEXT))
  LIMIT 5`).all();
console.log('父未入库的图:', JSON.stringify(rows));
