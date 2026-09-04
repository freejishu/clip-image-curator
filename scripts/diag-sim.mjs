import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const get = sid => db.prepare("SELECT id, embedding FROM images WHERE source='yandere' AND source_id=?").get(sid);
const pairs = [['1264328','1264331'], ['1264328','1264330'], ['1264331','1264332'], ['1264337','1264338']];
const cos = (a, b) => {
  const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let d = 0, na = 0, nb = 0;
  for (let k = 0; k < va.length; k++) { d += va[k]*vb[k]; na += va[k]**2; nb += vb[k]**2; }
  return d / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
};
for (const [a, b] of pairs) {
  const ra = get(a), rb = get(b);
  console.log(`${a} vs ${b}: emb=${ra?.embedding ? 'Y' : 'N'}/${rb?.embedding ? 'Y' : 'N'} sim=${ra?.embedding && rb?.embedding ? cos(ra.embedding, rb.embedding).toFixed(4) : 'N/A'}`);
}
