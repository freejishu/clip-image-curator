import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const rows = db.prepare("SELECT id, source_id, parent_id, user_label, local_path IS NOT NULL AS hasFile FROM images WHERE source='yandere' AND CAST(source_id AS INTEGER) BETWEEN 1264326 AND 1264340 ORDER BY CAST(source_id AS INTEGER)").all();
for (const r of rows) console.log(JSON.stringify(r));
