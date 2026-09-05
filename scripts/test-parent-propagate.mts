// 只读验证：父子组的喜欢传播解析
import { propagateGroupIds } from '../src/server/groups.js';
import { db } from '../src/server/db.js';

// 找一个父也在库里的父子组
const g = db.prepare(
  `SELECT i.parent_id AS pid FROM images i
   WHERE i.parent_id > 0 AND i.local_path IS NOT NULL
     AND EXISTS (SELECT 1 FROM images p WHERE p.source = i.source AND p.source_id = CAST(i.parent_id AS TEXT))
   LIMIT 1`
).get() as { pid: number } | undefined;
if (!g) { console.log('无父子都在库的组可测'); process.exit(0); }
const child = db.prepare('SELECT id, source_id, parent_id FROM images WHERE parent_id = ? LIMIT 1').get(g.pid) as { id: number; source_id: string; parent_id: number };
const parent = db.prepare('SELECT id, source_id FROM images WHERE source = ? AND source_id = ?').get('yandere', String(g.pid)) as { id: number; source_id: string };
console.log(`父子组: 父 #${parent.id}(${parent.source_id}), 子 #${child.id}(${child.source_id})`);
const fromChild = propagateGroupIds(child.id);
const fromParent = propagateGroupIds(parent.id);
console.log(`从子传播: [${fromChild.join(',')}]  从父传播: [${fromParent.join(',')}]`);
const ok = fromChild.includes(child.id) && fromChild.includes(parent.id) && fromParent.includes(child.id) && fromParent.includes(parent.id);
console.log(ok ? '✅ 父子组双向解析正确' : '❌ 解析错误');
process.exit(ok ? 0 : 1);
