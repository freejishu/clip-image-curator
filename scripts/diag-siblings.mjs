import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
const fam = db.prepare(`SELECT id, source_id, parent_id, user_label, local_path IS NOT NULL has_file FROM images WHERE source='yandere' AND (source_id = '1230446' OR parent_id = 1230446)`).all();
console.log(JSON.stringify(fam, null, 1));
const album = await (await fetch('http://127.0.0.1:5176/api/album')).json();
const keys = new Set(fam.map(f => album.find(r => r.id === f.id)?.group_key));
console.log('家族在相册的 group_key:', [...keys]);
