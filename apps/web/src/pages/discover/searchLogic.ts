import type {
  ApiError,
  BlankAngle,
  LicenseState,
  Material,
  MaterialSource,
  MaterialSourceId,
  MaterialType,
  PlatformId,
  Saturation,
  SearchSession,
} from '@knowstudio/contracts';
import type { PartialItem } from '@knowstudio/ui';

export type SearchMaterialKind = Extract<MaterialType, 'knowledge' | 'hot' | 'peer'>;

export interface MaterialGroup {
  readonly kind: SearchMaterialKind;
  readonly label: string;
  readonly description: string;
  readonly materials: readonly Material[];
}

export type SearchViewState =
  | { readonly kind: 'initial' }
  | { readonly kind: 'loading'; readonly session: SearchSession | null }
  | { readonly kind: 'empty'; readonly session: SearchSession }
  | { readonly kind: 'error'; readonly session: SearchSession | null }
  | {
      readonly kind: 'success';
      readonly session: SearchSession;
      readonly partial: boolean;
    };

export interface SearchStateInput {
  readonly session?: SearchSession | null;
  readonly submitting?: boolean;
  readonly error?: unknown;
  readonly timedOut?: boolean;
}

export function normalizeSearchTerm(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

export function isSameKeyword(a: string, b: string): boolean {
  return normalizeSearchTerm(a) === normalizeSearchTerm(b);
}

const SOURCE_ORDER: readonly MaterialSourceId[] = ['recorded', 'web_search', 'obsidian'];

export function normalizeSourceSelection(
  value: readonly string[],
  sources: readonly MaterialSource[],
): MaterialSourceId[] {
  const available = new Set(
    sources.filter((source) => source.configured).map((source) => source.id as MaterialSourceId),
  );
  const selected = SOURCE_ORDER.filter((id) => available.has(id) && value.includes(id));
  return selected.length === 0 ? (['recorded'] as MaterialSourceId[]) : selected;
}

export function isSameSourceSelection(a: readonly string[], b: readonly string[]): boolean {
  const normalize = (value: readonly string[]): string[] => {
    const selected = SOURCE_ORDER.filter((id) => value.includes(id));
    return selected.length === 0 ? (['recorded'] as MaterialSourceId[]) : selected;
  };
  return normalize(a).join('|') === normalize(b).join('|');
}

export function searchInputIssue(keyword: string, domain: string): string | undefined {
  const trimmedKeyword = keyword.trim();
  if (trimmedKeyword.length === 0) return '先输入关键词或领域';
  if (trimmedKeyword.length > 40) return '关键词最多 40 字';
  if (domain.trim().length > 40) return '领域偏好最多 40 字';
  return undefined;
}

export function searchViewState(input: SearchStateInput): SearchViewState {
  const { session = null, submitting = false, error, timedOut = false } = input;
  if (error != null || session?.status === 'failed' || session?.status === 'canceled' || timedOut) {
    return { kind: 'error', session };
  }
  if (submitting || session?.status === 'queued' || session?.status === 'running') {
    return { kind: 'loading', session };
  }
  if (session == null) return { kind: 'initial' };
  if (session.materials.length === 0) return { kind: 'empty', session };
  return { kind: 'success', session, partial: session.partialErrors.length > 0 };
}

export function materialGroups(materials: readonly Material[]): readonly MaterialGroup[] {
  const definitions: readonly [SearchMaterialKind, string, string][] = [
    ['knowledge', '知识素材', '概念、机制与可引用观点'],
    ['hot', '热点角度', '正在上升的话题入口'],
    ['peer', '同行爆款', '已验证的表达与结构'],
  ];
  return definitions.map(([kind, label, description]) => ({
    kind,
    label,
    description,
    materials: materials.filter((m) => m.type === kind),
  }));
}

const SATURATION_LABEL: Record<Saturation['level'], string> = {
  blue_ocean: '蓝海',
  has_room: '有空间',
  saturated: '讲的人很多',
};

const SATURATION_TONE: Record<Saturation['level'], string> = {
  blue_ocean: 'var(--teal)',
  has_room: 'var(--amber)',
  saturated: 'var(--coral)',
};

const LICENSE_LABEL: Record<LicenseState, string> = {
  cleared: '可商用',
  restricted: '需授权',
  unknown: '授权未知',
};

const PLATFORM_LABEL: Record<PlatformId, string> = {
  douyin: '抖音',
  sph: '视频号',
  bili: 'B站',
  xhs: '小红书',
};

export function saturationLabel(level: Saturation['level']): string {
  return SATURATION_LABEL[level];
}

export function saturationColor(level: Saturation['level']): string {
  return SATURATION_TONE[level];
}

export function licenseLabel(license: LicenseState): string {
  return LICENSE_LABEL[license] ?? LICENSE_LABEL.unknown;
}

export function platformLabels(platforms: readonly PlatformId[]): string[] {
  return platforms.map((platform) => PLATFORM_LABEL[platform] ?? platform);
}

export function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function collectedMaterials(session: SearchSession | null | undefined): readonly Material[] {
  return session?.materials.filter((m) => m.collected) ?? [];
}

export function withMaterialCollected(
  session: SearchSession,
  materialId: string,
  collected: boolean,
): SearchSession {
  return {
    ...session,
    materials: session.materials.map((m) => (m.id === materialId ? { ...m, collected } : m)),
  };
}

export function partialItemsOf(session: SearchSession): readonly PartialItem[] {
  return session.partialErrors.map((failure) => ({
    key: `${failure.source}:${failure.code}`,
    label: failure.source,
    status: 'failed',
    detail: failure.message,
  }));
}

export function blankAngleTarget(angle: BlankAngle): string {
  return `/discover/topics?angle=${encodeURIComponent(angle.label)}`;
}

export function topicsTarget(session: SearchSession, angle?: BlankAngle): string {
  const materialIds = session.materials.filter((m) => m.collected).map((m) => m.id);
  const params = new URLSearchParams();
  if (materialIds.length > 0) params.set('materials', materialIds.join(','));
  if (angle != null) params.set('angle', angle.label);
  const query = params.toString();
  return query === '' ? '/discover/topics' : `/discover/topics?${query}`;
}

export function apiErrorOf(error: unknown): ApiError | null {
  if (typeof error === 'object' && error !== null && 'apiError' in error) {
    const candidate = (error as { apiError?: unknown }).apiError;
    if (candidate != null) return candidate as ApiError;
  }
  return null;
}
