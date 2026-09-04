import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/curator.db');
const rows = db.prepare("SELECT id, local_path FROM images WHERE source = 'mock'").all();
for (const r of rows) {
  if (r.local_path && fs.existsSync(r.local_path)) fs.rmSync(r.local_path, { force: true });
  for (const p of [`data/thumbs/${r.id}.jpg`]) if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}
db.prepare("DELETE FROM images WHERE source = 'mock'").run();
db.prepare("DELETE FROM tasks WHERE source = 'mock'").run();
console.log(`已清理 mock: ${rows.length} 张`);
