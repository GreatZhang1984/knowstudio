# 知影工坊 KnowStudio

知影工坊是面向单兵知识类博主的短视频生产工作台，当前仓库实现 M1 的工程化切片。产品按“搜素材、想选题、做视频、发平台”推进，所有关键闸门由服务端下发，前端不做本地放行判断。

## 模块

- `apps/web`：React 18 + Vite + AntD 5 前端。已包含 18 路由骨架、登录、按 `workId` 隔离的状态容器、闸门深链防护、素材搜索页、素材库、选题页、文案编辑器、风格样本页、配额页、指标看板、渲染中心、多平台元数据派生页与导出页。
- `apps/api`：NestJS API。已包含认证、Work CRUD、闸门信封、素材搜索/轮询、素材收藏、素材库、选题生成/换一批/选定 G1、文案生成/自动保存/风格重写/确认 G2、渲染任务/取消/重试/SSE、配额账本、平台规则、局部重算、四平台元数据与媒体派生、合规报告/素材替换/凭证绑定/复检、导出打包与过期重签读取、客户端埋点上报与指标快照读取。
- `apps/worker`：渲染队列 worker。领取持久队列任务、生成课件/字幕/时间轴/音频四类分层资产、调用 ffmpeg 输出 MP4；支持高清复用音频、局部重算、四平台画幅/时长派生、封面生成、四平台导出 ZIP/manifest/发布清单、过期租约重投、任务对账与小时级指标聚合，并提交配额、任务状态与关键事件。
- `packages/contracts`：zod 契约、错误码、DTO、SSE 事件与 OpenAPI 快照。
- `packages/domain`：Work 状态机、进度权重、闸门派生与合规指纹等纯函数。
- `packages/db`：MySQL 8 迁移、36 表结构、种子与仓储。
- `packages/ai`：素材源编排、录制回放 / Tavily Web Search / Obsidian MCP 适配器、饱和度、空白角度、选题生成、1024 维录制 Embedding、文案生成、搬运检测与风格重写。
- `packages/redis`、`packages/storage`：Redis 缓存/限流/PubSub 与 S3 兼容存储抽象。
- `packages/media`、`packages/queue`、`packages/quota`：视频分层与合成、持久队列租约/fencing、配额行锁预扣与结算。
- `packages/compliance`：四平台导出前合规纯函数引擎，输出报告项、阻断计数与 domain 合规指纹。
- `packages/observability`：浏览器埋点 SDK、服务端事件 Recorder、G1/G2/G3/G5/G6 与护栏指标小时级聚合、`sys.metric` 任务健康读取；`/browser` 子入口保持前端不携带服务端 DB 依赖。
- `packages/ui`：主题 token、异常态组件、闸门锁定态与阶段步进器。

## 本地启动

1. 启动基础设施：`docker compose --project-directory infra up -d`。
2. 启动 API：`pnpm --filter @knowstudio/api dev`，默认端口 `3000`。
3. 启动 Web：`pnpm dev`，默认端口 `5173`，`/api` 已代理到 API。
4. 启动渲染 worker：`pnpm worker`（真实渲染需本机 `ffmpeg` 可用）。
5. 可选启动 Grafana 指标看板：`docker compose --project-directory infra --profile metrics up -d grafana`，默认地址 `http://127.0.0.1:3001`，本地默认密码 `knowstudio-dev`。

开发模式默认使用前端 fixture；如需联调真实 API，启动 Web 时设置 `VITE_USE_FIXTURES=false`。

### 素材源

素材搜索页支持选择 `录制演示`、`Web 搜索` 与 `Obsidian`。素材源声明由 `GET /api/material-sources` 下发；前端只提交 source id，不提交外部 URL 或密钥。

启用 Tavily Web Search：

```powershell
$env:TAVILY_API_KEY='<your-tavily-key>'
$env:WEB_SEARCH_MAX_RESULTS='5'
```

启用 Obsidian MCP（当前面向 API 与 MCP Server 同机或内网可达的本地部署）：

```powershell
$env:MCP_OBSIDIAN_ENABLED='true'
$env:MCP_OBSIDIAN_URL='http://127.0.0.1:3940/mcp'
$env:MCP_OBSIDIAN_TOOL='search_notes'
$env:MCP_OBSIDIAN_MAX_RESULTS='5'
$env:MCP_OBSIDIAN_TIMEOUT_MS='8000'
```

配置后重启 API，素材搜索页会出现可选的真实素材源。Web 与 Obsidian 素材会按当前用户落库并进入素材库，授权状态默认 `unknown`，后续仍走既有合规与授权修复链路。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm guards
pnpm boundaries
pnpm test
pnpm build
```

以上命令等价于 `pnpm check`。GitHub 已配置 Actions：`main` 的 push 和 pull request 会启动 MySQL 8.4、Redis 7、Node 22 与 ffmpeg，先执行 36 表迁移和种子，再跑完整检查。当前测试链路使用本地存储；MinIO S3 冒烟测试后续单独纳入 CI。

### 指标运维

`/settings` 展示快照状态、最近 `sys.metric` 聚合任务、耗时与失败原因。需要修复指定小时快照时，运维人员可调用 `POST /api/metrics/recompute`：

```bash
curl -X POST http://127.0.0.1:3000/api/metrics/recompute \
  -H "Authorization: Bearer <accessToken>" \
  -H "x-metric-recompute-token: <operatorToken>" \
  -H "Content-Type: application/json" \
  -d '{"bucket":"2026-11-18T00:00:00Z"}'
```

开发环境未设置 `METRIC_RECOMPUTE_TOKEN` 时允许已登录用户触发；生产环境必须设置该变量，否则接口始终拒绝。
