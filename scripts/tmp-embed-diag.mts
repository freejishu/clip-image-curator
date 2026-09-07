// 诊断：直接调 embedImage 跑一张"无预测分"的图，看真实报错（不设 HF_HUB_OFFLINE，模拟服务环境）
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('D:/Project/image-curator/data/curator.db', { readOnly: true });
const meta = db.prepare("SELECT json_extract(value,'$.trainedAt') t, json_extract(value,'$.samples') s FROM meta WHERE key='model'").get();
console.log('模型 v28 trainedAt:', meta);
console.log('已下载但无 embedding:', db.prepare('SELECT COUNT(*) c FROM images WHERE local_path IS NOT NULL AND embedding IS NULL').get().c);
const row = db.prepare('SELECT id, local_path FROM images WHERE local_path IS NOT NULL AND pred_version IS NULL LIMIT 1').get();
console.log('样本图:', row);
const fs = await import('node:fs');
console.log('文件存在:', fs.existsSync(row.local_path), '大小:', fs.statSync(row.local_path).size);

const { embedImage } = await import('../src/server/ml/embed.ts');
try {
  const vec = await embedImage(row.local_path);
  console.log('✓ embedding 成功, 维度', vec.length);
} catch (e) {
  console.error('✗ embedImage 失败:', e);
}
