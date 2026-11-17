/**
 * SourceAdapter 编排框架（T-17 / 架构 §9.2 / §14）。
 *
 * 职责：注册表 + 并行编排 + 超时预算切分 + 熔断 + partial 结果合并。
 * 这是 provider-agnostic 的真实编排逻辑——录制适配器与真实供应商适配器都跑在它上面，
 * 故 D-08「真实并行聚合 + 五态」不是靠适配器造假，而是靠本框架的真实降级语义。
 *
 * 关键不变量：
 *  - 单源超时/失败 → 该列 partial/error，其余列正常（SPEC §6.1 / AC-D1），绝不串行等待；
 *  - 全部源失败 → allFailed=true，上层给「聚合失败，可手动导入」（架构 §9.3）；
 *  - empty ≠ error：源健康但无命中是 empty（前端空态），不是故障（D-08 要求真实空态）。
 */
import type { Material } from '@knowstudio/contracts';
import type { PartialResult, SourceAdapter, SourceKind, SourceQuery } from '../ports.js';

/** 超时预算切分（架构 §14）：总预算 20s，知识 8s / 热点 6s / 同行 6s。 */
export const DEFAULT_SOURCE_BUDGET_MS: Readonly<Record<SourceKind, number>> = {
  knowledge: 8000,
  hot: 6000,
  peer: 6000,
};

/** 熔断参数（架构 §9.2）：连续 5 次失败 → 熔断 60s。 */
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_OPEN_MS = 60_000;

/** 时钟注入：熔断计时用可注入时钟，测试不必依赖真实 Date.now（确定性）。 */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

/** 单源编排产出（供上层构造 SearchSession.partialErrors 与每列状态）。 */
export interface SourceOutcome {
  id: string;
  kind: SourceKind;
  status: PartialResult<Material[]>['status'];
  latencyMs: number;
}

export interface AggregatedSearch {
  /** 跨源去重后的素材（按 id）。 */
  materials: Material[];
  /** 失败/部分源的错误清单，形状对齐 SearchSession.partialErrors。 */
  partialErrors: { source: string; code: string; message: string }[];
  perSource: SourceOutcome[];
  /** 全部源失败（架构 §9.3「聚合失败，可手动导入」）。无适配器时为 false（空态而非故障）。 */
  allFailed: boolean;
}

export interface AggregateOptions {
  budgetMs?: Partial<Record<SourceKind, number>>;
}

/** 给单源调用套超时预算：超时→error(SOURCE_TIMEOUT)，适配器自身 reject→error(SOURCE_FAILED)。 */
async function runWithBudget(
  adapter: SourceAdapter,
  q: SourceQuery,
  budgetMs: number,
): Promise<PartialResult<Material[]>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PartialResult<Material[]>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: 'error',
          data: [],
          error: { code: 'SOURCE_TIMEOUT', message: `源 ${adapter.id} 超出预算 ${budgetMs}ms` },
          latencyMs: budgetMs,
        }),
      budgetMs,
    );
  });
  try {
    return await Promise.race([adapter.search(q, budgetMs), timeout]);
  } catch (err) {
    return {
      status: 'error',
      data: [],
      error: {
        code: 'SOURCE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
      latencyMs: 0,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class SourceRegistry {
  private readonly adapters: SourceAdapter[] = [];
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly clock: Clock = systemClock) {}

  register(adapter: SourceAdapter): void {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      throw new Error(`SourceAdapter id 重复注册：${adapter.id}`);
    }
    this.adapters.push(adapter);
  }

  /** 并行编排所有已注册适配器，各自预算超时 + 熔断，合并去重素材与 partialErrors。 */
  async aggregate(q: SourceQuery, opts: AggregateOptions = {}): Promise<AggregatedSearch> {
    const budget = { ...DEFAULT_SOURCE_BUDGET_MS, ...opts.budgetMs };

    const outcomes = await Promise.all(
      this.adapters.map(async (adapter) => {
        const result = await this.runOne(adapter, q, budget[adapter.kind]);
        return { adapter, result };
      }),
    );

    const materialsById = new Map<string, Material>();
    const partialErrors: AggregatedSearch['partialErrors'] = [];
    const perSource: SourceOutcome[] = [];

    for (const { adapter, result } of outcomes) {
      perSource.push({
        id: adapter.id,
        kind: adapter.kind,
        status: result.status,
        latencyMs: result.latencyMs,
      });
      for (const m of result.data) materialsById.set(m.id, m);
      if (result.error) {
        partialErrors.push({
          source: adapter.id,
          code: result.error.code,
          message: result.error.message,
        });
      }
    }

    const allFailed =
      outcomes.length > 0 && outcomes.every((o) => o.result.status === 'error');

    return { materials: [...materialsById.values()], partialErrors, perSource, allFailed };
  }

  /** 单源 + 熔断：开路直接短路；半开/闭路真跑，按结果更新熔断状态。 */
  private async runOne(
    adapter: SourceAdapter,
    q: SourceQuery,
    budgetMs: number,
  ): Promise<PartialResult<Material[]>> {
    const now = this.clock.now();
    const breaker = this.breakers.get(adapter.id) ?? { consecutiveFailures: 0, openedAt: null };

    if (breaker.openedAt !== null && now - breaker.openedAt < CIRCUIT_OPEN_MS) {
      return {
        status: 'error',
        data: [],
        error: { code: 'CIRCUIT_OPEN', message: `源 ${adapter.id} 熔断中（${CIRCUIT_OPEN_MS}ms）` },
        latencyMs: 0,
      };
    }

    const result = await runWithBudget(adapter, q, budgetMs);

    if (result.status === 'error') {
      breaker.consecutiveFailures += 1;
      if (breaker.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) breaker.openedAt = now;
    } else {
      // ok/empty/partial 都算源健康：重置计数；半开成功则闭路。
      breaker.consecutiveFailures = 0;
      breaker.openedAt = null;
    }
    this.breakers.set(adapter.id, breaker);
    return result;
  }
}