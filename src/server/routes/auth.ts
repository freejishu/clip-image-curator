import type { FastifyInstance } from 'fastify';
import {
  REMEMBER_DAYS, checkLogin, createSession, deleteSession, validateToken,
  extractToken, getUsername, changeUsername, changePassword, verifyPassword,
} from '../auth.js';
import { getMeta } from '../db.js';

// 简单防爆破：同一 IP 连续失败 5 次锁定 60s（内存计数，重启清零，够用）
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

export function authRoutes(app: FastifyInstance) {
  // 登录（豁免鉴权）。remember=true 时前端把 token 存 localStorage（180 天），否则 sessionStorage（浏览器关即失效）
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return reply.code(429).send({ error: '失败次数过多，请 1 分钟后再试' });
    const body = (req.body ?? {}) as { username?: string; password?: string; remember?: boolean };
    if (!body.username || !body.password) return reply.code(400).send({ error: '需要 username 和 password' });
    if (!checkLogin(body.username, body.password)) {
      const cur = fails.get(ip) ?? { n: 0, until: 0 };
      cur.n++;
      if (cur.n >= MAX_FAILS) { cur.until = Date.now() + LOCK_MS; cur.n = 0; }
      fails.set(ip, cur);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    fails.delete(ip);
    const token = createSession(body.username, !!body.remember);
    return { token, username: body.username, remember_days: REMEMBER_DAYS };
  });

  // 登录态查询（豁免鉴权，永远 200）：前端启动时校验本地存的 token 是否仍有效
  app.get('/api/auth/status', async (req) => {
    const username = validateToken(extractToken(req));
    return username ? { authenticated: true, username } : { authenticated: false };
  });

  // 登出：删当前 session
  app.post('/api/auth/logout', async (req) => {
    if (req.authToken) deleteSession(req.authToken);
    return { ok: true };
  });

  // 改用户名（需当前密码确认）；已有 session 保留并同步改名
  app.put('/api/auth/username', async (req, reply) => {
    const body = (req.body ?? {}) as { current_password?: string; username?: string };
    const name = body.username?.trim();
    if (!name) return reply.code(400).send({ error: '需要 username' });
    if (name.length > 64) return reply.code(400).send({ error: '用户名最长 64 字符' });
    const hash = getMeta('auth_password_hash') ?? '';
    if (!body.current_password || !verifyPassword(body.current_password, hash)) {
      return reply.code(403).send({ error: '当前密码错误' });
    }
    if (name === getUsername()) return reply.code(400).send({ error: '与当前用户名相同' });
    changeUsername(name);
    return { ok: true, username: name };
  });

  // 改密码（需当前密码确认）；成功后删除全部 session，所有端强制重新登录
  app.put('/api/auth/password', async (req, reply) => {
    const body = (req.body ?? {}) as { current_password?: string; new_password?: string };
    if (!body.new_password || body.new_password.length < 4) return reply.code(400).send({ error: '新密码至少 4 位' });
    if (body.new_password.length > 128) return reply.code(400).send({ error: '新密码最长 128 位' });
    const hash = getMeta('auth_password_hash') ?? '';
    if (!body.current_password || !verifyPassword(body.current_password, hash)) {
      return reply.code(403).send({ error: '当前密码错误' });
    }
    changePassword(body.new_password);
    return { ok: true, relogin: true };
  });
}
