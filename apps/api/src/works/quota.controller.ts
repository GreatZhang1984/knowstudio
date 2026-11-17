/**
 * GET /quota —— 契约 openapi.ts 已定义的额度读取路由（summary「全部由账本聚合，禁读缓存快照」）。
 *
 * 数字一律来自 WORK_QUOTA_READER 端口（生产绑定 packages/db 的 quota_account 聚合），
 * 本控制器不自算额度，避免 D-22「三处额度各算各的」。AuthGuard 先行，未认证即 401 契约体。
 */
import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  LedgerEntrySchema,
  LedgerQuery,
  Unauthenticated,
  pageOf,
  type LedgerEntry,
  type Quota,
} from '@knowstudio/contracts';
import type { Database, Kysely } from '@knowstudio/db';
import { parseOr400, validationFailed } from '../discover/http.js';
import { AuthGuard, readPrincipal } from '../auth/auth.guard.js';
import { DB_CLIENT } from '../shared/tokens.js';
import type { WorkQuotaReader } from './work-ports.js';
import { WORK_QUOTA_READER } from './works.tokens.js';

function decodeLedgerCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
    const id = Number(parsed.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid');
    return id;
  } catch {
    throw validationFailed([{ path: 'cursor', message: '游标非法：必须是服务端下发的 opaque cursor' }]);
  }
}

@Controller('quota')
@UseGuards(AuthGuard)
export class QuotaController {
  constructor(
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
  ) {}

  @Get()
  async get(@Req() request: Record<string, unknown>): Promise<Quota> {
    const principal = readPrincipal(request);
    if (principal === null) {
      throw new UnauthorizedException(
        Unauthenticated.parse({
          code: 'UNAUTHENTICATED',
          message: '未认证或会话已失效',
          details: { loginUrl: '/login' },
        }),
      );
    }
    return this.quota.readForUser(principal.userId);
  }

  @Get('ledger')
  async ledger(
    @Req() request: Record<string, unknown>,
    @Query() query: unknown,
  ): Promise<{ items: LedgerEntry[]; nextCursor: string | null; total: number }> {
    const principal = readPrincipal(request);
    if (principal === null) throw new UnauthorizedException();
    const { limit, cursor, month } = parseOr400(LedgerQuery, query);
    const beforeId = decodeLedgerCursor(cursor);
    let queryBuilder = this.db
      .selectFrom('quota_ledger')
      .selectAll()
      .where('user_id', '=', principal.userId)
      .$if(month !== undefined, (qb) => qb.where('created_at', 'like', `${month}-%`));
    if (beforeId !== null) queryBuilder = queryBuilder.where('id', '<', String(beforeId));
    const rows = await queryBuilder.orderBy('id', 'desc').limit(limit).execute();

    const countBuilder = this.db
      .selectFrom('quota_ledger')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('user_id', '=', principal.userId)
      .$if(month !== undefined, (qb) => qb.where('created_at', 'like', `${month}-%`));
    const total = Number((await countBuilder.executeTakeFirstOrThrow()).total);
    const items = rows.map((row) => ({
      id: Number(row.id),
      workId: row.work_id,
      jobId: row.job_id,
      action: row.action,
      points: row.points,
      balanceAfter: row.balance_after,
      note: row.note,
      createdAt: `${row.created_at.replace(' ', 'T')}Z`,
    }));
    const nextCursor =
      rows.length < limit
        ? null
        : Buffer.from(JSON.stringify({ id: rows[rows.length - 1]?.id }), 'utf8').toString(
            'base64url',
          );
    const page = pageOf(LedgerEntrySchema).parse({ items, nextCursor, total });
    return { ...page, total: page.total ?? total };
  }
}
