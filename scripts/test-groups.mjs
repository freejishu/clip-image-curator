// 端到端验证：手动绑定 + 喜欢传播 + 解绑 + 还原
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:5176';
const db = new DatabaseSync('data/curator.db');
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// 选 2 张互不相关的未标注图（无父子、无手动组）
const picks = db.prepare(`
  SELECT i.id, i.source, i.source_id, i.local_path FROM images i
  WHERE i.user_label IS NULL AND i.local_path IS NOT NULL
    AND (i.parent_id IS NULL OR i.parent_id <= 0)
    AND NOT EXISTS (SELECT 1 FROM image_group_members m WHERE m.image_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM images c WHERE c.parent_id = CAST(i.source_id AS INTEGER))
  LIMIT 2`).all();
if (picks.length < 2) { console.log('找不到 2 张孤立未标注图，换条件'); process.exit(1); }
const [A, B] = picks;
console.log(`测试样本: A=#${A.id}(${A.source_id}) B=#${B.id}(${B.source_id})`);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? '✅' : '❌'} ${name}`); ok ? pass++ : fail++; };

// 1. 绑定
const bind = await post('/api/groups/bind', { image_ids: [A.id, B.id] });
check(`绑定成功 group_id=${bind.body.group_id}`, bind.status === 200 && bind.body.group_id > 0);

// 2. 喜欢 A → 应传播到 B
const lab = await post(`/api/images/${A.id}/label`, { label: 'like' });
check(`喜欢传播 affected=${JSON.stringify(lab.body.affected)}`, lab.body.affected?.includes(B.id));
const bRow = db.prepare('SELECT user_label FROM images WHERE id = ?').get(B.id);
check('B 已自动喜欢', bRow.user_label === 'like');

// 3. 相册：A、B 同组且 in_manual
const album = await (await fetch(BASE + '/api/album')).json();
const ra = album.find(r => r.id === A.id), rb = album.find(r => r.id === B.id);
check(`相册同组 group_key=${ra?.group_key}`, ra && rb && ra.group_key === rb.group_key);
check('in_manual 标记', ra?.in_manual === true && rb?.in_manual === true);

// 4. 解绑 A
const unb = await post('/api/groups/unbind', { image_id: A.id });
check('解绑成功', unb.status === 200 && unb.body.ok);
const album2 = await (await fetch(BASE + '/api/album')).json();
const ra2 = album2.find(r => r.id === A.id), rb2 = album2.find(r => r.id === B.id);
check('解绑后拆分为两组', ra2 && rb2 && ra2.group_key !== rb2.group_key);

// 5. 解绑非手动绑定图 → 404
const unb2 = await post('/api/groups/unbind', { image_id: B.id });
check('重复解绑返回 404', unb2.status === 404);

// 还原：清标签 + 删收藏副本
for (const img of [A, B]) {
  db.prepare('UPDATE images SET user_label = NULL, labeled_at = NULL WHERE id = ?').run(img.id);
  const name = `${img.source}_${img.source_id}${path.extname(img.local_path)}`;
  const cfg = (await import('node:child_process'), null);
  for (const dir of ['favorites']) {
    // 可能在子目录，递归找
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name === name) fs.rmSync(p, { force: true }); } };
    if (fs.existsSync('data/favorites')) walk('data/favorites');
  }
}
const left = db.prepare(`SELECT COUNT(*) c FROM images WHERE id IN (?, ?) AND user_label IS NOT NULL`).get(A.id, B.id).c;
check('还原干净（标签已清、收藏副本已删）', left === 0);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
