/**
 * 录制回放素材适配器（T-18 的 dev 切片 / plan §6.1·§7.1 的 VCR 口径）。
 *
 * 为什么 dev 用录制而非真实源：
 *  - 无知乎/抖音/B站等真实源凭证（TR-1 高风险），架构指定 dev/CI 用录制回放保证确定性与零成本；
 *  - 真实供应商适配器落地后实现同一 SourceAdapter 端口，本框架与上层零改动即可切换。
 *
 * 守 D-08 / AC-D1 的关键设计（这不是「恒定种子」缺陷的复发）：
 *  - **按规范化关键词查录制**：输入被真实读取，不同关键词命中不同录制；
 *  - **未录制关键词 → 诚实 empty**（源健康但无数据），绝不回退到某个默认种子；
 *  - 录制数据经 mapRecordedMaterial 映射到**冻结契约 Material 形状**，不是直接 dump 原型 fixture。
 *
 * 边界：本包不 import seed.json（保持纯净可测）；录制store 由组合根（apps/api）注入。
 */
import type { LicenseState, Material, MaterialType } from '@knowstudio/contracts';
import type { PartialResult, SourceAdapter, SourceKind, SourceQuery } from '../ports.js';

/**
 * 规范化关键词（架构 §9.4 缓存 key 的 normKeyword）：
 * 去首尾空白 + NFKC 兼容归一 + 小写 + 折叠内部空白。让「费曼学习法」「 费曼学习法 」命中同一录制。
 */
export function normalizeKeyword(keyword: string): string {
  return keyword.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

/** 录制素材种子（原型 fixture 形状的最小子集；tags/meta/licenseEvidence 等不进 Material 契约）。 */
export interface RecordedMaterialSeed {
  key: string;
  type: MaterialType;
  title: string;
  source: string;
  license: LicenseState;
  bodyText?: string;
  url?: string | null;
  /**
   * 显式 id 覆盖（可选）。dev 组合根用真实 DB 素材 id（seedId('mat',key)）注入，
   * 使搜索结果的 material.id 与库内行一致，收藏/引用无需二次映射。缺省回退 mat_<key>（纯单测用）。
   */
  id?: string;
}

/**
 *  fixture 素材 → 契约 Material。
 *  - id：优先用种子显式 id（dev 组合根注入真实 DB id）；缺省 mat_<key>（纯单测稳定 id）。
 *    入库时由 DB 层赋规范 id（T-21）；dev 录制直接复用库内 id，收藏/引用无需二次映射。
 *  - summary：取 bodyText（原型用 bodyText 承载摘要）。
 *  - url：fixture 无 url → null（契约 HttpUrl.nullable）；录制若带 url 必须是 http(s)，加载时校验。
 *  - collected：恒 false——真实收藏态由 work_material 在 API 层叠加，适配器不谎报收藏（D-04 同源精神）。
 */
export function mapRecordedMaterial(seed: RecordedMaterialSeed): Material {
  return {
    id: seed.id ?? `mat_${seed.key}`,
    type: seed.type,
    title: seed.title,
    summary: seed.bodyText ?? '',
    source: seed.source,
    url: seed.url ?? null,
    license: seed.license,
    collected: false,
  };
}

/** 一条关键词录制（已映射为契约形状）。 */
export interface RecordedSearch {
  keyword: string;
  materials: Material[];
}

/** 录制store：规范化关键词 → 录制。 */
export type RecordingStore = ReadonlyMap<string, RecordedSearch>;

/** 由种子构建录制store（组合根用 seed.json 调它；测试用内联种子）。 */
export function buildRecordingStore(
  seeds: readonly { keyword: string; materials: readonly RecordedMaterialSeed[] }[],
): RecordingStore {
  const store = new Map<string, RecordedSearch>();
  for (const seed of seeds) {
    const norm = normalizeKeyword(seed.keyword);
    store.set(norm, {
      keyword: seed.keyword,
      materials: seed.materials.map(mapRecordedMaterial),
    });
  }
  return store;
}

/**
 * 录制回放 SourceAdapter：一个实例负责一类源（knowledge/hot/peer），
 * 从同一关键词录制里按 kind 过滤素材。未命中录制 → empty（诚实空态）。
 */
export class RecordedSourceAdapter implements SourceAdapter {
  readonly sourceId = 'recorded';
  constructor(
    readonly id: string,
    readonly kind: SourceKind,
    private readonly store: RecordingStore,
  ) {}

  // budgetMs 由编排框架统一强制（runWithBudget）；录制是内存查找，瞬时返回，故此处不重复计时。
  async search(q: SourceQuery, _budgetMs: number): Promise<PartialResult<Material[]>> {
    const start = Date.now();
    const recorded = this.store.get(normalizeKeyword(q.keyword));
    const materials = (recorded?.materials ?? []).filter((m) => m.type === this.kind);
    const latencyMs = Date.now() - start;

    // 无录制 或 该类无素材 → empty（源健康但无命中），不是 error（D-08 真实空态）。
    if (materials.length === 0) {
      return { status: 'empty', data: [], latencyMs };
    }
    return { status: 'ok', data: materials, latencyMs };
  }
}

/** 便捷装配：为三类源各建一个录制适配器（共享同一 store）。 */
export function recordedSourceAdapters(store: RecordingStore): SourceAdapter[] {
  return [
    new RecordedSourceAdapter('recorded:knowledge', 'knowledge', store),
    new RecordedSourceAdapter('recorded:hot', 'hot', store),
    new RecordedSourceAdapter('recorded:peer', 'peer', store),
  ];
}
