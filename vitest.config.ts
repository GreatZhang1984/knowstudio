import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 子路径必须排在父路径之前：Vite 的字符串 alias 是前缀替换，顺序反了会被父 alias 吃掉。
const alias = {
  '@knowstudio/compliance': r('./packages/compliance/src/index.ts'),
  '@knowstudio/ai': r('./packages/ai/src/index.ts'),
  '@knowstudio/contracts': r('./packages/contracts/src/index.ts'),
  '@knowstudio/domain': r('./packages/domain/src/index.ts'),
  '@knowstudio/gates': r('./packages/gates/src/index.ts'),
  '@knowstudio/ui': r('./packages/ui/src/index.ts'),
  '@knowstudio/db/repositories': r('./packages/db/src/repositories/index.ts'),
  '@knowstudio/db': r('./packages/db/src/index.ts'),
  '@knowstudio/storage': r('./packages/storage/src/index.ts'),
  '@knowstudio/redis': r('./packages/redis/src/index.ts'),
  '@knowstudio/quota': r('./packages/quota/src/index.ts'),
  '@knowstudio/queue': r('./packages/queue/src/index.ts'),
  '@knowstudio/media': r('./packages/media/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // 多个真实 MySQL 集成文件共享同一活库；并行会让种子态断言读到其他 E2E 的临时数据。
    fileParallelism: false,
    // 两个 project 共用同一份 alias：node 跑 DB 集成等，jsdom 跑 .test.tsx 的 DOM/React 渲染。
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'dom',
          include: ['packages/**/test/**/*.test.tsx', 'apps/**/test/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
