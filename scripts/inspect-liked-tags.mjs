// 统计「喜欢」图片中最常出现的 tag（诊断用）：node scripts/inspect-liked-tags.mjs [关键词正则]
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const rows = db.prepare("SELECT tags FROM images WHERE user_label = 'like'").all();
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const freq = new Map();
for (const r of rows) {
  for (const t of JSON.parse(r.tags)) {
    if (!filter || filter.test(t)) freq.set(t, (freq.get(t) || 0) + 1);
  }
}
console.log('喜欢图相关 tag 分布:');
console.log([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, c]) => `  ${t}: ${c}`).join('\n') || '  (无匹配)');
