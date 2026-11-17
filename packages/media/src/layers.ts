import { createHash } from 'node:crypto';
import type { LayerKind, Script } from '@knowstudio/contracts';

export interface TimelineEntry {
  readonly lineId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface LayerPlan {
  readonly kind: LayerKind;
  readonly version: number;
  readonly inputFingerprint: string;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly durationMs: number;
  readonly meta: Record<string, unknown>;
}

export function fingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

export function scriptLines(script: Script): readonly { id: string; text: string }[] {
  return script.sections.flatMap((section) =>
    section.lines.map((line) => ({ id: line.id, text: line.text })),
  );
}

export function timelineOf(script: Script): readonly TimelineEntry[] {
  let cursor = 0;
  return scriptLines(script).map((line) => {
    const durationMs = Math.max(1_200, Math.round(([...line.text].length / 4.2) * 1000));
    const entry = {
      lineId: line.id,
      startMs: cursor,
      endMs: cursor + durationMs,
      text: line.text,
    };
    cursor += durationMs;
    return entry;
  });
}

export function formatVttTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function slidesSvg(script: Script, orient: 'vertical' | 'horizontal'): string {
  const width = orient === 'vertical' ? 1080 : 1920;
  const height = orient === 'vertical' ? 1920 : 1080;
  const lines = scriptLines(script);
  const items = lines
    .map(
      (line, index) =>
        `<text x="96" y="${300 + index * 104}" font-size="58" fill="#eef1f8">${escapeXml(`${index + 1}. ${line.text}`)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#101828"/>
  <rect x="64" y="128" width="160" height="12" fill="#2dd4bf"/>
  <text x="96" y="220" font-size="74" fill="#2dd4bf">知影工坊</text>
  ${items}
</svg>`;
}

export function coverSvg(input: {
  title: string;
  platformId: string;
  brandColor: string;
  orient: 'vertical' | 'horizontal';
}): string {
  const width = input.orient === 'vertical' ? 1080 : 1920;
  const height = input.orient === 'vertical' ? 1920 : 1080;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#101828"/>
  <rect x="72" y="96" width="12" height="${height - 192}" fill="${escapeXml(input.brandColor)}"/>
  <text x="112" y="160" font-size="32" fill="${escapeXml(input.brandColor)}">${escapeXml(input.platformId.toUpperCase())}</text>
  <foreignObject x="112" y="240" width="${width - 224}" height="${height - 360}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:'Microsoft YaHei',sans-serif;font-size:${input.orient === 'vertical' ? 86 : 72}px;line-height:1.18;color:#fff;word-break:break-all">${escapeXml(input.title)}</div>
  </foreignObject>
</svg>`;
}

export function buildLayerPlan(
  script: Script,
  input: { templateId: string; voiceId: string; speed: number; orient: 'vertical' | 'horizontal' },
): readonly LayerPlan[] {
  const timeline = timelineOf(script);
  const durationMs = timeline.at(-1)?.endMs ?? 1_200;
  const identity = { scriptVersion: script.version, ...input };
  const baseFingerprint = fingerprint(identity);
  const vtt = [
    'WEBVTT',
    '',
    ...timeline.flatMap((entry, index) => [
      String(index + 1),
      `${formatVttTime(entry.startMs)} --> ${formatVttTime(entry.endMs)}`,
      entry.text,
      '',
    ]),
  ].join('\n');
  const svg = slidesSvg(script, input.orient);
  const timelineJson = JSON.stringify({ durationMs, entries: timeline }, null, 2);
  return [
    {
      kind: 'slides' as const,
      version: script.version,
      inputFingerprint: fingerprint({ ...identity, kind: 'slides' }),
      contentHash: fingerprint(svg),
      bytes: new TextEncoder().encode(svg),
      contentType: 'image/svg+xml',
      durationMs,
      meta: { templateId: input.templateId, orient: input.orient },
    },
    {
      kind: 'subtitles' as const,
      version: script.version,
      inputFingerprint: fingerprint({ ...identity, kind: 'subtitles' }),
      contentHash: fingerprint(vtt),
      bytes: new TextEncoder().encode(vtt),
      contentType: 'text/vtt',
      durationMs,
      meta: {},
    },
    {
      kind: 'timeline' as const,
      version: script.version,
      inputFingerprint: fingerprint({ ...identity, kind: 'timeline' }),
      contentHash: fingerprint(timelineJson),
      bytes: new TextEncoder().encode(timelineJson),
      contentType: 'application/json',
      durationMs,
      meta: {},
    },
  ].map((layer): LayerPlan => ({
    ...layer,
    version: script.version,
    inputFingerprint: baseFingerprint,
  }));
}
