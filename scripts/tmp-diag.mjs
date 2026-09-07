import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/Project/image-curator/data/curator.db', { readOnly: true });
const mv = db.prepare("SELECT value FROM meta WHERE key='model_version'").get();
const model = db.prepare("SELECT length(value) len, substr(value,1,120) head FROM meta WHERE key='model'").get();
console.log('model_version:', mv, '\nmodel meta:', model);
console.log('pred_version 分布:', JSON.stringify(db.prepare('SELECT pred_version, COUNT(*) c FROM images GROUP BY pred_version').all()));
console.log('未标注且已下载:', db.prepare('SELECT COUNT(*) c FROM images WHERE user_label IS NULL AND local_path IS NOT NULL').get().c);
console.log('like/dislike 数:', db.prepare("SELECT user_label, COUNT(*) c FROM images WHERE user_label IN ('like','dislike') GROUP BY user_label").all());
