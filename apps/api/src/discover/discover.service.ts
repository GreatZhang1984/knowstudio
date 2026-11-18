/**
 * 搜索编排服务（T-20 / 架构 §9.2·§9.4·§10.4 / SPEC §3.2·§6.1）。
 *
 * ## 异步模型（架构 §10.4）
 * search/topics/script 等 <30s 的 AI 任务用 **202 + 1s 轮询、进程内异步**，不是 job_queue、不是 SSE。
 * POST /discover/search 立即返回 202{searchId}（或缓存命中 200{session}），后台 runSearch 落库，
 * 前端轮询 GET /discover/search/:id 读持久化状态。五态由 status + materials + partialErrors 决定：
 *  queued/running→loading · succeeded+有素材→success · succeeded+空→empty ·
 *  succeeded+partialErrors→partial · failed→error。
 *
 * ## 缓存（架构 §9.4，24h）
 * 非 force 时按 (keyword,domain,user,24h) 找最近 succeeded 会话；命中后**必须用 contracts 复验形状**：
 * 旧种子行 ss1 的 saturation 是 legacy 形状（level 是中文展示串、缺 confidence/sufficient）→ 复验失败
 * → 视为未命中重跑（新会话 created_at 更新，DESC 排序自然遮蔽旧行）。绝不把非法形状下发前端。
 *
 * ## 诚实降级（D-08 / 架构 §9.3）
 * 单源失败→partialErrors（其余列正常）；全源失败→failed（可手动导入）；空聚合→succeeded+空素材（真实空态，
 * 不是故障）；LLM 不可用→饱和度仍挂载、空白角度缺失明示 partial，绝不伪造常量答案。
 * 饱和度由 computeSaturation 真实算（输入驱动），**绝不回退常量 72**（D-08 点名缺陷）。
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  SearchSessionSchema,
  type BlankAngle,
  type SearchRequest,
  type SearchSession,
} from '@knowstudio/contracts';
import {
  computeSaturation,
  generateBlankAngles,
  type LlmPort,
  type SourceRegistry,
} from '@knowstudio/ai';
import type {
  MaterialRepository,
  MaterialRow,
  SearchSessionRepository,
  SearchSessionRow,
  WorkMaterialRepository,
  WorkRepository,
} from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { WORK_REPOSITORY } from '../works/works.tokens.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import { toRfc3339 } from '../works/work-envelope.js';
import {
  LLM_PORT,
  MATERIAL_REPOSITORY,
  SEARCH_SESSION_REPOSITORY,
  SOURCE_REGISTRY,
  WORK_MATERIAL_REPOSITORY,
} from './discover.tokens.js';
import { notFound } from './http.js';
import { toMaterial } from './material-view.js';

/** 24h 缓存窗口（架构 §9.4）。 */
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
type MaterialSourceSelection = SearchRequest['sources'][number];

/** 前缀化 ID：ss_ + 32hex = 35 字符，落在 CHAR(36)/PrefixedId(≤36) 内。 */
function newSearchId(): string {
  return `ss_${randomUUID().replace(/-/g, '')}`;
}

export type SearchOutcome =
  | { readonly kind: 'hit'; readonly session: SearchSession }
  | { readonly kind: 'accepted'; readonly searchId: string };

@Injectable()
export class DiscoverService {
  constructor(
    @Inject(SEARCH_SESSION_REPOSITORY) private readonly sessions: SearchSessionRepository,
    @Inject(MATERIAL_REPOSITORY) private readonly materials: MaterialRepository,
    @Inject(WORK_MATERIAL_REPOSITORY) private readonly workMaterials: WorkMaterialRepository,
    @Inject(SOURCE_REGISTRY) private readonly registry: SourceRegistry,
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    @Inject(WORK_REPOSITORY) private readonly works: WorkRepository,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  /** POST /discover/search：校验 work 归属 → 缓存命中复验 → 否则建会话 + 进程内异步聚合。 */
  async search(userId: string, input: SearchRequest): Promise<SearchOutcome> {
    // search_session.work_id 有 FK→work 且须属于本人：先经 work 仓储校验（不存在/不属于你→404）。
    const work = await this.works.forUser(userId).findById(input.workId);
    if (work === null) throw notFound('作品不存在或不属于你');

    const repo = this.sessions.forUser(userId);
    const domain = input.domain ?? null;

    const cacheable = input.sources.length === 1 && input.sources[0] === 'recorded';
    if (!input.force && cacheable) {
      const since = new Date(Date.now() - SEARCH_CACHE_TTL_MS);
      const cached = await repo.findCached(input.keyword, domain, since);
      if (cached !== null) {
        const session = await this.tryBuildSession(cached, userId, true);
        // 复验失败（legacy/脏形状）→ 视为未命中，落到下面重跑。
        if (session !== null) {
          await this.analytics.record({
            userId,
            workId: input.workId,
            event: 'search_completed',
            props: {
              searchId: session.id,
              resultCount: session.materials.length,
              partialErrorCount: session.partialErrors.length,
            },
          });
          return { kind: 'hit', session };
        }
      }
    }

    const searchId = newSearchId();
    await repo.insert({ id: searchId, workId: input.workId, keyword: input.keyword, domain });
    // 进程内 fire-and-forget：runSearch 自带兜底，绝不向事件循环抛未处理 rejection。
    void this.runSearch(userId, searchId, input.workId, input.keyword, input.domain, input.sources);
    return { kind: 'accepted', searchId };
  }

  /** GET /discover/search/:id：读持久化会话（轮询）。非法 id 与不存在同样 404（防枚举）。 */
  async getSession(userId: string, id: string): Promise<SearchSession> {
    let row: SearchSessionRow | null;
    try {
      row = await this.sessions.forUser(userId).findById(id);
    } catch (err) {
      if ((err as { code?: string }).code === 'SEARCH_SESSION_ID_INVALID') throw notFound();
      throw err;
    }
    if (row === null) throw notFound();
    return this.buildSession(row, userId, row.cache_hit === 1);
  }

  /**
   * 后台聚合 runner（架构 §9.2/§14）。任何异常都落 failed，绝不静默吞错或谎报 succeeded。
   * 空聚合（源健康但无命中）→ succeeded + 空素材 + saturation null（真实空态，D-08）。
   */
  private async runSearch(
    userId: string,
    searchId: string,
    workId: string,
    keyword: string,
    domain: string | undefined,
    sources: readonly MaterialSourceSelection[],
  ): Promise<void> {
    const repo = this.sessions.forUser(userId);
    const start = Date.now();
    const query =
      domain === undefined ? { keyword, ownerId: userId } : { keyword, domain, ownerId: userId };
    try {
      const agg = await this.registry.aggregate(query, { sourceIds: sources });
      const durationMs = Date.now() - start;
      await this.materials.forUser(userId).upsertExternalMaterials(agg.externalMaterials);

      if (agg.allFailed) {
        await repo.updateResults(searchId, {
          status: 'failed',
          saturation: null,
          blankAngles: [],
          materialIds: [],
          partialErrors: agg.partialErrors,
          durationMs,
          cacheHit: false,
        });
        return;
      }

      await this.analytics.record({
        userId,
        workId,
        event: 'search_completed',
        props: {
          searchId,
          resultCount: agg.materials.length,
          partialErrorCount: agg.partialErrors.length,
        },
      });

      // 空聚合：不挂饱和度（无样本可结论）、不产空白角度（无依据），干净空态而非 partial 噪声。
      if (agg.materials.length === 0) {
        await repo.updateResults(searchId, {
          status: 'succeeded',
          saturation: null,
          blankAngles: [],
          materialIds: [],
          partialErrors: agg.partialErrors,
          durationMs,
          cacheHit: false,
        });
        return;
      }

      const saturation = computeSaturation(agg.materials);
      const partialErrors = [...agg.partialErrors];
      let blankAngles: BlankAngle[] = [];
      try {
        const result = await generateBlankAngles(
          { keyword, ...(domain === undefined ? {} : { domain }), materials: agg.materials },
          this.llm,
        );
        blankAngles = result.data;
      } catch (err) {
        // LLM 不可用/未录制 → 降级 partial：饱和度仍挂载，空白角度缺失明示，绝不伪造（D-08）。
        partialErrors.push({
          source: 'llm:blankAngles',
          code: 'BLANK_ANGLES_UNAVAILABLE',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      await repo.updateResults(searchId, {
        status: 'succeeded',
        saturation,
        blankAngles,
        materialIds: agg.materials.map((m) => m.id),
        partialErrors,
        durationMs,
        cacheHit: false,
      });
    } catch (err) {
      // 兜底：聚合/落库自身异常 → failed（保留已聚合的部分错误明细，便于前端「可手动导入」）。
      await repo
        .updateResults(searchId, {
          status: 'failed',
          saturation: null,
          blankAngles: [],
          materialIds: [],
          partialErrors: [
            {
              source: 'search',
              code: 'SEARCH_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          ],
          durationMs: Date.now() - start,
          cacheHit: false,
        })
        .catch(() => {
          // 落库也失败时无能为力：会话停在 queued，前端轮询超时给错误态。不向事件循环抛错。
        });
    }
  }

  /** 行 → 契约会话（parse 兜底：任何形状漂移在此抛错，不下发非法响应）。 */
  private async buildSession(
    row: SearchSessionRow,
    userId: string,
    cacheHit: boolean,
  ): Promise<SearchSession> {
    return SearchSessionSchema.parse(await this.rawSession(row, userId, cacheHit));
  }

  /** 缓存命中复验：safeParse 失败（legacy/脏形状）→ null，调用方视为未命中重跑。 */
  private async tryBuildSession(
    row: SearchSessionRow,
    userId: string,
    cacheHit: boolean,
  ): Promise<SearchSession | null> {
    const parsed = SearchSessionSchema.safeParse(await this.rawSession(row, userId, cacheHit));
    return parsed.success ? parsed.data : null;
  }

  /**
   * 组装契约输入形状：素材按 material_ids 原序回填（聚合序），collected 按会话所属 work 叠加。
   * saturation/blankAngles/partialErrors 直接取 JSON 列（已解析），由 SearchSessionSchema 在边界复验值域。
   */
  private async rawSession(
    row: SearchSessionRow,
    userId: string,
    cacheHit: boolean,
  ): Promise<unknown> {
    const rows = await this.materials.forUser(userId).findByIds(row.material_ids);
    const collected = new Set(
      await this.workMaterials.forUser(userId).listMaterialIdsForWork(row.work_id),
    );
    const byId = new Map<string, MaterialRow>(rows.map((r) => [r.id, r]));
    // 保持聚合序；仅回填当前仍可见的素材（被软删/转移的 id 自然缺席，不谎报）。
    const materials = row.material_ids
      .map((id) => byId.get(id))
      .filter((r): r is MaterialRow => r !== undefined)
      .map((r) => toMaterial(r, collected.has(r.id)));

    return {
      id: row.id,
      keyword: row.keyword,
      status: row.status,
      materials,
      saturation: row.saturation,
      blankAngles: row.blank_angles,
      partialErrors: row.partial_errors,
      cacheHit,
      createdAt: toRfc3339(row.created_at),
    };
  }
}
