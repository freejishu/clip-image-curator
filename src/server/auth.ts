import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { db, getMeta, setMeta } from './db.js';

/**
 * 账户与登录态（Bearer token 方案，无 Cookie——跨服务器登录时 Cookie 被 SameSite 挡死）。
 * - 凭据存 meta 表（auth_username / auth_password_hash），不进 config.json（该文件在 git 里）
 * - token 明文只给客户端一次，DB 里存 sha256；前端 sessionStorage（浏览器关即失效）或 localStorage（记住我 180 天）
 * - 服务端校验：Authorization: Bearer <token> 或 ?token=<token>（<img> 标签带不了请求头，图片走 query）
 */

declare module 'fastify' {
  interface FastifyRequest { authUser?: string; authToken?: string }
}

export const REMEMBER_DAYS = 180;

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  remember INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored);
  if (!m) return false;
  const calc = crypto.scryptSync(pw, m[1], 32);
  const expect = Buffer.from(m[2], 'hex');
  return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
}

/** 首次启动播种默认账户 admin/admin（reset-password 后下次启动也会重播种） */
export function ensureAuthSeed(): void {
  if (!getMeta('auth_username') || !getMeta('auth_password_hash')) {
    setMeta('auth_username', 'admin');
    setMeta('auth_password_hash', hashPassword('admin'));
    console.log('已初始化默认账户 admin/admin，请登录后尽快在「设置 → 基础设置 → 账户」修改密码');
  }
}

const tokenHash = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(username: string, remember: boolean): string {
  const token = crypto.randomBytes(32).toString('base64url');
  // 过期时间一律 180 天（仅用于服务端兜底与清表）；「浏览器关失效」由前端 sessionStorage 实现
  db.prepare(`INSERT INTO sessions(username, token_hash, remember, expires_at) VALUES(?,?,?, datetime('now', '+${REMEMBER_DAYS} days'))`)
    .run(username, tokenHash(token), remember ? 1 : 0);
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run(); // 顺手清过期
  return token;
}

export function validateToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const row = db.prepare(`SELECT username FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`)
    .get(tokenHash(token)) as { username: string } | undefined;
  return row?.username ?? null;
}

/** 从请求里取 token：优先 Authorization 头，回落 ?token= query（img 标签用） */
export function extractToken(req: FastifyRequest): string {
  const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return bearer ?? (typeof q === 'string' ? q : '') ?? '';
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function deleteUserSessions(username: string): void {
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

export function getUsername(): string {
  return getMeta('auth_username') ?? 'admin';
}

export function checkLogin(username: string, password: string): boolean {
  const u = getMeta('auth_username');
  const h = getMeta('auth_password_hash');
  if (!u || !h) return false;
  return username === u && verifyPassword(password, h);
}

export function changeUsername(newName: string): void {
  const old = getUsername();
  setMeta('auth_username', newName);
  db.prepare('UPDATE sessions SET username = ? WHERE username = ?').run(newName, old);
}

/** 改密码：更新哈希并删除该用户全部 session（强制重新登录，含当前会话） */
export function changePassword(newPw: string): void {
  setMeta('auth_password_hash', hashPassword(newPw));
  deleteUserSessions(getUsername());
}

/** CLI 强制重置：清凭据 + 清全部登录态。下次启动 ensureAuthSeed 重播种 admin/admin */
export function resetAuth(): void {
  db.prepare(`DELETE FROM meta WHERE key IN ('auth_username','auth_password_hash')`).run();
  db.prepare('DELETE FROM sessions').run();
}
