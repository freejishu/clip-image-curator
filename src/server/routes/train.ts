import type { FastifyInstance } from 'fastify';
import { train, loadModel, tagPreferences } from '../ml/classifier.js';
import { zeroshotScoreAll } from '../ml/zeroshot.js';

let trainState: { status: 'idle' | 'running' | 'done' | 'error'; progress: string; result?: unknown; error?: string } =
  { status: 'idle', progress: '' };

export function trainRoutes(app: FastifyInstance) {
  app.post('/api/train', async (_req, reply) => {
    if (trainState.status === 'running') return reply.code(409).send({ error: '训练进行中', ...trainState });
    trainState = { status: 'running', progress: 'starting' };
    void train(msg => (trainState.progress = msg))
      .then(result => (trainState = { status: 'done', progress: '', result }))
      .catch(err => (trainState = { status: 'error', progress: '', error: err instanceof Error ? err.message : String(err) }));
    return { ok: true };
  });

  app.get('/api/train/status', async () => trainState);

  // 冷启动 zero-shot 粗筛
  app.post('/api/zeroshot', async (_req, reply) => {
    if (trainState.status === 'running') return reply.code(409).send({ error: '任务进行中' });
    trainState = { status: 'running', progress: 'zeroshot starting' };
    void zeroshotScoreAll(200, msg => (trainState.progress = msg))
      .then(n => (trainState = { status: 'done', progress: '', result: { scored: n } }))
      .catch(err => (trainState = { status: 'error', progress: '', error: err instanceof Error ? err.message : String(err) }));
    return { ok: true };
  });

  app.get('/api/preferences', async (req) => {
    const model = loadModel();
    if (!model) return { trained: false };
    const top = Number((req.query as { top?: string }).top ?? 20);
    return { trained: true, version: model.version, samples: model.samples, trainedAt: model.trainedAt, ...tagPreferences(model, top) };
  });
}
