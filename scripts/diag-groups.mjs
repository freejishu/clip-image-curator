import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const liked = db.prepare("SELECT id, source_id, parent_id, created_at FROM images WHERE user_label='like' AND local_path IS NOT NULL AND source='yandere'").all();
const keyOf = r => r.parent_id > 0 ? r.parent_id : Number(r.source_id);
const groups = new Map();
for (const r of liked) {
  const k = keyOf(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
// 1) 同一 source_id 是否重复行
const dup = db.prepare("SELECT source, source_id, COUNT(*) c FROM images GROUP BY source, source_id HAVING c > 1").all();
console.log('重复 source_id 行:', JSON.stringify(dup));
// 2) 组间重叠：某组的成员 parent_id 指向另一组的 key（链式）
const keys = new Set(groups.keys());
for (const [k, items] of groups) {
  for (const it of items) {
    if (it.parent_id > 0 && it.parent_id !== k && keys.has(it.parent_id)) {
      console.log(`链式分裂: 组 ${k} 的成员 ${it.source_id} 的 parent_id=${it.parent_id} 本身是另一个组的 key`);
    }
  }
}
// 3) 多图组清单（含成员）
for (const [k, items] of groups) {
  if (items.length > 1) console.log(`组 ${k}: [${items.map(i => `${i.source_id}${i.parent_id > 0 ? '(child)' : '(PARENT?)'}`).join(', ')}]`);
}
