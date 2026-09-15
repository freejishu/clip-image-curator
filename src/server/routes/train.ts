import type { FastifyInstance } from 'fastify';
import { train, loadModel, tagPreferences, exportModel, importModel } from '../ml/classifier.js';
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

  // 模型迁移：导出为 JSON 文件 / 导入覆盖（设置页「模型与偏好」）
  app.get('/api/model/export', async (_req, reply) => {
    const data = exportModel();
    if (!data) return reply.code(409).send({ error: '尚未训练模型' });
    reply.header('Content-Disposition', `attachment; filename="model-v${data.model.version}.json"`);
    return data;
  });

  app.post('/api/model/import', async (req, reply) => {
    try {
      const r = importModel(req.body);
      return { ok: true, ...r };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
