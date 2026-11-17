/**
 * discover 模块 provider / controller 清单（沿用 works.module.ts 约定，由 app.module 组合）。
 *
 * ## 端口绑定（M1 dev/CI = 录制回放 VCR）
 * SOURCE_REGISTRY / LLM_PORT 绑 packages/ai 的录制适配器，store 由 dev-fixtures 从 fixtures/seed.json 构建。
 * 这是架构 §9.1 / plan §6.1·§7.1 指定的 dev provider（无供应商凭证、确定性、零成本），**不是桩**：
 * 真实编排框架 SourceRegistry + 真实饱和度纯函数 + 真实 schema 校验都跑在其上。
 * staging/prod 换真实供应商适配器即可，端口与上层服务零改动（ADR-15）。
 *
 * ## 仓储工厂
 * 与 works.module 同一手法：useFactory 注入 DB_CLIENT（Kysely<Database>），用 Parameters<typeof>[0]
 * 取形参类型，**不在 apps/api 引入 kysely 依赖边**（apps/api 禁 kysely）。工厂惰性，构造时不触库。
 *
 * 所有注入显式 @Inject(TOKEN)：esbuild 不生成 emitDecoratorMetadata，靠类型注入会运行时 undefined。
 */
import type { Provider } from '@nestjs/common';
import {
  createMaterialRepository,
  createSearchSessionRepository,
  createScriptRepository,
  createStyleRepository,
  createTopicRepository,
  createWorkMaterialRepository,
  type MaterialRepository,
  type SearchSessionRepository,
  type ScriptRepository,
  type StyleRepository,
  type TopicRepository,
  type WorkMaterialRepository,
} from '@knowstudio/db/repositories';
import {
  RecordedLlmAdapter,
  RecordedEmbeddingAdapter,
  SourceRegistry,
  recordedSourceAdapters,
  type LlmPort,
} from '@knowstudio/ai';
import { DB_CLIENT } from '../shared/tokens.js';
import { buildDevRecordingStores, type DevRecordingStores } from './dev-fixtures.js';
import { DiscoverController } from './discover.controller.js';
import { DiscoverService } from './discover.service.js';
import {
  LLM_PORT,
  MATERIAL_REPOSITORY,
  SEARCH_SESSION_REPOSITORY,
  SOURCE_REGISTRY,
  TOPIC_REPOSITORY,
  SCRIPT_REPOSITORY,
  STYLE_REPOSITORY,
  WORK_MATERIAL_REPOSITORY,
  EMBEDDING_PORT,
} from './discover.tokens.js';
import { LibraryController } from './library.controller.js';
import { MaterialsController } from './materials.controller.js';
import { TopicsController } from './topics.controller.js';
import { TopicsService } from './topics.service.js';
import { ScriptController } from './script.controller.js';
import { ScriptService } from './script.service.js';
import { StyleController } from './style.controller.js';
import { DerivativesController } from './derivatives.controller.js';
import { DerivativesService } from './derivatives.service.js';

// dev 录制 store 只构建一次（读 seed.json），两个端口工厂共享，避免重复 IO。
let devStores: DevRecordingStores | undefined;
function stores(): DevRecordingStores {
  devStores ??= buildDevRecordingStores();
  return devStores;
}

export const DISCOVER_PROVIDERS: Provider[] = [
  {
    provide: SEARCH_SESSION_REPOSITORY,
    useFactory: (db: unknown): SearchSessionRepository =>
      createSearchSessionRepository(db as Parameters<typeof createSearchSessionRepository>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: MATERIAL_REPOSITORY,
    useFactory: (db: unknown): MaterialRepository =>
      createMaterialRepository(db as Parameters<typeof createMaterialRepository>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: WORK_MATERIAL_REPOSITORY,
    useFactory: (db: unknown): WorkMaterialRepository =>
      createWorkMaterialRepository(db as Parameters<typeof createWorkMaterialRepository>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: SOURCE_REGISTRY,
    useFactory: (): SourceRegistry => {
      const registry = new SourceRegistry();
      for (const adapter of recordedSourceAdapters(stores().sourceStore))
        registry.register(adapter);
      return registry;
    },
  },
  {
    provide: LLM_PORT,
    useFactory: (): LlmPort => new RecordedLlmAdapter(stores().llmStore),
  },
  {
    provide: EMBEDDING_PORT,
    useFactory: () => new RecordedEmbeddingAdapter(),
  },
  {
    provide: TOPIC_REPOSITORY,
    useFactory: (db: unknown): TopicRepository =>
      createTopicRepository(db as Parameters<typeof createTopicRepository>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: SCRIPT_REPOSITORY,
    useFactory: (db: unknown): ScriptRepository =>
      createScriptRepository(db as Parameters<typeof createScriptRepository>[0]),
    inject: [DB_CLIENT],
  },
  {
    provide: STYLE_REPOSITORY,
    useFactory: (db: unknown): StyleRepository =>
      createStyleRepository(db as Parameters<typeof createStyleRepository>[0]),
    inject: [DB_CLIENT],
  },
  DiscoverService,
  TopicsService,
  ScriptService,
  DerivativesService,
];

export const DISCOVER_CONTROLLERS = [
  DiscoverController,
  MaterialsController,
  LibraryController,
  TopicsController,
  ScriptController,
  StyleController,
  DerivativesController,
];
