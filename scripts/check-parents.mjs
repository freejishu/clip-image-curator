import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const r = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) unknown, SUM(CASE WHEN parent_id > 0 THEN 1 ELSE 0 END) hasParent FROM images WHERE source='yandere'").get();
console.log(JSON.stringify(r));
const groups = db.prepare("SELECT parent_id, COUNT(*) c FROM images WHERE parent_id > 0 GROUP BY parent_id HAVING c > 0 LIMIT 5").all();
console.log('变体组示例:', JSON.stringify(groups));
