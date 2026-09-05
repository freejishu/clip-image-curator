import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const g = db.prepare(`SELECT i.parent_id pid, i.source FROM images i WHERE i.parent_id > 0 AND i.local_path IS NOT NULL AND EXISTS(SELECT 1 FROM images p WHERE p.source = i.source AND p.source_id = CAST(i.parent_id AS TEXT)) LIMIT 1`).get();
console.log('g =', JSON.stringify(g));
if (g) {
  const p = db.prepare('SELECT id, source, source_id FROM images WHERE source = ? AND source_id = ?').get(g.source, String(g.pid));
  console.log('parent =', JSON.stringify(p));
  const c = db.prepare('SELECT id, source_id FROM images WHERE source = ? AND parent_id = ?').all(g.source, g.pid);
  console.log('children =', JSON.stringify(c));
}
