/**
 * 内置 API 文档数据（设置页「API → 接口文档」渲染源）。
 * ⚠️ 新增/修改路由时必须同步更新本文件 —— 这是人工维护的文档，不是自动生成的。
 * 最后同步：feat/auth（41 个接口）
 */

export interface ApiDocParam {
  name: string;
  in: 'path' | 'query' | 'body';
  type: string;
  required?: boolean;
  desc: string;
}

export interface ApiDocEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  desc: string;
  params?: ApiDocParam[];
  /** 返回示例（JSON 文本） */
  response?: string;
  /** 补充说明 / 错误码 */
  notes?: string;
}

export interface ApiDocGroup {
  name: string;
  desc?: string;
  endpoints: ApiDocEndpoint[];
}

export const apiDocs: ApiDocGroup[] = [
  {
    name: '账户与鉴权',
    desc: '除本组 login/status 及「外置接口」组标注公开的接口外，所有 /api/* 都需要鉴权：请求头 Authorization: Bearer <token>；图片等无法带请求头的场景可用 ?token=<token> query 参数代替。token 由 login 获取，服务端有效期 180 天（前端「记住我」不勾选时浏览器关闭即丢弃）',
    endpoints: [
      {
        method: 'POST', path: '/api/auth/login',
        desc: '登录获取 token（公开，无需鉴权）。同一 IP 连续失败 5 次锁定 1 分钟',
        params: [
          { name: 'username', in: 'body', type: 'string', required: true, desc: '账户名（初始默认 admin）' },
          { name: 'password', in: 'body', type: 'string', required: true, desc: '密码（初始默认 admin）' },
          { name: 'remember', in: 'body', type: 'boolean', desc: '记住我：前端据此把 token 存 localStorage（180 天）；不存 sessionStorage 浏览器关即失效' },
        ],
        response: `{ "token": "…", "username": "admin", "remember_days": 180 }`,
        notes: '401 用户名或密码错误；429 锁定中',
      },
      {
        method: 'GET', path: '/api/auth/status',
        desc: '查询当前 token 是否有效（公开，永远返回 200，前端启动时校验本地 token 用）',
        response: `{ "authenticated": true, "username": "admin" }  或  { "authenticated": false }`,
      },
      {
        method: 'POST', path: '/api/auth/logout',
        desc: '登出：删除当前 token 对应的服务端 session',
        response: `{ "ok": true }`,
      },
      {
        method: 'PUT', path: '/api/auth/username',
        desc: '修改账户名（已有登录态保留并同步改名）',
        params: [
          { name: 'current_password', in: 'body', type: 'string', required: true, desc: '当前密码（确认身份）' },
          { name: 'username', in: 'body', type: 'string', required: true, desc: '新账户名，最长 64 字符' },
        ],
        response: `{ "ok": true, "username": "新名字" }`,
        notes: '403 当前密码错误；400 参数非法或与当前相同',
      },
      {
        method: 'PUT', path: '/api/auth/password',
        desc: '修改密码。成功后删除该账户全部 session（含当前会话），所有端强制重新登录',
        params: [
          { name: 'current_password', in: 'body', type: 'string', required: true, desc: '当前密码（确认身份）' },
          { name: 'new_password', in: 'body', type: 'string', required: true, desc: '新密码，4-128 位' },
        ],
        response: `{ "ok": true, "relogin": true }`,
        notes: '403 当前密码错误；400 新密码长度非法',
      },
    ],
  },
  {
    name: '数据源与任务',
    desc: '抓取任务的创建、查看与生命周期控制',
    endpoints: [
      {
        method: 'GET', path: '/api/sources',
        desc: '列出所有数据源插件及启用状态、能力（fetchPost/fetchFamily）',
        response: `[{ "name": "yandere", "enabled": true, "caps": { "fetchPost": true, "fetchFamily": true } }]`,
      },
      {
        method: 'POST', path: '/api/tasks',
        desc: '创建抓取任务（立即开始）。两种扫描方式：从头扫 limit 条；或范围扫（传 end，跳过 start 条扫 start..end）',
        params: [
          { name: 'source', in: 'body', type: 'string', required: true, desc: '数据源名，如 yandere' },
          { name: 'tags', in: 'body', type: 'string[]', required: true, desc: '搜索标签，至少 1 个' },
          { name: 'limit', in: 'body', type: 'number', desc: '抓取条数，默认 100，范围 1-2000' },
          { name: 'start / end', in: 'body', type: 'number', desc: '范围扫描：0 ≤ start < end，单任务最多 2000 条（传 end 时 limit 失效）' },
          { name: 'proxy', in: 'body', type: 'string | null', desc: '代理地址，空值回落到数据源/全局默认代理' },
        ],
        response: `{ "id": 42 }`,
        notes: '400 缺 source/tags 或范围不合法',
      },
      {
        method: 'GET', path: '/api/tasks',
        desc: '最近 50 个任务（按 id 倒序），含状态/进度/错误信息',
        response: `[{ "id": 42, "source": "yandere", "query": "{\\"tags\\":[\\"landscape\\"],\\"limit\\":100,\\"skip\\":0}", "status": "running", "seen": 100, "fetched": 60, "downloaded": 58, "target": 100, "error": null, "created_at": "…", "updated_at": "…", "finished_at": null }]`,
        notes: 'status: running / paused / done / error；进程重启后 running 残留自动变 paused',
      },
      {
        method: 'POST', path: '/api/tasks/:id/pause',
        desc: '暂停任务（可断点续跑）',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, desc: '任务 id' }],
        response: `{ "ok": true }`,
      },
      {
        method: 'POST', path: '/api/tasks/:id/resume',
        desc: '继续任务（从第 1 页重扫，已下载的按 UNIQUE(source, source_id) 跳过）',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, desc: '任务 id' }],
        response: `{ "ok": true }`,
      },
    ],
  },
  {
    name: '图片与标注',
    desc: '打分页取图、图片文件访问、标注（喜欢/不喜欢/跳过）',
    endpoints: [
      {
        method: 'GET', path: '/api/images/next',
        desc: '取下一张待标注图片。smart 模式按模型预测分降序（未出分的排最前），sequential 按入库顺序',
        params: [{ name: 'mode', in: 'query', type: 'string', desc: 'smart（默认）/ sequential' }],
        response: `{ "done": false, "image": { "id": 1, "source": "yandere", "source_id": "123", "page_url": "…", "tags": ["…"], "pred_score": 0.83, "local_path": "…" }, "remaining": 120, "group": [ /* 同组其他成员 */ ] }`,
        notes: '全部标注完返回 { "done": true }',
      },
      {
        method: 'GET', path: '/api/images/:id/thumb',
        desc: '320px JPEG 缩略图（列表网格专用，落盘缓存 data/thumbs/<id>.jpg）',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, desc: '图片 id' }],
        response: '二进制 image/jpeg',
        notes: '404 文件不存在；Cache-Control: max-age=86400',
      },
      {
        method: 'GET', path: '/api/images/:id/file',
        desc: '原始图片文件（按扩展名返回正确 Content-Type）',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, desc: '图片 id' }],
        response: '二进制图片流',
        notes: '404 文件不存在',
      },
      {
        method: 'POST', path: '/api/images/:id/label',
        desc: '标注图片。like 会归档到收藏目录；取消 like 会移出收藏。组传播：like → 组内未标注成员一并保留；dislike → 整组覆盖为不喜欢（含已喜欢的）',
        params: [
          { name: 'id', in: 'path', type: 'number', required: true, desc: '图片 id' },
          { name: 'label', in: 'body', type: 'string', required: true, desc: 'like / dislike / skip' },
        ],
        response: `{ "ok": true, "affected": [1, 2, 3] }`,
        notes: '400 label 非法；404 图片不存在',
      },
      {
        method: 'GET', path: '/api/images',
        desc: '审查/修正列表（分页，每页 60 条，按预测分排序）',
        params: [
          { name: 'label', in: 'query', type: 'string', desc: 'like / dislike / skip / none（未标注）；不传 = 全部' },
          { name: 'minScore / maxScore', in: 'query', type: 'number', desc: '按预测分过滤' },
          { name: 'sort', in: 'query', type: 'string', desc: 'asc 升序，默认 desc 降序（未出分排最前）' },
          { name: 'page', in: 'query', type: 'number', desc: '页码，从 1 开始' },
        ],
        response: `{ "total": 2567, "page": 1, "size": 60, "rows": [{ "id": 1, "tags": ["…"], "user_label": "like", "pred_score": 0.83, … }] }`,
      },
      {
        method: 'POST', path: '/api/cleanup-nopath',
        desc: '清理「抓到链接但从未下载成功」的脏记录（只删未标注的，不影响已标注数据）',
        response: `{ "deleted": 12 }`,
      },
      {
        method: 'GET', path: '/api/stats',
        desc: '全局统计计数',
        response: `{ "total": 2567, "downloaded": 2500, "liked": 300, "disliked": 200, "skipped": 50, "unlabeled": 1950, "withEmbedding": 2400 }`,
      },
    ],
  },
  {
    name: '相册与分组',
    desc: '喜欢的图集合、手动绑定组、封面、yande.re 父子家族',
    endpoints: [
      {
        method: 'GET', path: '/api/album',
        desc: '相册：所有喜欢的图，按标记时间倒序。返回带 group_key（父子 ∪ 手动绑定 ∪ CLIP 近重复 并查）、in_manual、is_cover',
        response: `[{ "id": 1, "tags": ["…"], "pred_score": 0.9, "parent_id": null, "labeled_at": "…", "group_key": "p123", "in_manual": false, "is_cover": true, … }]`,
      },
      {
        method: 'POST', path: '/api/groups/cover',
        desc: '手动设置组封面（同组旧封面自动清除）',
        params: [{ name: 'image_id', in: 'body', type: 'number', required: true, desc: '图片 id' }],
        response: `{ "ok": true, "members": [1, 2] }`,
        notes: '400 缺 image_id；404 图片不存在',
      },
      {
        method: 'POST', path: '/api/groups/bind',
        desc: '手动绑定：多张图并为一组（已有手动组自动合并）',
        params: [{ name: 'image_ids', in: 'body', type: 'number[]', required: true, desc: '至少 2 张图片 id' }],
        response: `{ "ok": true, "group_id": 5 }`,
        notes: '400 少于 2 张',
      },
      {
        method: 'POST', path: '/api/groups/unbind',
        desc: '解除手动绑定（yande.re 父子关系不可解）',
        params: [{ name: 'image_id', in: 'body', type: 'number', required: true, desc: '图片 id' }],
        response: `{ "ok": true }`,
        notes: '404 该图没有手动绑定关系',
      },
      {
        method: 'POST', path: '/api/backfill-parents',
        desc: '回填老数据的 parent_id：对支持 fetchPost 的源逐张查单帖（限速 800ms/张，异步执行）',
        response: `{ "ok": true }`,
        notes: '409 回填进行中；-1 = 已确认无父',
      },
      {
        method: 'GET', path: '/api/backfill-status',
        desc: 'parent_id 回填进度',
        response: `{ "running": true, "done": 100, "total": 500 }`,
      },
      {
        method: 'POST', path: '/api/images/:id/fetch-siblings',
        desc: '补全家族（父子投稿）：缺失成员入库+下载，整组标记为喜欢并归档。需数据源实现 fetchFamily 能力',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, desc: '图片 id' }],
        response: `{ "ok": true, "family": 4, "added": 2, "liked": 3, "failed": 0 }`,
        notes: '404 图片不存在；400 数据源不支持；502 数据源查询失败',
      },
    ],
  },
  {
    name: '训练与偏好',
    desc: '逻辑回归模型训练、zero-shot 冷启动、偏好解释',
    endpoints: [
      {
        method: 'POST', path: '/api/train',
        desc: '启动模型训练（异步）：全量 embedding 已标注样本 → 训练 → 全量重打分。需 ≥10 条喜欢/不喜欢标注',
        response: `{ "ok": true }`,
        notes: '409 训练进行中；进度轮询 GET /api/train/status',
      },
      {
        method: 'GET', path: '/api/train/status',
        desc: '训练/zero-shot 任务状态（两者共用同一状态位，互斥）',
        response: `{ "status": "done", "progress": "", "result": { "version": 7, "samples": 500, "likes": 300, "dislikes": 200, "scored": 2400 } }`,
        notes: 'status: idle / running / done / error',
      },
      {
        method: 'POST', path: '/api/zeroshot',
        desc: 'Zero-shot 冷启动粗筛（异步）：未训练时用 CLIP 文本相似度给最多 200 张未标注图打初始分，提高标注效率',
        response: `{ "ok": true }`,
        notes: '409 任务进行中',
      },
      {
        method: 'GET', path: '/api/preferences',
        desc: '模型信息与偏好解释：tag 特征权重排行（喜欢的元素 / 不喜欢的元素）',
        params: [{ name: 'top', in: 'query', type: 'number', desc: '每侧返回条数，默认 20' }],
        response: `{ "trained": true, "version": 7, "samples": 500, "trainedAt": "…", "positive": [["tag", 1.23]], "negative": [["tag", -0.45]] }`,
        notes: '未训练返回 { "trained": false }',
      },
    ],
  },
  {
    name: '系统设置',
    desc: '数据目录查看/修改/迁移、服务重启',
    endpoints: [
      {
        method: 'GET', path: '/api/settings',
        desc: '当前路径配置',
        response: `{ "dataDir": "…", "incoming": "…", "favorites": "…", "thumbs": "…", "models": "…" }`,
      },
      {
        method: 'POST', path: '/api/settings/data-dir',
        desc: '修改数据目录。目标已有 curator.db → 直接切换（需重启）；没有数据 → 返回 empty 由调用方决定是否迁移',
        params: [{ name: 'path', in: 'body', type: 'string', required: true, desc: '新数据目录绝对路径' }],
        response: `{ "mode": "use-existing", "needRestart": true }  或  { "mode": "empty" }`,
        notes: '400 路径非法或与当前相同',
      },
      {
        method: 'POST', path: '/api/settings/migrate',
        desc: '迁移当前数据到新目录（异步，复制式，旧目录保留）：WAL 落盘 → 复制 db/图库/模型 → 重写 local_path 前缀 → 写 config',
        params: [{ name: 'path', in: 'body', type: 'string', required: true, desc: '目标目录（空目录或不存在）' }],
        response: `{ "ok": true }`,
        notes: '409 迁移进行中；400 目标非空/已有数据/与当前相同；缩略图缓存不复制',
      },
      {
        method: 'GET', path: '/api/settings/migrate-status',
        desc: '迁移进度',
        response: `{ "running": true, "phase": "copy", "done": 100, "total": 500, "error": "" }`,
        notes: 'phase: checkpoint / copy / rewrite-paths / done / error',
      },
      {
        method: 'POST', path: '/api/restart',
        desc: '重启服务：延迟 2s 由独立进程重新拉起 start.bat，当前进程退出',
        response: `{ "ok": true }`,
        notes: '进程退出可能截断连接，调用方应轮询等待恢复',
      },
    ],
  },
  {
    name: '存储管理',
    desc: '存储后端信息、压缩/格式规则（即时生效）、存量批处理',
    endpoints: [
      {
        method: 'GET', path: '/api/storages',
        desc: '存储列表（按后端类型一行），含剩余空间、当前处理规则、可选格式项',
        response: `[{ "type": "local", "name": "本地存储", "incoming": "…", "favorites": "…", "freeBytes": 0, "totalBytes": 0, "process": { "compression": {…}, "formats": {…} }, "formatOptions": { "common": ["jpg","png","webp","gif"], "convertTargets": ["jpg","png","webp"] } }]`,
      },
      {
        method: 'PUT', path: '/api/storages/:type/compression',
        desc: '保存压缩规则（写入 config.json 并立即生效，作用于新下载图片）',
        params: [
          { name: 'type', in: 'path', type: 'string', required: true, desc: '后端类型，当前仅 local' },
          { name: 'enabled', in: 'body', type: 'boolean', required: true, desc: '是否启用' },
          { name: 'mode', in: 'body', type: 'string', desc: 'scale 固定比例 / maxSize 最大单张大小' },
          { name: 'scalePercent', in: 'body', type: 'number', desc: '1-100，mode=scale 时必填' },
          { name: 'maxSizeMB', in: 'body', type: 'number', desc: '0-50，mode=maxSize 时必填' },
        ],
        response: `{ "ok": true, "process": {…} }`,
        notes: '400 类型不存在或参数越界',
      },
      {
        method: 'PUT', path: '/api/storages/:type/formats',
        desc: '保存格式规则：启用的格式列表 + 未启用格式自动转换的目标（目标必须在启用列表内，不可为 gif）',
        params: [
          { name: 'type', in: 'path', type: 'string', required: true, desc: '后端类型，当前仅 local' },
          { name: 'enabled', in: 'body', type: 'string[]', required: true, desc: '至少 1 种，如 ["jpg","png","webp"]' },
          { name: 'convertTo', in: 'body', type: 'string', required: true, desc: '转换目标格式' },
        ],
        response: `{ "ok": true, "process": {…} }`,
        notes: '400 列表为空 / 目标非法 / 目标不在启用列表',
      },
      {
        method: 'POST', path: '/api/storages/:type/process-existing',
        desc: '存量图片按当前规则批处理（异步）：备份数据库 → 逐张处理（同规则指纹跳过）→ 同步收藏夹 → 清缩略图缓存',
        params: [{ name: 'type', in: 'path', type: 'string', required: true, desc: '后端类型，当前仅 local' }],
        response: `{ "ok": true }`,
        notes: '409 批处理进行中；动图永不处理',
      },
      {
        method: 'GET', path: '/api/storages/process-status',
        desc: '存量批处理进度',
        response: `{ "running": true, "phase": "process", "done": 100, "total": 500, "processed": 80, "skipped": 20, "failed": 0, "savedBytes": 0, "error": "" }`,
      },
    ],
  },
  {
    name: '外置接口',
    desc: '面向外部调用者的开放接口',
    endpoints: [
      {
        method: 'POST', path: '/api/like',
        desc: '「我喜欢这个图片！」：上传一张图片，按当前训练的模型预测我会不会喜欢它。纯计算不留痕（临时文件算完即删，不入库）',
        params: [
          { name: 'file', in: 'body', type: 'multipart 文件字段', desc: '方式一：multipart/form-data 上传，字段名 file' },
          { name: 'image', in: 'body', type: 'string', desc: '方式二：application/json，base64 字符串或 data URL' },
        ],
        response: `{ "score": 0.83, "like": true, "model_version": 7 }`,
        notes: 'like = score ≥ 0.5。限制：≤20MB，仅静态 jpg/png/webp（拒绝 gif 与动图 webp）。外部图片无 tags，预测只用 CLIP 视觉特征（tag 特征全 0），分数与站内图口径略有差异。错误码：400 格式不支持/动图/缺参数，409 模型未训练，413 超 20MB，422 图片无法解码',
      },
      {
        method: 'GET', path: '/api/docs',
        desc: '本文档的 JSON 数据源（设置页「API → 接口文档」渲染用）',
        response: `[{ "name": "分组名", "desc": "…", "endpoints": [{ "method": "GET", "path": "/api/…", "desc": "…", "params": […], "response": "…", "notes": "…" }] }]`,
      },
      {
        method: 'GET', path: '/like',
        desc: '「我喜欢这个图片！」公开分享页：自包含 HTML 页面，访问者无需进入管理后台即可上传图片并获得预测结果（内部调用 POST /api/like）',
        response: 'text/html 页面',
        notes: '无需鉴权；分享给谁谁能用，注意只在可信网络内分享',
      },
    ],
  },
];
