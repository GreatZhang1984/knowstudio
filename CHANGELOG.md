# Changelog

## 2026-11-18

- 完成 T-65 用户级素材源配置：
  - 新增 `user_source_config` 表，配置按 `user_id + source_id` 隔离；Tavily API Key 以 AES-256-GCM 密文保存，接口只返回末四位。
  - 新增素材源配置读写、测试与删除接口，API 启动时不再依赖 Tavily / Obsidian 系统环境变量，而是按当前用户动态装配真实素材源。
  - 新增 `/settings/sources` 配置页，可在界面配置 Web 搜索与 Obsidian MCP；Obsidian 地址仅允许本机、内网和 `.local`。
  - 服务端加密密钥保存于 `infra/.source-config.key`，文件不入库且必须随部署卷持久化。
- 完成 T-64 多素材源接入：
  - 新增 `GET /api/material-sources`，工作台可多选录制演示、Tavily Web Search 与 Obsidian MCP 素材源，并在本浏览器记住默认选择。
  - `POST /api/discover/search` 支持 `sources`；真实源素材按当前用户稳定 ID 落库，可进入素材库、收藏与后续选题链路。
  - 新增 Tavily Web Search 适配器与 Obsidian Streamable HTTP MCP 适配器；单源失败保持 partial，外部配置由 T-65 的用户级配置安全保存。
- 修正素材搜索示例词与真实源配置状态展示：未配置源不可选，不再把录制库未收录关键词误认为前后端断链。

- 完成 T-63 指标可信度补强：
  - `GET /api/metrics` 新增 `dataStatus`、期望小时桶与最近 `sys.metric` 任务状态、次数、起止时间、耗时、重试时间和结构化错误。
  - Worker 按队列 payload 指定的小时桶聚合，不再忽略 bucket；聚合失败进入队列重试/死信并保留错误，成功后清空旧错误。
  - 新增 `POST /api/metrics/recompute` 运维重算入口：开发环境可免运维令牌，生产必须配置 `METRIC_RECOMPUTE_TOKEN`；同 bucket 已在排队或执行时不重复入队。
  - 指标页展示快照状态、最近聚合任务、耗时与失败原因；Grafana 新增 `sys.metric` 任务健康表。

- 完成 T-61/T-62 上线前收口：
  - 新增真实作品全链路验收测试：从新建 Work、搜索、收藏、生成/选定选题、生成/润色/确认文案、草稿与高清渲染、元数据与四平台媒体派生、合规阻断与授权修复、导出 ZIP、手动发布回执，到小时指标聚合全链路真实 MySQL/Redis/Nest/Worker 验证。
  - 修复客户端事件接口漏挂 `@Body()` 导致合法埋点请求始终 400 的问题。
  - 修复用户润色后文案版本与音频层版本错位，媒体派生错误查找 `AUDIO_LAYER_MISSING` 的问题；派生改为按音频层输入指纹复用。
  - 修复媒体派生运行阶段写入契约外 `derive` 导致任务详情 500 的问题，统一为既有 `mux` 阶段。
  - 修复视频参数空预览生成空 `UPDATE SET` 导致 MySQL 500 的问题。
  - 修复 InnoDB ngram 全文索引短暂滞后导致新建作品搜索漏召回的问题；作品检索保留 FULLTEXT，并对多字查询追加精确 LIKE 兜底。
  - 修复迁移账本命中但目标库为空时跳过基线迁移的问题；账本现在会核对已声明表是否真实存在，缺失时按语句补建。
  - 新增 GitHub Actions 全量检查：自动启动 MySQL 8.4、Redis 7、Node 22 与 ffmpeg，执行迁移、种子和 `pnpm check`；当前测试链路使用本地存储，MinIO S3 冒烟后续单独纳入。

## 2026-11-17

- 完成 T-59/T-60 埋点与指标闭环：
  - 新增 `packages/observability`：浏览器埋点 SDK 支持 20 条/5 秒批量上报、满批立即上报、`keepalive` 与页面关闭 `sendBeacon`；服务端 Recorder 统一写入 `analytics_event`。
  - 新增 `POST /api/events`，仅接受 `script_first_edit` 与 `publish_receipt_marked` 两类客户端事件，并校验认证、作品归属、时间窗与批量上限；关键链路事件全部由服务端动作成功后写入。
  - 覆盖 SPEC §11 事件：Work 创建、搜索完成、素材收藏/取消、选题生成/选定、文案生成/确认、风格建议接受/拒绝、草稿预览、渲染开始/成功/失败、额度不足、局部重算、派生生成/编辑、合规阻断、导出完成与手动发布回执。
  - 派生页新增“标记已发布”人工回执入口，只记录用户已手动发布事实，不提供任何平台自动发布写接口，G5 防线保持不变。
  - 新增小时级 `sys.metric` 任务，使用小时 dedup key 与 MySQL `GET_LOCK('knowstudio:metric_hourly', 0)` 单例聚合，重复执行同一 bucket 只 upsert。
  - 指标覆盖 G1 端到端 P50、G2 近 14 天发布天数、G3 润色 P50、G5 适配 P50/平台覆盖、G6 单作品成本、大改率、平均点数、渲染失败率、合规阻断率与 60 分钟完成占比；G4 盲测保持人工录入口径，不伪造数值。
  - 新增 `GET /api/metrics` 只读 `metric_snapshot`；快照缺失或过期时前端显示“—”，不以旧值冒充新值。
  - `/settings` 设置占位页替换为指标看板；配额与成本页继续实时读取 `quota_ledger`，不切换到快照。
  - Grafana provisioning 新增 MySQL datasource 与只读指标 dashboard；`infra/docker-compose.yml` 新增独立 `metrics` profile 的 Grafana 服务，避免默认基础设施启动依赖 Grafana 密码。
  - 补充浏览器 SDK测试、真实 MySQL 指标幂等测试、看板测试与 OpenAPI 快照。
  - 修复浏览器 SDK 上报失败后同步递归 flush 导致测试进程 OOM 的问题，失败事件改为按下一轮定时重试。

- 完成 T-56/T-57 导出打包与导出页：
  - 新增 `POST /works/:id/export` 与 `GET /exports/:id`；导出前强制合规复检，G4 或四平台媒体未就绪时结构化拦截，不创建导出包。
  - 新增 `export.pack` worker 任务，流式生成 ZIP，包含四平台 MP4、封面、`manifest.json` 与 `发布清单.md`，并登记 11 个可下载产物。
  - 导出包下载链接 24 小时有效；过期后重新读取仅刷新签名有效期，不重新打包。
  - 本地存储支持流式写入与导出/封面对象读取，避免 ZIP 落盘和成功页 404。
  - 导出页覆盖复核中、合规阻断、排队/打包中、成功、错误五态；成功态提供 ZIP、manifest、发布清单与四平台成片/封面下载，并保留 G5 手动发布声明。
  - 补充前端导出页测试与真实 MySQL/Nest/worker E2E，覆盖阻断不建包、真实打包下载、ZIP 内容、manifest/发布清单与过期重签。

## 2026-11-16

- 完成 T-54/T-55 合规闭环：
  - 新增 `packages/compliance` 纯函数引擎，覆盖图片/音乐/字体/文案四类检查、unknown/restricted 授权 fail-closed、模板字体白名单、平台受限词 Aho-Corasick 多模匹配与连续 30 字原文命中告警。
  - `GET /works/:id/compliance` 基于当前 Work 真相生成并持久化 `compliance_report`，报告携带 domain 合规指纹；同指纹复用缓存，`force=true` 复检，G4 由现有真相快照自动翻转。
  - 新增 `POST /works/:id/materials/:mid/license` 授权凭证绑定路径；全局公共素材采用 copy-on-write，复制为用户私有素材后替换当前作品引用，不修改公共库授权。
  - 新增 `POST /works/:id/materials/:mid/replace` 同类型素材替换路径；替换保留原 `used_in` 引用位置，派生页可携带阻断素材跳转素材库完成替换后返回。
  - 派生页新增合规检查面板，支持开始检查、替换素材、移除素材、绑定授权凭证、复检和 G4 通过后进入导出页；移除/替换影响课件的素材前明示 0 点重算成本。
  - 移除 `used_in=slides` 素材时，同事务删除引用并创建 0 点 `render.patch(slides)` 任务，避免引用已删但课件不更新的中间态。
  - 补充纯函数引擎测试与真实 MySQL/Nest HTTP E2E，覆盖阻断、凭证修复、同类型替换、G4 解锁、派生标题变更导致指纹过期、force 复检恢复、slides 素材替换/移除自动 0 点重算与复检。

- 完成 T-52 媒体派生：
  - `scope=media` 在 G3 后进入 `derive.media` 队列；缺省 scope 仍按 media 处理，G3 未满足返回 409。
  - worker 按四平台当前规则重排竖横画幅、按时长版本裁剪时间轴与 MP4，生成平台封面层。
  - 每个平台独立写入 `video_asset` / `asset_layer(cover)`，回填 `mediaReady`、`videoAssetId`、`coverLayerId` 与可预览 `mediaUrl`。
  - 派生页支持高清完成后生成平台媒体、查看任务状态和当前平台 MP4 预览。
  - 补充真实 MySQL + worker E2E，覆盖四平台产物、封面、B站横屏和小红书预告版时长裁剪。

- 完成 T-51/T-53/T-58 元数据派生闭环：
  - 新增四平台 metadata 生成，绑定当前平台规则版本；`scope=metadata` 只需 G2，缺省 scope 按 media 处理并受 G3 拦截。
  - 新增派生读取、单平台标题/标签/时长编辑、标题重生成；各平台独立持久化，互不影响。
  - 标题/标签按平台规则返回 warn/block 校验；四平台元数据齐备后 Work 进入 derive 阶段。
  - 渲染中可在派生页继续编辑；Work 状态采用“只进不退”迁移，渲染排队/成功/取消不再把派生阶段退回视频阶段。
  - 工作台增加全局渲染任务条，渲染在途时提供“去写平台标题”并行入口。
  - 派生页支持四平台切换、标题/标签/时长编辑、校验提示、保存与媒体派生等待态。
  - 补充 A1 闸门断言、渲染中并行编辑、生成器、派生页和全局任务条测试。

- 完成渲染链补账 + T-49/T-50：
  - 持久队列支持过期租约重投、fencing 拒绝旧 worker、达到上限进入死信，并在 worker 轮询时对账缺失/终态队列。
  - 高清渲染复用同指纹音频层；取消排队任务立即释放预扣，运行中任务在阶段边界结算；重试可复用 held 预扣或重新预扣，不重复结算。
  - SSE 改为持续事件流，支持 Last-Event-ID 游标递增与 15 秒心跳；页面轮询继续作为降级兜底。
  - 新增局部重算：`PATCH /works/:id/video` 按失效矩阵返回点数并保存参数，`POST /works/:id/video:patch` 按 layer scope 入队，worker 只写失效层并复用旧资产。
  - 视频页播放器增加真实时码与可拖拽进度条，拖动直接 seek 到 MP4 时间点。
  - 新增配额账本明细分页 API 与配额页，侧栏/顶栏/配额页继续共用同一 quota query，并在渲染终态后同步刷新。
  - 新增四平台当前规则读取 API，为 T-51 元数据派生提供规则版本、画幅、时长、标题/标签限制等输入。
  - 补充队列过期恢复、配额账本/平台规则 HTTP、局部重算与高清复用真实渲染 E2E，以及配额页组件测试。

- 完成 T-35～T-48 视频渲染与任务闭环：
  - 新增分层资产指纹、时间轴、字幕 VTT、课件 SVG、本地 SAPI 音频与 ffmpeg MP4 合成。
  - 新增配额行锁、reserve/commit/release、账本记录与 402 结构化错误；高清渲染 2 点、草稿 0 点。
  - 新增 MySQL 持久队列 `job_queue`，支持 `FOR UPDATE SKIP LOCKED` 领取、租约续期、 fencing、退避重试与死信。
  - 渲染 API 与配额预扣、任务创建、队列写入在同一事务内完成；并发渲染由数据库唯一生成列拦截为 409。
  - 新增独立 worker，生成并写入课件/字幕/时间轴/音频四类分层产物、视频资产、任务事件，提交配额并推进 G3；API 不再承担媒体生成。
  - 新增任务详情、取消、重试、SSE 事件回放与本地视频文件服务。
  - 视频页支持草稿/高清下单、真实 MP4 播放、G3 状态与去派生入口；渲染中心支持阶段/进度/消耗点数/重试/取消。
  - 补充并发配额、队列 fencing、分层资产与真实 MySQL 渲染 E2E 测试。

- 完成 T-16 + T-28～T-34 文案闭环：
  - 新增三段式文案生成、字数与时长统一口径、搬运检测与自动重述端口。
  - 新增 Script/Section/Line/Revision 仓储与自动保存接口，支持 baseVersion 冲突双版本、确认锁定与解锁失效。
  - 文案页支持行级编辑、800ms 自动保存、IndexedDB 离线暂存、恢复重放、20 步撤销/重做。
  - 新增风格样本与画像接口、样本管理页、风格重写原版/改写对比与逐句接受/拒绝。
  - 人工确认弹窗确认后置 G2，并推进到视频生成；解锁后 G2 失效、文案置 stale。
  - 补充真实 MySQL/Nest E2E 与前端组件测试，覆盖 G1 拦截、版本冲突、锁定、越权 404、风格样本和逐句重写。

- 完成 T-23 + T-24～T-27 第一条跨页面闭环：
  - 素材库页支持标题、类型、授权筛选，展示来源、授权与用户级收藏态。
  - 选题页支持 12 角度展示、单选、换一批、差异校验信息与选定后进入文案页。
  - 后端新增 `topic_batch/topic` 仓储、选题生成/读取/换一批/选定接口，选定后置 G1 并推进 Work 到文案步骤。
  - 选题依据只允许当前作品已收藏素材；换一批按 hook 指纹跨批去重，重试上限 2。
  - 新增 1024 维录制 Embedding 与应用层 cosine 校验，批内最大相似度不超过 0.75。
  - 补充真实 MySQL/Nest E2E 与前端组件测试，覆盖越权 404、非法素材 400、G1 生效与跨批不重复。

- 完成T-22 素材搜索页：
  - 新增关键词/领域搜索、搜索受理与 1 秒轮询、同关键词“已是最新结果”提示与 60 秒超时降级。
  - 新增半环饱和度仪表，展示置信度、样本量、覆盖平台、聚合时间与来源；样本不足时明确标记“仅供参考”。
  - 新增空白角度入口，携带角度上下文跳转选题页。
  - 新增知识素材、热点角度、同行爆款三列结果，展示来源、授权状态与收藏状态。
  - 新增收藏/取消收藏、5 秒撤销、失败回滚，并保持 action-bar 收藏计数与当前 Work 缓存同步。
  - 无当前作品时会先创建 Work 再发起搜索，避免搜索会话归属丢失。
  - 补充 initial/loading/success/empty/error/partial 呈现与 27 条前端聚焦测试。
