export interface PlagiarismHit {
  readonly sourceIndex: number;
  readonly lineIndex: number;
  readonly matchedText: string;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 朴素最长连续命中。P0 文案几百字 × 十条素材摘要，双指针足够，无需后缀自动机。 */
export function findPlagiarism(
  lines: readonly string[],
  sources: readonly string[],
  threshold = 30,
): PlagiarismHit[] {
  const hits: PlagiarismHit[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const normalizedSource = normalize(source);
    for (const [lineIndex, rawLine] of lines.entries()) {
      const line = normalize(rawLine);
      let best = '';
      for (let start = 0; start < line.length; start += 1) {
        for (let end = line.length; end > start + best.length; end -= 1) {
          const part = line.slice(start, end);
          if (part.length < threshold) break;
          if (normalizedSource.includes(part) && part.length > best.length) best = part;
        }
      }
      if (best.length >= threshold) hits.push({ sourceIndex, lineIndex, matchedText: best });
    }
  }
  return hits;
}
