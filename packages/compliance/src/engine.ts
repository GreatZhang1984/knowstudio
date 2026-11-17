import type {
  ComplianceItem,
  ComplianceKind,
  MaterialType,
  WorkTruthSnapshot,
} from '@knowstudio/contracts';
import { complianceFingerprint } from '@knowstudio/domain';

export interface ComplianceMaterial {
  readonly materialId: string;
  readonly type: MaterialType;
  readonly title: string;
  readonly license: 'cleared' | 'restricted' | 'unknown';
  readonly evidenceExpiresAt: string | null;
  readonly bodyText: string | null;
  readonly usedIn: readonly { target: string; lineId?: string }[];
}

export interface ComplianceScriptLine {
  readonly lineId: string;
  readonly text: string;
}

export interface ComplianceInput {
  readonly snapshot: WorkTruthSnapshot;
  readonly materials: readonly ComplianceMaterial[];
  readonly scriptLines: readonly ComplianceScriptLine[];
  readonly bannedPatterns: readonly string[];
  readonly now: string;
}

export interface BuiltComplianceReport {
  readonly items: readonly ComplianceItem[];
  readonly blockingCount: number;
  readonly warnCount: number;
  readonly fingerprint: string;
}

const OFL_FONTS = new Set([
  '思源黑体',
  '思源宋体',
  'Source Han Sans',
  'Source Han Serif',
  'Noto Sans SC',
  'Noto Serif SC',
]);

interface AhoNode {
  readonly children: Map<string, number>;
  failure: number;
  readonly output: string[];
}

/** 小型 Aho-Corasick：敏感词/平台受限词一次扫描完成多模匹配。 */
export function findTerms(text: string, patterns: readonly string[]): string[] {
  const terms = [...new Set(patterns.filter((term) => term.length > 0))];
  if (terms.length === 0) return [];
  const nodes: AhoNode[] = [{ children: new Map(), failure: 0, output: [] }];
  for (const term of terms) {
    let current = 0;
    for (const ch of term) {
      let next = nodes[current]!.children.get(ch);
      if (next === undefined) {
        next = nodes.length;
        nodes.push({ children: new Map(), failure: 0, output: [] });
        nodes[current]!.children.set(ch, next);
      }
      current = next;
    }
    nodes[current]!.output.push(term);
  }

  const queue = [...nodes[0]!.children.values()];
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]!;
    for (const [ch, child] of nodes[state]!.children) {
      queue.push(child);
      let failure = nodes[state]!.failure;
      while (failure !== 0 && !nodes[failure]!.children.has(ch)) failure = nodes[failure]!.failure;
      const fallback = nodes[failure]!.children.get(ch);
      nodes[child]!.failure = fallback === child ? 0 : fallback ?? 0;
      nodes[child]!.output.push(...nodes[nodes[child]!.failure]!.output);
    }
  }

  const hits = new Set<string>();
  let state = 0;
  for (const ch of text) {
    while (state !== 0 && !nodes[state]!.children.has(ch)) state = nodes[state]!.failure;
    state = nodes[state]!.children.get(ch) ?? 0;
    for (const hit of nodes[state]!.output) hits.add(hit);
  }
  return [...hits].sort();
}

function evidenceActive(material: ComplianceMaterial, now: string): boolean {
  return material.evidenceExpiresAt === null || material.evidenceExpiresAt > now;
}

function usable(material: ComplianceMaterial, now: string): boolean {
  return material.license === 'cleared' && evidenceActive(material, now);
}

function itemOf(
  kind: ComplianceKind,
  materials: readonly ComplianceMaterial[],
  detail: string,
  blocking: boolean,
  lineId?: string,
): ComplianceItem {
  return {
    kind,
    status: blocking ? 'block' : 'pass',
    detail,
    blocking,
    materialIds: materials.map((material) => material.materialId),
    ...(lineId === undefined ? {} : { lineId }),
    fixHint: blocking ? fixHintFor(kind) : undefined,
  };
}

function fixHintFor(kind: ComplianceKind): string {
  if (kind === 'content') return '移除引用素材，或改写命中文案行后重新检查。';
  if (kind === 'music') return '替换音乐素材，或上传未过期的商用授权凭证。';
  if (kind === 'font') return '替换字体/模板，或补充 OFL 商用授权凭证。';
  return '替换图片素材，移除引用，或上传商用授权凭证。';
}

function summarize(materials: readonly ComplianceMaterial[]): string {
  return materials.map((material) => material.title).join('、');
}

function normalize(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:]/gu, '');
}

function copiedLine(
  line: ComplianceScriptLine,
  material: ComplianceMaterial,
): boolean {
  const source = normalize(material.bodyText ?? '');
  const target = normalize(line.text);
  if (source.length < 30 || target.length < 30) return false;
  return source.includes(target) || target.includes(source);
}

export function buildComplianceReport(input: ComplianceInput): BuiltComplianceReport {
  const { snapshot, materials, scriptLines, bannedPatterns, now } = input;
  const image = materials.filter((material) => material.type === 'image');
  const music = materials.filter((material) => material.type === 'music');
  const font = materials.filter((material) => material.type === 'font');
  const contentMaterials = materials.filter(
    (material) => material.type !== 'image' && material.type !== 'music' && material.type !== 'font',
  );

  const badImage = image.filter((material) => !usable(material, now));
  const badMusic = music.filter((material) => !usable(material, now));
  const bgmEvidenceExpired =
    snapshot.bgm !== null &&
    (snapshot.bgm.evidenceExpiresAt === null || snapshot.bgm.evidenceExpiresAt <= now);
  const badBgmMaterial =
    snapshot.bgm !== null && bgmEvidenceExpired
      ? {
          materialId: snapshot.bgm.trackId,
          type: 'music' as const,
          title: `背景音乐 ${snapshot.bgm.trackId}`,
          license: 'unknown' as const,
          evidenceExpiresAt: null,
          bodyText: null,
          usedIn: [],
        }
      : null;
  const blockedMusic = [...badMusic, ...(badBgmMaterial === null ? [] : [badBgmMaterial])];
  const badFont = font.filter((material) => !usable(material, now));
  const badContentMaterials = contentMaterials.filter((material) => !usable(material, now));
  const copied = scriptLines.filter((line) =>
    materials.some((material) => copiedLine(line, material)),
  );
  const joinedText = [
    ...scriptLines.map((line) => line.text),
    ...snapshot.derivatives.flatMap((derivative) => [derivative.title, ...derivative.tags]),
  ].join('\n');
  const terms = findTerms(joinedText, bannedPatterns);

  const templateFont = snapshot.template?.fontFamily ?? null;
  const fontBlocked =
    badFont.length > 0 || (templateFont !== null && !OFL_FONTS.has(templateFont));
  const contentBlocked =
    badContentMaterials.length > 0 || copied.length > 0 || terms.length > 0;

  const items: ComplianceItem[] = [
    itemOf(
      'image',
      badImage,
      badImage.length === 0 ? '引用图片均可商用。' : `图片授权不可用：${summarize(badImage)}`,
      badImage.length > 0,
    ),
    itemOf(
      'music',
      blockedMusic,
      badMusic.length === 0 && !bgmEvidenceExpired
        ? '引用音乐均可商用。'
        : `音乐授权不可用：${[
            ...(badMusic.length > 0 ? [summarize(badMusic)] : []),
            ...(badBgmMaterial === null ? [] : [badBgmMaterial.title]),
          ].join('、')}`,
      blockedMusic.length > 0,
    ),
    itemOf(
      'font',
      badFont,
      fontBlocked
        ? `字体授权不可用：${summarize(badFont)}${templateFont === null ? '' : `；模板字体 ${templateFont}`}`
        : `字体可商用${templateFont === null ? '' : `（${templateFont}）`}。`,
      fontBlocked,
    ),
    itemOf(
      'content',
      badContentMaterials,
      contentBlocked
        ? [
            ...(badContentMaterials.length > 0
              ? [`素材授权不可用：${summarize(badContentMaterials)}`]
              : []),
            ...(copied.length > 0 ? [`疑似原文搬运：${copied.length} 行`] : []),
            ...(terms.length > 0 ? [`受限词：${terms.join('、')}`] : []),
          ].join('；')
        : '文案与平台派生内容未命中受限词或原文搬运。',
      contentBlocked,
      copied.length === 1 ? copied[0]!.lineId : undefined,
    ),
  ];

  return {
    items,
    blockingCount: items.filter((item) => item.blocking).length,
    warnCount: items.filter((item): item is ComplianceItem & { status: 'warn' } => item.status === 'warn').length,
    fingerprint: complianceFingerprint(snapshot),
  };
}
