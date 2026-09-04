import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const prog = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) unknown, SUM(CASE WHEN parent_id > 0 THEN 1 ELSE 0 END) hasParent, SUM(CASE WHEN parent_id = -1 THEN 1 ELSE 0 END) noParent FROM images WHERE source='yandere'").get();
console.log('回填进度:', JSON.stringify(prog));
// 喜欢图中的变体组（前端分组逻辑：key = parent_id>0 ? parent_id : source_id）
const liked = db.prepare("SELECT source_id, parent_id FROM images WHERE user_label='like' AND local_path IS NOT NULL AND source='yandere'").all();
const map = new Map();
for (const r of liked) {
  const key = r.parent_id > 0 ? r.parent_id : Number(r.source_id);
  map.set(key, (map.get(key) ?? 0) + 1);
}
const multi = [...map.entries()].filter(([, c]) => c > 1);
console.log(`喜欢图 ${liked.length} 张，组 ${map.size} 个，多图组 ${multi.length} 个:`, JSON.stringify(multi.slice(0, 10)));
