import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** 存储后端接口：LocalFS 首期，WebDAV/OpenList 预留 */
export interface StorageBackend {
  saveIncoming(buf: Buffer, filename: string): Promise<string>;
  archiveFavorite(srcPath: string, filename: string, subfolder?: string | null): Promise<void>;
  removeFavorite(filename: string, subfolder?: string | null): Promise<void>;
}

function favDir(subfolder?: string | null): string {
  const dir = subfolder ? path.join(config.storage.favorites, subfolder) : config.storage.favorites;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export class LocalFSBackend implements StorageBackend {
  async saveIncoming(buf: Buffer, filename: string): Promise<string> {
    const p = path.join(config.storage.incoming, filename);
    await fs.promises.writeFile(p, buf);
    return p;
  }
  async archiveFavorite(srcPath: string, filename: string, subfolder?: string | null): Promise<void> {
    await fs.promises.copyFile(srcPath, path.join(favDir(subfolder), filename));
  }
  async removeFavorite(filename: string, subfolder?: string | null): Promise<void> {
    await fs.promises.rm(path.join(favDir(subfolder), filename), { force: true });
    // 兼容：也尝试从根目录删（规则变更前的旧文件）
    if (subfolder) await fs.promises.rm(path.join(config.storage.favorites, filename), { force: true });
  }
}

/** 按归档规则（tag 匹配，取第一条命中）计算子目录；无命中归档到根目录 */
export function resolveArchiveFolder(tagsJson: string): string | null {
  let tags: string[];
  try { tags = JSON.parse(tagsJson); } catch { return null; }
  const set = new Set(tags);
  for (const rule of config.archiveRules ?? []) {
    if (rule.tags.some(t => set.has(t))) return rule.folder;
  }
  return null;
}

// 预留：class WebDavBackend implements StorageBackend { ... OpenList WebDAV ... }

export const storage: StorageBackend = new LocalFSBackend();
