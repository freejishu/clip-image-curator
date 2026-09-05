import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
// 找未标注子图，其父/兄弟也在库且已下载
const rows = db.prepare(`
  SELECT i.id, i.source_id, i.parent_id, i.user_label FROM images i
  WHERE i.parent_id > 0 AND i.local_path IS NOT NULL
  LIMIT 50`).all();
console.log('有 parent_id 的已下载图:', rows.length);
for (const r of rows.slice(0, 10)) console.log(`  #${r.id} (${r.source_id}) parent=${r.parent_id} label=${r.user_label}`);
// 未标注的组场景统计
const grp = db.prepare(`
  SELECT COUNT(*) c FROM images i
  WHERE i.user_label IS NULL AND i.local_path IS NOT NULL AND i.parent_id > 0
    AND EXISTS (SELECT 1 FROM images s WHERE s.parent_id = i.parent_id AND s.id != i.id AND s.local_path IS NOT NULL)
`).get();
console.log('未标注且同组≥2张的子图:', grp.c);
