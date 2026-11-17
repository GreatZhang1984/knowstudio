import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TimelineEntry } from './layers.js';
import { formatVttTime } from './layers.js';

export interface RenderVideoInput {
  readonly audio: Uint8Array;
  readonly timeline: readonly TimelineEntry[];
  readonly quality: 'draft' | 'hd' | 'uhd4k';
  readonly orient: 'vertical' | 'horizontal';
  readonly maxDurationMs?: number;
}

export function clipTimeline(
  timeline: readonly TimelineEntry[],
  maxDurationMs: number | null,
): readonly TimelineEntry[] {
  if (maxDurationMs === null) return [...timeline];
  return timeline
    .filter((entry) => entry.startMs < maxDurationMs)
    .map((entry) => ({ ...entry, endMs: Math.min(entry.endMs, maxDurationMs) }));
}

function resolution(
  quality: RenderVideoInput['quality'],
  orient: RenderVideoInput['orient'],
): string {
  if (quality === 'uhd4k') return orient === 'vertical' ? '2160x3840' : '3840x2160';
  if (quality === 'hd') return orient === 'vertical' ? '1080x1920' : '1920x1080';
  return orient === 'vertical' ? '480x854' : '854x480';
}

function durationSeconds(timeline: readonly TimelineEntry[]): number {
  return Math.max(1, ((timeline.at(-1)?.endMs ?? 1_200) + 300) / 1000);
}

function vttOf(timeline: readonly TimelineEntry[]): string {
  return [
    'WEBVTT',
    '',
    ...timeline.flatMap((entry, index) => [
      String(index + 1),
      `${formatVttTime(entry.startMs)} --> ${formatVttTime(entry.endMs)}`,
      entry.text,
      '',
    ]),
  ].join('\n');
}

export async function renderVideo(input: RenderVideoInput): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'knowstudio-render-'));
  const audioFile = join(dir, 'audio.wav');
  const subtitleFile = join(dir, 'subtitles.vtt');
  const outputFile = join(dir, 'output.mp4');
  const timeline =
    input.maxDurationMs === undefined
      ? input.timeline
      : clipTimeline(input.timeline, input.maxDurationMs);
  await writeFile(audioFile, input.audio);
  await writeFile(subtitleFile, vttOf(timeline), 'utf8');
  const size = resolution(input.quality, input.orient);
  const duration = durationSeconds(timeline);
  const { spawn } = await import('node:child_process');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    audioFile,
    ...(input.maxDurationMs === undefined ? [] : ['-t', (input.maxDurationMs / 1000).toFixed(3)]),
    '-f',
    'lavfi',
    '-i',
    `color=c=0x101828:s=${size}:d=${duration.toFixed(3)}:r=25`,
    '-shortest',
    '-vf',
    "subtitles=subtitles.vtt:force_style='FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&HFFFFFFFF'",
    '-c:v',
    input.quality === 'draft' ? 'libx264' : 'libx264',
    '-preset',
    input.quality === 'draft' ? 'veryfast' : 'medium',
    '-crf',
    input.quality === 'draft' ? '30' : '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    outputFile,
  ];
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.env['FFMPEG_PATH'] ?? 'ffmpeg', args, {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`FFMPEG_FAILED_${code ?? 'unknown'}: ${stderr.slice(-1000)}`));
      });
    });
    return new Uint8Array(await readFile(outputFile));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
