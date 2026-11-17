/**
 * works 模块的 provider / controller 清单。
 *
 * 沿用 WP12 `auth.module.ts` 的既有约定：导出清单，由 `app.module.ts` 的
 * `buildAppModule(overrides, extraControllers)` 组合进单一 DynamicModule。
 * 这样 T-10 无需改动 WP12 独占的 app.module.ts，测试也能用 overrides 替换令牌。
 *
 * 所有注入参数显式 @Inject(TOKEN)：esbuild 不生成 emitDecoratorMetadata，
 * 靠类型注入会「tsc 通过、运行时 undefined」（假绿）。
 *
 * ## 两个端口的绑定（WORKS_PORT_PROVIDERS，fail-closed）
 * `WORK_TRUTH_SNAPSHOT`（闸门真相快照聚合）与 `WORK_QUOTA_READER`（配额账本读取）
 * 由本清单的 `WORKS_PORT_PROVIDERS` 绑定到 packages/db 的**真实 DB 适配器**
 * （createWorkTruthSnapshotLoader / createWorkQuotaReader）。两者都只聚合真相、
 * 绝不硬编码闸门布尔或默认额度：缺账本行 / 恒等式漂移一律抛错（D-04 / D-22 对策）。
 * 组合方（app.module）默认纳入本清单；测试可用 overrides 替换为替身。
 * 若组合方漏绑这两个令牌，Nest 启动即失败——绝不退化成「默认全放行」或「默认 0 点」。
 */
import type { Provider } from '@nestjs/common';
import {
  createWorkQuotaReader,
  createWorkRepository,
  createWorkTruthSnapshotLoader,
  type WorkQuotaReader,
  type WorkRepository,
  type WorkTruthSnapshotLoader,
} from '@knowstudio/db/repositories';
import { DB_CLIENT } from '../shared/tokens.js';
import { OwnershipGuard } from './ownership.guard.js';
import { QuotaController } from './quota.controller.js';
import { PlatformRuleController } from './rules.controller.js';
import { WorksController } from './works.controller.js';
import { WORK_QUOTA_READER, WORK_REPOSITORY, WORK_TRUTH_SNAPSHOT } from './works.tokens.js';

export const WORKS_PROVIDERS: Provider[] = [
  {
    provide: WORK_REPOSITORY,
    // 刻意不 import kysely：apps/api 未声明该依赖（pnpm 严格隔离下不可解析）。
    // 用 Parameters<typeof createWorkRepository>[0] 取出形参类型，即 WP10 的 Kysely<Database>，
    // 既保持类型安全又不新增依赖边。DB_CLIENT 注入的正是同型的 Kysely<Database>，无需断言收窄。
    useFactory: (db: unknown): WorkRepository =>
      createWorkRepository(db as Parameters<typeof createWorkRepository>[0]),
    inject: [DB_CLIENT],
  },
  OwnershipGuard,
];

/**
 * 两个跨 Task 端口的生产绑定。与 WORK_REPOSITORY 同一手法：
 * useFactory 注入 DB_CLIENT（Kysely<Database>），用 Parameters<typeof>[0] 取形参类型，
 * 不在 apps/api 引入 kysely 依赖边。工厂是惰性闭包——构造时不触库，
 * 故 auth 测试把 DB_CLIENT 桩成 {} 也能安全 boot（不会 eager 连接 MySQL）。
 */
export const WORKS_PORT_PROVIDERS: Provider[] = [
  {
    provide: WORK_TRUTH_SNAPSHOT,
    useFactory: (db: unknown): WorkTruthSnapshotLoader =>
      createWorkTruthSnapshotLoader(db as Parameters<typeof createWorkTruthSnapshotLoader>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: WORK_QUOTA_READER,
    useFactory: (db: unknown): WorkQuotaReader =>
      createWorkQuotaReader(db as Parameters<typeof createWorkQuotaReader>[0]),
    inject: [DB_CLIENT],
  },
];

export const WORKS_CONTROLLERS = [WorksController, QuotaController, PlatformRuleController];
