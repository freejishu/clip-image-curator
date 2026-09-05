import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const rows = db.prepare('SELECT id, source, source_id, file_url, user_label, created_at FROM images WHERE local_path IS NULL').all();
const labeled = rows.filter(r => r.user_label);
console.log(`无 local_path: ${rows.length} 条，其中已标注 ${labeled.length} 条`);
// 抽样 5 条测 file_url 可达性（走代理）
let ok = 0, fail = 0;
for (const r of rows.slice(0, 5)) {
  try {
    const res = await fetch(r.file_url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    console.log(`  ${r.source_id}: HTTP ${res.status}`);
    if (res.ok) ok++; else fail++;
  } catch (e) { console.log(`  ${r.source_id}: ${e.message.slice(0, 60)}`); fail++; }
}
console.log(`抽样可达性: ${ok} 通 / ${fail} 断（未走代理，仅供参考）`);
