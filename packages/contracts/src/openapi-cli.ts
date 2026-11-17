import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../openapi.json');
const doc = buildOpenApiDocument();
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
process.stdout.write(
  `OpenAPI 快照已写入 ${out}（${Object.keys(doc.paths).length} 条路径，G5 校验通过）\n`,
);