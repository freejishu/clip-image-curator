import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** 存储后端接口：LocalFS 首期，WebDAV/OpenList 预留 */
export interface StorageBackend {
  /** 保存抓取的原图，返回本地可读路径（预览/embedding 用） */
  saveIncoming(buf: Buffer, filename: string): Promise<string>;
  /** 归档"喜欢"的图片 */
  archiveFavorite(srcPath: string, filename: string): Promise<void>;
  /** 从收藏移除（修正标签时） */
  removeFavorite(filename: string): Promise<void>;
}

export class LocalFSBackend implements StorageBackend {
  async saveIncoming(buf: Buffer, filename: string): Promise<string> {
    const p = path.join(config.storage.incoming, filename);
    await fs.promises.writeFile(p, buf);
    return p;
  }
  async archiveFavorite(srcPath: string, filename: string): Promise<void> {
    await fs.promises.copyFile(srcPath, path.join(config.storage.favorites, filename));
  }
  async removeFavorite(filename: string): Promise<void> {
    await fs.promises.rm(path.join(config.storage.favorites, filename), { force: true });
  }
}

// 预留：class WebDavBackend implements StorageBackend { ... OpenList WebDAV ... }

export const storage: StorageBackend = new LocalFSBackend();
