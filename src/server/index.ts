import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { taskRoutes } from './routes/tasks.js';
import { imageRoutes } from './routes/images.js';
import { trainRoutes } from './routes/train.js';

const app = Fastify({ logger: true });

taskRoutes(app);
imageRoutes(app);
trainRoutes(app);

// 生产模式：托管前端构建产物
const webDist = path.resolve(process.cwd(), 'web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`image-curator 已启动: http://127.0.0.1:${config.port}`);
