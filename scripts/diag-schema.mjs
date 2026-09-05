import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/curator.db');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='images'").get().sql);
