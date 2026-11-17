/**
 * 架构 §3.2 依赖方向的 CI 强制实现。
 * 规则一旦违反即 error，`pnpm boundaries` 非零退出。
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-only-contracts',
      comment:
        '架构 §3.2：domain 是零 IO 纯函数层，只能依赖 contracts（包内自引用不算）。状态机与闸门规则必须能在前端复用，否则重蹈 D-03。',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { path: '^packages/(?!contracts|domain)' },
    },
    {
      name: 'domain-isomorphic',
      comment:
        'domain 不得依赖 Node 内置模块（crypto/fs/child_process 等），否则无法在浏览器运行。哈希用 @noble/hashes。',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-external-allowlist',
      comment:
        '架构 §3.2：domain 是零 IO 纯函数层，必须能在浏览器直接运行（消灭 D-03 前端重算闸门）。' +
        'domain-only-contracts 管内部包、domain-isomorphic 管 Node 内置，本规则管**外部 npm 包**：' +
        '白名单制（强约束用白名单，黑名单永远漏），当前只允许 @noble/hashes（用它是为了不依赖 Node crypto）。' +
        'test/ 不在白名单管辖内：测试文件不进浏览器产物，且它们依赖 vitest（devDep）；' +
        '若把 vitest 加进白名单反而会让 src 也能 import vitest（vitest 传递依赖大量 Node IO），故按目录豁免而非放宽白名单。',
      severity: 'error',
      from: { path: '^packages/domain', pathNot: '^packages/domain/test/' },
      to: {
        // npm-no-pkg / npm-unknown 一并纳入：pnpm 提升或传递安装但未在 package.json 声明的包同样不得进 domain。
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-bundled',
          'npm-no-pkg',
          'npm-unknown',
        ],
        // 按真实解析路径的包目录段匹配：pnpm 下是 node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/...
        // 结尾的 (/|$) 保证 @noble/hashes-evil 之类前缀相同的包不会蹭白名单。
        pathNot: '(^|/)node_modules/@noble/hashes(/|$)',
      },
    },
    {
      name: 'domain-src-no-test',
      comment:
        'domain-external-allowlist 按 from 豁免了 test/（测试不进浏览器产物，且要 import vitest）。' +
        '豁免只看 from 就留下洗白路径：src/x.ts → test/helper.ts → 任意 npm 包，' +
        '两条边分别落在「本地依赖」与「豁免目录」里，白名单一条都拦不住（已用真实探针验证）。' +
        '故直接禁止 src 引用 test：产物代码依赖测试代码本身就是方向错误。',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^packages/domain/test/' },
    },
    {
      name: 'web-allowed-packages',
      comment: '架构 §3.2：apps/web 只能 import contracts / ui / domain / observability/browser。前端不得直连 DB 或持有密钥。',
      severity: 'error',
      from: { path: '^apps/web' },
      to: { path: '^packages/(?!contracts|ui|domain|observability/src/browser)' },
    },
    {
      name: 'web-no-server-apps',
      comment: '前端不得 import 服务端应用代码。',
      severity: 'error',
      from: { path: '^apps/web' },
      to: { path: '^apps/(api|worker|admin)' },
    },
    {
      name: 'api-no-media',
      comment:
        '架构 §3.2：apps/api 不得 import media。CPU 密集逻辑必须在 worker，否则渲染打满 API、交互反馈 >100ms。',
      severity: 'error',
      from: { path: '^apps/api' },
      to: { path: '^packages/media' },
    },
    {
      name: 'packages-never-import-apps',
      comment: '架构 §3.2：packages/* 不得反向 import apps/*，保持可提取性，避免单体退化为泥球。',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'contracts-is-leaf',
      comment: 'contracts 是唯一契约源与依赖图叶子，不得依赖任何其他内部包（包内自引用不算）。',
      severity: 'error',
      from: { path: '^packages/contracts' },
      to: { path: '^packages/(?!contracts)' },
    },
    {
      name: 'g5-no-publisher-package',
      comment:
        'G5 静态防线①第二道（架构 §5.5）：不得 import 发布适配器，覆盖 publish/publisher/publishers/publishing 全部变体。' +
        '注意本规则只能拦「有依赖边」的情况——孤立目录无边可匹配，目录存在性由 pnpm guards（scripts/check-publish-adapters.mjs）断言。',
      severity: 'error',
      from: { path: '^(apps|packages)' },
      to: {
        // 按路径段匹配，且允许 publish 后紧跟 / . 或结尾，故 packages/publishers/x.ts、packages/publish/x.ts 均命中。
        // 刻意不加「可选前缀」来兼容 douyin-publisher 这类复合名：dependency-cruiser 的 unsafe-regex
        // 检查会拒绝任何可选重复前缀（实测 ([^/]+[-_])? 与 ([a-z0-9]+[-_])? 均被 Bailing out）。
        // 复合名由第一道 pnpm guards 按目录名词元切分拦下（已负向验证），此处不为了冗余覆盖引入 ReDoS 风险。
        path: '(^|/)(publish|publisher|publishers|publishing)(/|\\.|$)',
        // SPA 有 /publish/:id 派生页路由（apps/web/src/routes/manifest.ts），前端页面/路由树是合法的发布 UI，不是适配器。
        // 这里只放行「边」；页面树里若真出现 publisher/ 或 publish-sdk/ 目录，仍由 pnpm guards 按目录名拦下。
        pathNot: '^apps/[^/]+/src/(pages|routes|views)/',
      },
    },
    {
      name: 'g5-no-platform-publish-sdk',
      comment:
        'G5 静态防线②（架构 §5.5）：任意包不得 import 平台发布 SDK / 开放平台写接口客户端。M3 若预研通过须以独立 adapter 另行决策。',
      severity: 'error',
      from: { path: '^(apps|packages)' },
      to: {
        path: '(^|/)(weixin-js-sdk|wx-server-sdk|wechatpay|douyin-openapi|bilibili-api|weibo-sdk|xhs-[^/]*|@tencentcloud/|@douyin/|@bytedance/|@bilibili/|@xiaohongshu/|@weibo/)',
      },
    },
    {
      name: 'no-circular',
      comment: '禁止自有代码循环依赖（第三方包内部循环不在管辖范围）。',
      severity: 'error',
      from: { path: '^(apps|packages)' },
      to: { circular: true },
    },
  ],
  options: {
    // 必须用 doNotFollow 而非 exclude：exclude 会把 npm 模块整体从依赖图删除，
    // 导致 g5-no-platform-publish-sdk 只对「未安装的包名」生效，真装了 SDK 反而拦不住。
    doNotFollow: { path: 'node_modules' },
    // 只排除**本仓库自己的**构建产物；node_modules 必须留在图里，否则 G5 的 SDK 规则会失效。
    // 这里不能再写 '(^|/)dist(/|$)'：绝大多数 npm 包的 ESM 入口就在 dist/ 下
    // （实测 vitest 的 exports['.'].import.default = ./dist/index.js，vite = ./dist/node/index.js），
    // 那样写会把这些 npm 模块整体删出依赖图、连**指向它的边**一起删掉，
    // 于是 g5-no-platform-publish-sdk 与 domain-external-allowlist 对「入口在 dist 的包」全部失效
    // ——与上一轮 exclude: node_modules 那个 P0 同一类错误。故把 dist 排除限定到工作区包根一层。
    exclude: { path: '^(apps|packages)/[^/]+/dist(/|$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
