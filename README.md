# image-curator

图片「爬取 → 人工打分 → 自动学习筛选」流水线。设计文档见 [docs/PRD.md](docs/PRD.md)。

## 快速开始

```powershell
# 日常使用：双击 启动.bat 即可
# 或手动：
npm install
Copy-Item config.example.json config.json   # 按需修改代理等
npm run dev        # 后端 API http://127.0.0.1:5176
npm run dev:web    # 前端开发界面 http://localhost:5175（代理 /api）
# 或生产模式：npm run build:web 后只跑 npm run dev，直接访问 5176
```

## 使用流程

1. **抓取任务**页：选数据源（yandere / mock），填 tags（如 `white_thighhighs rating:s`）和数量，开始抓取
2. **打分**页：键盘 `1` 喜欢 / `2` 不喜欢 / `3` 跳过；喜欢的图自动归档到 `data/favorites/`
3. **模型与偏好**页：先点「Zero-shot 冷启动粗筛」（可选），标注 ≥10 条后点「训练模型」；训练后打分页可按预测分智能排序
4. **审查修正**页：检查模型预测喜欢的图，点 ♥/✕ 修正，修正自动进入下次训练

## 架构

- `src/server/sources/` — 数据源插件（实现 `SourcePlugin` 接口即可新增站点，核心零改动）
- `src/server/pipeline/crawler.ts` — 抓取流水线（去重、限速、暂停/恢复）
- `src/server/ml/` — CLIP embedding（transformers.js）+ 逻辑回归个人分类器 + zero-shot 冷启动
- `src/server/storage/` — 存储后端接口（LocalFS 首期，WebDAV/OpenList 预留）
- `web/` — Vue 3 打分界面
- 数据：SQLite（node:sqlite，零原生依赖）@ `data/curator.db`；图片 @ `data/incoming`、`data/favorites`

## 备注

- 首次使用 CLIP 功能会自动从 hf-mirror.com 下载约 350MB 模型到 `data/models/`
- yande.re 在中国大陆需代理，默认读 `config.json` 的 `proxy`
