import { db } from './db.js';

// ---- 组解析：yande.re 父子组 ∪ 手动绑定组 ----
// parent_id 列存的是父投稿的 source_id（同 source 内）

interface SrcRow { id: number; source_id: string; parent_id: number | null }

const srcCache = new Map<string, { rows: SrcRow[]; at: number }>();
function sourceRows(source: string): SrcRow[] {
  const c = srcCache.get(source);
  if (c && Date.now() - c.at < 30_000) return c.rows;
  const rows = db.prepare('SELECT id, source_id, parent_id FROM images WHERE source = ?').all(source) as unknown as SrcRow[];
  srcCache.set(source, { rows, at: Date.now() });
  return rows;
}
export function invalidateGroupCache(): void { srcCache.clear(); }

/** 某图的 yande.re 父子组成员（DB id 列表，含自身） */
export function parentGroupOf(imageId: number): number[] {
  const row = db.prepare('SELECT id, source, source_id FROM images WHERE id = ?').get(imageId) as
    { id: number; source: string; source_id: string } | undefined;
  if (!row) return [imageId];
  const rows = sourceRows(row.source);
  const parentOf = new Map(rows.map(r => [r.source_id, r.parent_id]));
  const rootOf = (sid: string): string => {
    let cur = sid; const seen = new Set<string>([sid]);
    for (;;) {
      const p = parentOf.get(cur);
      if (p == null || p <= 0) return cur;
      const ps = String(p);
      if (seen.has(ps)) return cur;
      seen.add(ps); cur = ps;
    }
  };
  const root = rootOf(row.source_id);
  return rows.filter(r => rootOf(r.source_id) === root).map(r => r.id);
}

/** 某图的手动绑定组成员（DB id 列表，无绑定返回空） */
export function manualGroupOf(imageId: number): number[] {
  const g = db.prepare('SELECT group_id FROM image_group_members WHERE image_id = ?').get(imageId) as { group_id: number } | undefined;
  if (!g) return [];
  return (db.prepare('SELECT image_id FROM image_group_members WHERE group_id = ?').all(g.group_id) as { image_id: number }[]).map(r => r.image_id);
}

/** 喜欢传播组：父子 ∪ 手动绑定，迭代至不动点（不含 CLIP 近重复，避免误标） */
export function propagateGroupIds(seedId: number): number[] {
  const ids = new Set<number>([seedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...ids]) {
      for (const x of parentGroupOf(id)) if (!ids.has(x)) { ids.add(x); changed = true; }
      for (const x of manualGroupOf(id)) if (!ids.has(x)) { ids.add(x); changed = true; }
    }
  }
  return [...ids];
}

/** 手动绑定：多图并为一组；涉及已有手动组时自动合并。返回组 id */
export function bindImages(imageIds: number[]): number {
  const unique = [...new Set(imageIds)];
  const ph = unique.map(() => '?').join(',');
  const existing = db.prepare(`SELECT DISTINCT group_id FROM image_group_members WHERE image_id IN (${ph})`).all(...unique) as { group_id: number }[];
  let gid: number;
  if (existing.length > 0) {
    gid = existing[0].group_id;
    for (const e of existing.slice(1)) {
      db.prepare('UPDATE image_group_members SET group_id = ? WHERE group_id = ?').run(gid, e.group_id);
      db.prepare('DELETE FROM image_groups WHERE id = ?').run(e.group_id);
    }
  } else {
    gid = Number(db.prepare('INSERT INTO image_groups DEFAULT VALUES').run().lastInsertRowid);
  }
  for (const id of unique) {
    db.prepare('DELETE FROM image_group_members WHERE image_id = ? AND group_id != ?').run(id, gid); // 防御：image_id UNIQUE
    db.prepare('INSERT OR IGNORE INTO image_group_members (group_id, image_id) VALUES (?, ?)').run(gid, id);
  }
  return gid;
}

/** 解绑：仅手动绑定关系可解（父子关系不在此表）。组剩 <2 人时自动销毁 */
export function unbindImage(imageId: number): boolean {
  const r = db.prepare('DELETE FROM image_group_members WHERE image_id = ?').run(imageId);
  // 清理成员数 <2 的组（先删成员再删组，避免悬挂成员）
  db.prepare(`DELETE FROM image_group_members WHERE group_id IN (
    SELECT g.id FROM image_groups g LEFT JOIN image_group_members m ON m.group_id = g.id
    GROUP BY g.id HAVING COUNT(m.image_id) < 2)`).run();
  db.prepare(`DELETE FROM image_groups WHERE id NOT IN (SELECT DISTINCT group_id FROM image_group_members)`).run();
  return Number(r.changes) > 0;
}

/** 相册展示分组：父子 ∪ 手动绑定 ∪ CLIP 近重复(≥0.985)。返回 DB id → 组 key */
export function albumGroupKeys(rows: { id: number; source: string; source_id: string; parent_id: number | null; embedding: Buffer | null }[]): Map<number, string> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r && parent.has(r)) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r && parent.has(c)) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) { if (!parent.has(rb)) parent.set(rb, rb); parent.set(ra, rb); }
  };

  // 父子关系
  const idBySid = new Map(rows.map(r => [`${r.source}:${r.source_id}`, r.id]));
  for (const r of rows) {
    if (r.parent_id != null && r.parent_id > 0) {
      const pid = idBySid.get(`${r.source}:${r.parent_id}`);
      if (pid != null) union(r.id, pid);
    }
  }
  // 手动绑定
  const inAlbum = new Set(rows.map(r => r.id));
  const manual = db.prepare('SELECT group_id, image_id FROM image_group_members').all() as { group_id: number; image_id: number }[];
  const byGid = new Map<number, number[]>();
  for (const m of manual) if (inAlbum.has(m.image_id)) { const a = byGid.get(m.group_id) ?? []; a.push(m.image_id); byGid.set(m.group_id, a); }
  for (const members of byGid.values()) for (let i = 1; i < members.length; i++) union(members[0], members[i]);
  // CLIP 近重复（仅展示层合并）
  const withEmb = rows.filter(r => r.embedding != null) as (typeof rows[number] & { embedding: Buffer })[];
  const vecs = withEmb.map(r => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4));
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < vecs[i].length; k++) { dot += vecs[i][k] * vecs[j][k]; na += vecs[i][k] ** 2; nb += vecs[j][k] ** 2; }
      if (dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9) >= 0.985) union(withEmb[i].id, withEmb[j].id);
    }
  }
  const out = new Map<number, string>();
  for (const r of rows) out.set(r.id, parent.has(r.id) ? `g${find(r.id)}` : `s${r.id}`);
  return out;
}
