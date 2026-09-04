import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const rows = db.prepare("SELECT tags FROM images WHERE user_label = 'like'").all();
const freq = new Map();
for (const r of rows) {
  for (const t of JSON.parse(r.tags)) {
    if (/pantyhose|thighhigh|stocking|legwear|tights|socks/i.test(t)) freq.set(t, (freq.get(t) || 0) + 1);
  }
}
console.log('喜欢图相关 tag 分布:');
console.log([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, c]) => `  ${t}: ${c}`).join('\n') || '  (无匹配)');
