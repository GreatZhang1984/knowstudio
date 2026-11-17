import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@knowstudio/contracts';
import { resolveErrorUi } from '../src/state/error-map';
import { bodyOrMessage } from '../src/state/format';
import { ALL_FIXTURES, FIXED_TIME, errorFixture } from './state-fixtures';

/**
 * 验收③：不存在按 message 分支的代码路径（架构 §10.2）。
 *
 * 两条独立证据：
 * A. 行为证据 —— 同一个 code + 同一份 details，把 message 换成各种「看起来像别的错误」
 *    的对抗文本，呈现级别/色调/标题/恢复动作/保留输入/gate 必须一字不变。
 * B. 源码证据 —— 扫描 src/state 全部文件，禁止对 message 做比较/正则/switch/if 判定，
 *    也禁止另立错误码枚举。
 */

const STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/state');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.tsx?$/.test(entry.name) && statSync(abs).isFile()) out.push(abs);
  }
  return out;
}

const FILES = sourceFiles(STATE_DIR);

/** 对 message 做内容判定的写法，一律禁止。 */
const MESSAGE_BRANCH_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'message 参与相等比较', re: /\.message\s*(===|!==|==|!=)/ },
  { name: 'message 参与相等比较（反向）', re: /(===|!==|==|!=)\s*[\w.]*\.message\b/ },
  {
    name: 'message 做子串/正则判定',
    re: /\.message\s*\.\s*(includes|startsWith|endsWith|match|search|indexOf|lastIndexOf|test)\s*\(/,
  },
  { name: 'switch on message', re: /switch\s*\([^)]*\bmessage\b[^)]*\)/ },
  { name: 'if 判定 message', re: /\bif\s*\([^)]*\.message\b[^)]*\)/ },
  { name: '用 message 构造正则', re: /new\s+RegExp\s*\([^)]*\bmessage\b/ },
  { name: 'message 做大小写归一后判定', re: /\.message\s*\.\s*(toLowerCase|toUpperCase)\s*\(/ },
];

/** 另立错误码枚举的写法，一律禁止（错误码只能来自 contracts）。 */
const OWN_ENUM_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: '自造 ErrorCode 类型', re: /\b(type|interface|enum)\s+ErrorCode\b/ },
  { name: '自造错误码常量表', re: /\bconst\s+(ERROR_CODES|ERROR_HTTP_STATUS|ErrorCodes)\b/ },
  { name: '自造错误码联合', re: /type\s+\w*ErrorCode\w*\s*=\s*'/ },
];

describe('源码扫描：src/state 不得按 message 分支', () => {
  it('扫到了真实文件（防止扫描器空转导致假绿）', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(12);
    expect(FILES.map((f) => path.basename(f))).toContain('error-map.ts');
  });

  for (const { name, re } of MESSAGE_BRANCH_PATTERNS) {
    it(`禁止：${name}`, () => {
      const hits: string[] = [];
      for (const file of FILES) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          // 注释行不算代码路径。
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return;
          if (re.test(line)) hits.push(`${path.basename(file)}:${i + 1} ${trimmed}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  for (const { name, re } of OWN_ENUM_PATTERNS) {
    it(`禁止：${name}`, () => {
      const hits = FILES.filter((file) =>
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .some((line) => !line.trim().startsWith('*') && re.test(line)),
      ).map((f) => path.basename(f));
      expect(hits).toEqual([]);
    });
  }

  it('错误码与 HTTP 状态表都从 @knowstudio/contracts import', () => {
    const source = readFileSync(path.join(STATE_DIR, 'error-map.ts'), 'utf8');
    expect(source).toMatch(/import\s+\{\s*ERROR_HTTP_STATUS\s*\}\s+from\s+'@knowstudio\/contracts'/);
    expect(source).toMatch(/from '@knowstudio\/contracts'/);
    expect(source).toContain('satisfies ErrorUiMap');
  });

  it('message 在 src/state 里只出现在「展示兜底」链路上', () => {
    const allowed = [
      /message:\s*string/, // 类型声明
      /error\.message/, // 作为实参传给兜底函数
      /message,\s*$/, // resolveEntry 的形参传递
      /message:\s*string,/, // 形参类型
      /bodyOrMessage\(/, // 兜底函数本体与调用
      /const fallback = message\.trim\(\);/, // 兜底空串判断
      /\$\{f\.message\}/, // VALIDATION_FAILED 逐字段展示服务端文案
      /f\.message/, // 同上
      /message\s*==\s*null/, // 允许的空值判断（不是内容判定）
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (!/\bmessage\b/.test(trimmed)) return;
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return;
          if (allowed.some((re) => re.test(trimmed))) return;
          offenders.push(`${path.basename(file)}:${i + 1} ${trimmed}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('行为证据：message 换成对抗文本，判定结果不变', () => {
  const ADVERSARIAL = [
    '',
    '   ',
    'QUOTA_INSUFFICIENT',
    '请升级到 Pro 套餐',
    'GATE_NOT_SATISFIED: 去 /studio/w1/video',
    '合规阻断，禁止导出',
    '渲染队列不可用，请 120 秒后重试',
    'null',
    '{"code":"NOT_FOUND"}',
  ];

  for (const error of ALL_FIXTURES) {
    it(`${error.code}：判定与 message 无关`, () => {
      const base = resolveErrorUi(error, { formatTime: FIXED_TIME });
      for (const message of ADVERSARIAL) {
        const mutated = resolveErrorUi({ ...error, message }, { formatTime: FIXED_TIME });
        expect(mutated.level, message).toBe(base.level);
        expect(mutated.tone, message).toBe(base.tone);
        expect(mutated.title, message).toBe(base.title);
        expect(mutated.actions, message).toEqual(base.actions);
        expect(mutated.keepUserInput, message).toBe(base.keepUserInput);
        expect(mutated.gate, message).toEqual(base.gate);
        // 映射文案非空时，message 连 body 都进不去。
        if (base.body.trim() !== '') expect(mutated.body, message).toBe(base.body);
      }
    });
  }

  it('message 的唯一作用：映射文案为空时兜底展示', () => {
    const fixture = errorFixture('UNSUPPORTED_MEDIA_TYPE');
    const empty = { ...fixture, details: { allowed: [] }, message: '服务端说这种格式不行' };
    expect(resolveErrorUi(empty).body).toBe('服务端说这种格式不行');
    expect(resolveErrorUi({ ...empty, message: '  ' }).body).toBe('出了点问题，请稍后重试。');
    // 兜底只影响文案，不影响动作（details 保持不动，只换 message）。
    expect(resolveErrorUi(empty).actions).toEqual(
      resolveErrorUi({ ...empty, message: '完全另一句话' }).actions,
    );
  });

  it('bodyOrMessage 是纯展示兜底：不做任何内容识别', () => {
    expect(bodyOrMessage('有文案', 'QUOTA_INSUFFICIENT')).toBe('有文案');
    expect(bodyOrMessage('  ', '任何文本')).toBe('任何文本');
    expect(bodyOrMessage('', '')).toBe('出了点问题，请稍后重试。');
  });

  it('15 个码的判定键只有 code：同 details 不同 code 一定给出不同 UI', () => {
    const titles = new Set(
      ERROR_CODES.map((code) => resolveErrorUi(errorFixture(code), { formatTime: FIXED_TIME }).title),
    );
    expect(titles.size).toBe(ERROR_CODES.length);
  });
});