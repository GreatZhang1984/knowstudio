#!/usr/bin/env node
/**
 * G5 静态防线①（架构 §5.5）的**文件系统断言**：仓库内不得存在「平台发布适配器」目录。
 *
 * 为什么必须是独立脚本，而不是 dependency-cruiser 规则：
 *   dependency-cruiser 的 forbidden 规则匹配的是 from → to 的**依赖边**。
 *   一个新建的 packages/publisher/douyin.ts，只要没有任何模块 import 它，就不产生任何边，
 *   `pnpm boundaries` 会全绿放行。「目录是否存在」是文件系统事实，依赖分析表达不了，
 *   所以防线①必须由本脚本兜底；depcruise 的 g5-no-publisher-package 只作为第二道（有边时拦）。
 *
 * 判定边界（为什么这样划）：
 *   被禁的是「平台发布适配器」——把内容推到抖音/视频号/B站等平台的执行组件或其 SDK 封装。
 *   合法的是「发布这件事的 UI 与领域概念」——SPA 有 /publish/:id 派生页路由（见
 *   apps/web/src/routes/manifest.ts），因此 apps/web/src/pages/publish/ 这类前端页面目录必须放行。
 *   区分二者靠三个信号，强度从高到低：
 *
 *   1) 位置 = packages/<name>（包根，含 packages/@scope/<name>）：
 *      packages/ 是可复用库层，前端页面永远不会出现在这里；架构 §3.2 的包清单中也没有发布包。
 *      故包名里只要出现 publish 词元（publish/publisher/publishers/publishing）一律拒绝，
 *      不看有没有人 import 它。这条覆盖 packages/publish、packages/publishers、
 *      packages/publisher、packages/publishing、packages/douyin-publisher 等全部变体。
 *
 *   2) 位置 = 服务端应用（apps/api|worker|admin，与 .dependency-cruiser.cjs 的
 *      web-no-server-apps 保持同一份服务端定义）：服务端没有页面/路由，
 *      任何带 publish 词元的目录都只能是发布执行链路，一律拒绝。
 *
 *   3) 名字本身的语义（任意深度）：
 *      - publisher / publishers / publishing 是「执行发布的组件」，不是页面名，一律拒绝
 *        （前端页面叫 publish，不会叫 publisher）。
 *      - publish 词元 + 适配器词元（adapter/sdk/client/openapi/uploader/bridge/driver）
 *        同时出现，说明是 SDK 封装而非 UI，一律拒绝，例如 publish-adapters/、douyin-publish-sdk/。
 *      - 只剩「裸 publish 词元」时语义歧义（可能是路由、也可能是前端状态目录）：
 *        位于前端页面/路由树 apps/<app>/src/(pages|routes|views)/ 内 → 放行；
 *        其余位置也放行，避免误伤 apps/web/src/work/publish/ 这类前端领域状态目录。
 *        这是本脚本有意保留的宽松地带：真正的适配器命名会命中 1/2/3 的强信号，
 *        而 SDK 本身另有防线②（g5-no-platform-publish-sdk）按包名拦截。
 *
 *   注意：只断言**目录**，不断言文件。PublishPage.tsx、publish.test.ts 这类文件名是合法的，
 *   交给 depcruise 的边规则处理（其 to.path 覆盖 `publish.` 形态）。
 *
 * 用法：
 *   node scripts/check-publish-adapters.mjs [--root <dir>]
 *   --root 仅用于测试：对着一棵临时 fixture 树跑同一份判定逻辑。默认扫描仓库根。
 *
 * 退出码：0 = 干净；1 = 存在发布适配器目录；2 = 参数错误。
 * 零第三方依赖，只用 Node 内置模块。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';

/** 第三方代码与构建产物不属于「本仓库的发布适配器」，整棵子树跳过。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.pnpm-store',
  '.idea',
  '.vscode',
]);

const PUBLISH_TOKENS = new Set(['publish', 'publisher', 'publishers', 'publishing']);
/** 指「执行发布的组件」，语义上不可能是一个页面。 */
const STRONG_PUBLISH_TOKENS = new Set(['publisher', 'publishers', 'publishing']);
/** 集成/封装语义。刻意不含 platform：publish-platforms 更可能是平台选择 UI。 */
const ADAPTER_TOKENS = new Set([
  'adapter',
  'adapters',
  'sdk',
  'sdks',
  'client',
  'clients',
  'openapi',
  'uploader',
  'uploaders',
  'bridge',
  'driver',
  'drivers',
]);

const PACKAGE_ROOT = /^packages\/(?:@[^/]+\/)?[^/]+$/;
const SERVER_APP = /^apps\/(?:api|worker|admin)(?:\/|$)/;

/**
 * 按分隔符与 camelCase 边界切词，避免子串误伤：
 *   'unpublished' -> ['unpublished']（不命中）
 *   'publish-adapters' -> ['publish','adapters']
 *   'douyinPublisher' -> ['douyin','publisher']
 */
function tokensOf(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * 对单个目录相对路径（posix 风格）判定。返回拒绝理由字符串，或 null 表示放行。
 * 强信号先判，前端页面树的放行只在「裸 publish 词元」这一歧义分支生效。
 */
function rejectReason(relDir) {
  const segments = relDir.split('/');
  const tokens = tokensOf(segments[segments.length - 1]);
  const publishHits = tokens.filter((t) => PUBLISH_TOKENS.has(t));
  if (publishHits.length === 0) return null;

  if (PACKAGE_ROOT.test(relDir)) {
    return 'packages/ 下的发布包（架构 §3.2 无此包；packages 是库层，不是页面）';
  }
  if (SERVER_APP.test(relDir)) {
    return '服务端应用内的 publish 目录（服务端无页面/路由，只能是发布执行链路）';
  }
  if (publishHits.some((t) => STRONG_PUBLISH_TOKENS.has(t))) {
    return 'publisher/publishers/publishing 指「执行发布的组件」，不是页面名';
  }
  if (tokens.some((t) => ADAPTER_TOKENS.has(t))) {
    return 'publish 词元 + 适配器/SDK 词元，属平台发布 SDK 封装';
  }
  // 走到这里只剩「裸 publish 词元」，且不在包根/服务端应用内：这是路由、页面或前端领域状态目录。
  // 前端页面/路由树 apps/<app>/src/(pages|routes|views)/publish/ 由此放行——SPA 的 /publish/:id
  // 派生页是合法的发布 UI（apps/web/src/routes/manifest.ts），不是平台发布适配器。
  // 注意强信号已在上面判过：页面树里的 publisher/ 或 publish-sdk/ 依然会被拒绝。
  return null;
}

/** 广度遍历目录树；命中即记录并停止下钻（子目录已被同一违规覆盖）。 */
function scan(root) {
  const violations = [];
  let scanned = 0;
  const queue = [''];
  while (queue.length > 0) {
    const rel = queue.shift();
    const abs = rel === '' ? root : path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // 权限/竞态：不可读目录不构成「存在适配器」的证据
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      scanned += 1;
      const reason = rejectReason(childRel);
      if (reason !== null) {
        violations.push({ dir: childRel, reason });
        continue;
      }
      queue.push(childRel);
    }
  }
  return { violations, scanned };
}

function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return { error: '--root 需要一个目录参数' };
      root = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return { root };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('用法: node scripts/check-publish-adapters.mjs [--root <dir>]');
    return 0;
  }
  if (args.error !== undefined) {
    console.error(`[G5 防线①] ${args.error}`);
    return 2;
  }
  if (!statSync(args.root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[G5 防线①] 扫描根不是目录：${args.root}`);
    return 2;
  }

  const { violations, scanned } = scan(args.root);
  if (violations.length > 0) {
    console.error(
      `\n✖ G5 静态防线①：发现 ${violations.length} 个平台发布适配器目录（扫描 ${scanned} 个目录，根 ${args.root}）`,
    );
    for (const v of violations) {
      console.error(`  error  ${v.dir}/  ← ${v.reason}`);
    }
    console.error(
      '\n  G5 不可协商：系统永不自动发布到任何平台，永不提供平台发布写接口。\n' +
        '  导出后由用户本人登录各平台发布。请删除该目录；M3 若预研通过须另行决策。\n',
    );
    return 1;
  }
  console.log(
    `✔ G5 静态防线①：未发现平台发布适配器目录（扫描 ${scanned} 个目录，根 ${args.root}）`,
  );
  return 0;
}

process.exit(main());