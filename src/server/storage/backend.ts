import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { processImage, ruleFor } from '../pipeline/transform.js';

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

/** 存库路径统一为相对 dataDir 的相对路径（项目/数据目录整体搬迁不受影响）；不在 dataDir 下的退回绝对路径 */
export function toStoredPath(absPath: string): string {
  const rel = path.relative(config.dataDir, absPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absPath;
}

/** 读取时还原成本机绝对路径：相对路径基于当前 dataDir 解析；历史绝对路径原样使用 */
export function resolveStoredPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(config.dataDir, p);
}

export class LocalFSBackend implements StorageBackend {
  async saveIncoming(buf: Buffer, filename: string): Promise<string> {
    const p = path.join(config.storage.incoming, filename);
    await fs.promises.writeFile(p, buf);
    return toStoredPath(p);
  }
  async archiveFavorite(srcPath: string, filename: string, subfolder?: string | null): Promise<void> {
    await fs.promises.copyFile(resolveStoredPath(srcPath), path.join(favDir(subfolder), filename));
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

/** 转换+压缩装饰器：任何后端包一层即获得入库前「格式转换 → 压缩」能力（动图不处理），未来 WebDAV/OpenList 直接复用 */
export class TransformingBackend implements StorageBackend {
  constructor(private inner: StorageBackend, private type: string) {}
  async saveIncoming(buf: Buffer, filename: string): Promise<string> {
    const r = await processImage(buf, filename, ruleFor(this.type));
    if (r.steps.length) console.log(`[image-process] ${filename}: ${r.steps.join('；')}`);
    return this.inner.saveIncoming(r.buf, r.filename);
  }
  archiveFavorite(srcPath: string, filename: string, subfolder?: string | null): Promise<void> {
    return this.inner.archiveFavorite(srcPath, filename, subfolder);
  }
  removeFavorite(filename: string, subfolder?: string | null): Promise<void> {
    return this.inner.removeFavorite(filename, subfolder);
  }
}

export const storage: StorageBackend = new TransformingBackend(new LocalFSBackend(), config.storage.type ?? 'local');
