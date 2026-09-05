import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/curator.db');
const total = db.prepare('SELECT COUNT(*) c FROM images').get().c;
const noPath = db.prepare('SELECT COUNT(*) c FROM images WHERE local_path IS NULL').get().c;
console.log(`总记录 ${total}，无 local_path ${noPath}`);
// 有 local_path 但文件不在磁盘
const withPath = db.prepare('SELECT id, local_path FROM images WHERE local_path IS NOT NULL').all();
let missing = [], zero = [];
for (const r of withPath) {
  if (!fs.existsSync(r.local_path)) missing.push(r);
  else if (fs.statSync(r.local_path).size === 0) zero.push(r);
}
console.log(`有路径但文件丢失: ${missing.length}，0 字节文件: ${zero.length}`);
// 无路径记录的分布：按任务+标注状态
const dist = db.prepare(`SELECT i.task_id taskId, COUNT(*) c,
  SUM(CASE WHEN i.user_label IS NOT NULL THEN 1 ELSE 0 END) labeled
  FROM images i WHERE i.local_path IS NULL GROUP BY i.task_id ORDER BY i.task_id`).all();
console.log('无路径记录按任务分布:');
for (const d of dist) console.log(`  task#${d.taskId}: ${d.c} 条 (已标注 ${d.labeled})`);
// 磁盘上孤儿文件（incoming 里有文件但 DB 无引用）
const dbFiles = new Set(withPath.map(r => r.local_path));
let orphans = 0;
for (const dir of ['data/incoming']) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (!dbFiles.has(`data\\incoming\\${f}`) && !dbFiles.has(`data/incoming/${f}`)) orphans++;
}
console.log(`incoming 孤儿文件: ${orphans}`);
