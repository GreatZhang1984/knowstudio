import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SynthesizeAudioInput {
  readonly text: string;
  readonly voiceId: string;
  readonly speed: number;
}

function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function fallbackTone(text: string): Uint8Array {
  const sampleRate = 24_000;
  const seconds = Math.max(1, [...text].length / 4.2);
  const samples = Math.ceil(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const frequency = 180 + (i % 12) * 35;
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.08;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return new Uint8Array(Buffer.concat([wavHeader(data.byteLength, sampleRate), data]));
}

/** dev 默认使用 Windows SAPI；不可用时退化为低音量提示音，保证渲染链路可运行。 */
export async function synthesizeAudio(input: SynthesizeAudioInput): Promise<Uint8Array> {
  if (process.platform !== 'win32') return fallbackTone(input.text);
  const dir = await mkdtemp(join(tmpdir(), 'knowstudio-tts-'));
  const wav = join(dir, 'voice.wav');
  const escaped = input.text.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$synthesizer.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')`,
    `$synthesizer.Rate = ${Math.round((input.speed - 1) * 4)}`,
    `$synthesizer.Speak('${escaped}')`,
    '$synthesizer.Dispose()',
  ].join('; ');
  try {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`SAPI_TTS_FAILED_${code ?? 'unknown'}`));
      });
    });
    return new Uint8Array(await readFile(wav));
  } catch {
    return fallbackTone(input.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
