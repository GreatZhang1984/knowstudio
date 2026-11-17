/**
 * G5 静态防线① 与 domain 零 IO 约束的**回归测试**。
 *
 * 这些断言锁死上一轮审查修好的东西，防止再被静默改回去：
 *  - 防线①是文件系统断言：孤立目录（无任何 import）也必须被 pnpm guards 拦下；
 *    同时前端 /publish/:id 派生页目录必须放行。
 *  - exclude 不得把 npm 包整体删出依赖图（那会让防线②与 domain 白名单对 dist 入口的包失效）。
 *  - domain 外部依赖白名单只允许 @noble/hashes。
 *  - guards 必须挂在根 package.json 的 check 链上，否则 CI 不会跑到它。
 *
 * 目录断言用 --root 指向 os.tmpdir() 下的 fixture 树，不在仓库里造违规目录。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-publish-adapters.mjs');

const nodeRequire = createRequire(import.meta.url);

interface CruiseRule {
  name: string;
  severity: string;
  from?: { path?: string; pathNot?: string };
  to?: { path?: string; pathNot?: string; dependencyTypes?: string[]; circular?: boolean };
}
interface CruiseConfig {
  forbidden: CruiseRule[];
  options: { doNotFollow?: { path?: string }; exclude?: { path?: string } };
}
interface RootManifest {
  scripts: Record<string, string>;
}

const config = nodeRequire(path.join(REPO_ROOT, '.dependency-cruiser.cjs')) as CruiseConfig;
const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
) as RootManifest;

const fixtures: string[] = [];

/** 造一棵只含目录的 fixture 树——防线①断言的是目录存在性，不需要文件内容。 */
function fixture(dirs: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'knowstudio-g5-'));
  fixtures.push(root);
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function runGuard(root: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [GUARD_SCRIPT, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function rule(name: string): CruiseRule {
  const found = config.forbidden.find((r) => r.name === name);
  expect(found, `dependency-cruiser 缺少规则 ${name}`).toBeDefined();
  return found as CruiseRule;
}

function regexOf(value: string | undefined, label: string): RegExp {
  expect(value, `${label} 必须存在`).toBeTypeOf('string');
  return new RegExp(value as string);
}

describe('G5 防线①：发布适配器目录存在性断言', () => {
  it('孤立的 packages/publisher/ 也被拦下（没有任何模块 import 它）', () => {
    const result = runGuard(fixture(['packages/publisher']));
    expect(result.status).toBe(1);
    expect(result.output).toContain('packages/publisher/');
  });

  it.each([
    'packages/publish',
    'packages/publisher',
    'packages/publishers',
    'packages/publishing',
    'packages/douyin-publisher',
    'packages/@knowstudio/publisher',
  ])('拦下发布包变体 %s', (dir) => {
    const result = runGuard(fixture([dir]));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${dir}/`);
  });

  it('放行前端 /publish/:id 派生页与路由目录', () => {
    const result = runGuard(
      fixture([
        'apps/web/src/pages/publish/[id]',
        'apps/web/src/pages/publish/[id]/export',
        'apps/web/src/routes/publish',
        'apps/web/src/views/publish',
        'apps/web/src/work/publish',
      ]),
    );
    expect(result.output).not.toContain('error');
    expect(result.status).toBe(0);
  });

  it('不把 publish 只是子串的合法名字误判（unpublished / prepublish）', () => {
    const result = runGuard(fixture(['packages/unpublished', 'apps/web/src/pages/prepublish']));
    expect(result.status).toBe(0);
  });

  it('拦下服务端应用内的 publish 目录', () => {
    expect(runGuard(fixture(['apps/api/src/publish'])).status).toBe(1);
    expect(runGuard(fixture(['apps/worker/src/publishing'])).status).toBe(1);
  });

  it('拦下 publish + 适配器/SDK 词元的封装目录', () => {
    expect(runGuard(fixture(['packages/media/src/publish-adapters'])).status).toBe(1);
  });

  it('前端页面树内的 publisher/ 与 publish-sdk/ 仍然拦下', () => {
    expect(runGuard(fixture(['apps/web/src/pages/publisher'])).status).toBe(1);
    expect(runGuard(fixture(['apps/web/src/pages/publish/douyin-publish-sdk'])).status).toBe(1);
  });

  it('跳过第三方代码与构建产物', () => {
    expect(runGuard(fixture(['node_modules/some-sdk/publisher'])).status).toBe(0);
    expect(runGuard(fixture(['apps/web/dist/publisher'])).status).toBe(0);
  });

  it('当前仓库自身是干净的', () => {
    expect(runGuard(REPO_ROOT).status).toBe(0);
  });

  it('--root 缺参数时以退出码 2 报错', () => {
    try {
      execFileSync(process.execPath, [GUARD_SCRIPT, '--root'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect.unreachable('--root 缺参数应当非零退出');
    } catch (error) {
      expect((error as { status?: number }).status).toBe(2);
    }
  });
});

describe('CI 接线：guards 必须在 check 链上', () => {
  it('根 package.json 定义了 guards 且 check 会跑到它', () => {
    expect(manifest.scripts.guards).toContain('check-publish-adapters.mjs');
    expect(manifest.scripts.check ?? '').toContain('pnpm guards');
  });
});

describe('dependency-cruiser：不得回退的静态防线', () => {
  it('node_modules 用 doNotFollow 留在图里，而不是被 exclude 删掉', () => {
    expect(config.options.doNotFollow?.path ?? '').toContain('node_modules');
  });

  it('exclude 只删自己的构建产物，不删 npm 包的 dist 入口', () => {
    const exclude = regexOf(config.options.exclude?.path, 'options.exclude.path');
    // 实测这两个包的 ESM 入口就在 dist 下；一旦被删出图，指向它们的边也一起消失。
    expect(exclude.test('node_modules/.pnpm/vitest@3.2.7/node_modules/vitest/dist/index.js')).toBe(
      false,
    );
    expect(exclude.test('node_modules/.pnpm/vite@6.4.6/node_modules/vite/dist/node/index.js')).toBe(
      false,
    );
    expect(exclude.test('apps/web/dist/assets/index.js')).toBe(true);
  });

  it('防线②按路径段匹配真实 pnpm 解析路径，而非锚定包名', () => {
    const sdk = regexOf(rule('g5-no-platform-publish-sdk').to?.path, 'sdk to.path');
    expect(
      sdk.test('node_modules/.pnpm/weixin-js-sdk@1.6.5/node_modules/weixin-js-sdk/dist/index.js'),
    ).toBe(true);
    expect(
      sdk.test('node_modules/.pnpm/@tencentcloud+sdk@1/node_modules/@tencentcloud/sdk/dist/index.js'),
    ).toBe(true);
    expect(sdk.test('weixin-js-sdk')).toBe(true);
  });

  it('防线①第二道覆盖 publish 全部变体，并放行前端页面树', () => {
    const r = rule('g5-no-publisher-package');
    const to = regexOf(r.to?.path, 'publisher to.path');
    for (const p of [
      'packages/publisher/douyin.ts',
      'packages/publishers/bilibili.ts',
      'packages/publish/weixin.ts',
      'packages/publishing/queue.ts',
    ]) {
      expect(to.test(p), `${p} 应被 to.path 命中`).toBe(true);
    }
    const notTo = regexOf(r.to?.pathNot, 'publisher to.pathNot');
    expect(notTo.test('apps/web/src/pages/publish/PublishChecklist.tsx')).toBe(true);
  });

  it('domain 外部依赖白名单只允许 @noble/hashes', () => {
    const r = rule('domain-external-allowlist');
    expect(r.from?.path).toBe('^packages/domain');
    expect(r.to?.dependencyTypes).toContain('npm');
    const allow = regexOf(r.to?.pathNot, 'domain to.pathNot');
    expect(
      allow.test('node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js'),
    ).toBe(true);
    // 前缀相同的包不得蹭白名单
    expect(allow.test('node_modules/@noble/hashes-evil/index.js')).toBe(false);
    expect(allow.test('node_modules/.pnpm/mysql2@3/node_modules/mysql2/index.js')).toBe(false);
    expect(allow.test('node_modules/.pnpm/axios@1/node_modules/axios/dist/node/axios.cjs')).toBe(
      false,
    );
  });

  it('no-circular 的 from 收窄到自有代码，避免 node_modules 内部循环刷屏', () => {
    expect(rule('no-circular').from?.path).toBe('^(apps|packages)');
  });

  it('堵住 src → test → npm 的白名单洗白路径', () => {
    // domain-external-allowlist 的豁免只看 from，所以 src 经 test 转手就能带上任意 npm 包。
    // 这条规则必须存在，且 from 不得再带 pathNot 把 src 自己豁免掉。
    const r = rule('domain-src-no-test');
    expect(r.severity).toBe('error');
    expect(r.from?.pathNot).toBeUndefined();
    const from = regexOf(r.from?.path, 'domain-src-no-test from.path');
    const to = regexOf(r.to?.path, 'domain-src-no-test to.path');
    expect(from.test('packages/domain/src/gates/rules.ts')).toBe(true);
    expect(to.test('packages/domain/test/fixtures.ts')).toBe(true);
    // 反向（test 引用 src）是正常的，不得误伤
    expect(from.test('packages/domain/test/gates/rules.test.ts')).toBe(false);
  });
});