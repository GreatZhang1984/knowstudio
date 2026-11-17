/**
 * Work CRUD HTTP 层（SPEC §5 作品行 / 架构 §10.1、§10.3）。
 *
 * 路由：POST /works · GET /works · GET /works/:id · PATCH /works/:id · DELETE /works/:id
 *
 * ## Guard 链序（架构 §5.3，1188 行，不可调换）
 * `AuthGuard → OwnershipGuard → GateGuard → IdempotencyInterceptor → QuotaInterceptor → Handler`
 * 本批只做前两环：AuthGuard 挂**控制器级**（WP12 冻结路径 import），
 * OwnershipGuard 挂**路由级**（仅 `:id` 资源需要归属数据）。
 * Nest 守卫执行序为 全局 → 控制器 → 路由，故 AuthGuard 必先于 OwnershipGuard；
 * 该顺序在 E2E 里用「无 token 调 :id 得 401 而非 404」实测验证，不靠推断。
 * GateGuard / 幂等 / 配额拦截器属后续 Task，**不提前实现**。
 *
 * ## DTO
 * 一律复用 @knowstudio/contracts 的 zod schema，**不自发明 DTO**。
 *
 * ## G5
 * 本控制器只有作品自身的 CRUD，**不含任何平台发布写端点**，也不 import 发布 SDK。
 * SPA 的 /publish/:id 是派生页 UI（domain 的 redirectTo 目标），不是发布适配器。
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CreateWorkRequest,
  ListWorksQuery,
  NotFound,
  PatchWorkRequest,
  Unauthenticated,
  ValidationFailed,
  WorkListItem,
  pageOf,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import type { WorkListPage, WorkRepository, WorkRow } from '@knowstudio/db/repositories';
import { phaseOf } from '@knowstudio/domain';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard, readPrincipal } from '../auth/auth.guard.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import type { AuthPrincipal } from '../shared/auth-principal.js';
import { assembleWorkEnvelope, gatesOf, toWorkListItem } from './work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from './work-ports.js';
import { OwnershipGuard } from './ownership.guard.js';
import {
  REQUEST_WORK_KEY,
  WORK_QUOTA_READER,
  WORK_REPOSITORY,
  WORK_TRUTH_SNAPSHOT,
} from './works.tokens.js';

type WorkRequest = {
  params?: Record<string, string | undefined>;
} & Record<string, unknown>;

/**
 * 结构化 safeParse 适配器。刻意不 import zod：apps/api 未声明该依赖（pnpm 严格隔离下不可解析），
 * 且 contracts 已是唯一契约源。用结构类型即可同时兼容 zod 3/4 的 issue.path 形态。
 */
interface SafeParser<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly unknown[]; message: string }[] };
      };
}

/** 校验失败统一 400 + 契约 VALIDATION_FAILED（details.fields 逐字段定位）。 */
function parseOr400<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException(
      ValidationFailed.parse({
        code: 'VALIDATION_FAILED',
        message: '请求参数校验失败',
        details: {
          fields: result.error.issues.map((issue) => ({
            path: issue.path.map((seg) => String(seg)).join('.'),
            message: issue.message,
          })),
        },
      }),
    );
  }
  return result.data;
}

function requirePrincipal(request: WorkRequest): AuthPrincipal {
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
  return principal;
}

function notFound(): NotFoundException {
  return new NotFoundException(
    NotFound.parse({ code: 'NOT_FOUND', message: '作品不存在', details: {} }),
  );
}

/**
 * 前缀化 ID（架构 §4.2 298 行：主键 CHAR(36) ascii_bin，前缀化如 `w_`/`job_`/`mat_`）。
 * `w_` + 32 位 hex = 34 字符，落在 CHAR(36) 内；用 node:crypto，不引新依赖。
 */
function newWorkId(): string {
  return `w_${randomUUID().replace(/-/g, '')}`;
}

@Controller('works')
@UseGuards(AuthGuard)
export class WorksController {
  constructor(
    @Inject(WORK_REPOSITORY) private readonly works: WorkRepository,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  /** POST /works —— 新建。返回完整信封，**不继承任何旧 Work 状态**（D-05）。 */
  @Post()
  async create(@Req() request: WorkRequest, @Body() body: unknown): Promise<WorkEnvelope> {
    const principal = requirePrincipal(request);
    const input = parseOr400(CreateWorkRequest, body);

    const row = await this.works.forUser(principal.userId).insert({
      id: newWorkId(),
      // [待确认] SPEC 未规定 title 省略时的默认值。此处取 keyword：
      // 作品卡同时展示标题与关键词，用关键词兜底比空标题更可用。已在报告列出待裁决。
      title: input.title ?? input.keyword,
      keyword: input.keyword,
      step: 'search',
      phase: phaseOf('search'),
    });
    await this.analytics.record({
      userId: principal.userId,
      workId: row.id,
      event: 'work_created',
      props: { keyword: input.keyword },
    });

    return this.envelopeFor(principal.userId, row);
  }

  /** GET /works —— 游标分页（架构 §10.1：?limit=&cursor=，响应 {items,nextCursor,total?}）。 */
  @Get()
  async list(
    @Req() request: WorkRequest,
    @Query() query: unknown,
  ): Promise<{ items: WorkListItem[]; nextCursor: string | null; total: number }> {
    const principal = requirePrincipal(request);
    const { limit, cursor, phase, q } = parseOr400(ListWorksQuery, query);

    const repo = this.works.forUser(principal.userId);
    const filter = {
      ...(phase === undefined ? {} : { phase }),
      ...(q === undefined ? {} : { q }),
    };

    let page: WorkListPage;
    try {
      page = await repo.list(filter, { limit, ...(cursor === undefined ? {} : { cursor }) });
    } catch (err) {
      // 非法游标是**客户端输入错误** → 400，不是 500。按结构化 code 分支，不解析 message。
      if ((err as { code?: string }).code === 'WORK_CURSOR_INVALID') {
        throw new BadRequestException(
          ValidationFailed.parse({
            code: 'VALIDATION_FAILED',
            message: '请求参数校验失败',
            details: { fields: [{ path: 'cursor', message: '游标非法：必须是服务端下发的 opaque cursor' }] },
          }),
        );
      }
      throw err;
    }
    const total = await repo.count(filter);

    // 闸门逐项派生（不读 work.gates 缓存，理由见 work-envelope.toWorkListItem）。
    const items = await Promise.all(
      page.items.map(async (row) => toWorkListItem(row, gatesOf(await this.snapshots.load(row)))),
    );

    const parsed = pageOf(WorkListItem).parse({ items, nextCursor: page.nextCursor, total });
    // 契约里 pageOf 的 total 是 optional（允许省略），但本端点总是实算 count，
    // 故显式回填为必填 number：既满足返回类型，也保证前端不会收到 undefined。
    return { items: parsed.items, nextCursor: parsed.nextCursor, total };
  }

  /** GET /works/:id —— 详情信封。归属已由 OwnershipGuard 校验（不匹配即 404）。 */
  @Get(':id')
  @UseGuards(OwnershipGuard)
  async detail(@Req() request: WorkRequest): Promise<WorkEnvelope> {
    const principal = requirePrincipal(request);
    return this.envelopeFor(principal.userId, this.attachedWork(request));
  }

  /** PATCH /works/:id —— 工作台改名（SPEC §5）。返回新信封。 */
  @Patch(':id')
  @UseGuards(OwnershipGuard)
  async patch(
    @Req() request: WorkRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<WorkEnvelope> {
    const principal = requirePrincipal(request);
    const input = parseOr400(PatchWorkRequest, body);

    const row = await this.works.forUser(principal.userId).rename(id, input.title);
    if (row === null) throw notFound();

    return this.envelopeFor(principal.userId, row);
  }

  /**
   * DELETE /works/:id —— 软删除（架构 §4.2：软删除仅用于 material/work）。
   * [待确认] SPEC 未规定删除响应体，此处用 204 No Content（已删除资源无信封可下发）。
   */
  @Delete(':id')
  @UseGuards(OwnershipGuard)
  @HttpCode(204)
  async remove(@Req() request: WorkRequest, @Param('id') id: string): Promise<void> {
    const principal = requirePrincipal(request);
    const deleted = await this.works.forUser(principal.userId).softDelete(id);
    // Guard 与 handler 之间若被并发删除，仍回同一个 404（不可区分）。
    if (!deleted) throw notFound();
  }

  /** OwnershipGuard 已把行挂到 request，直接复用，避免二次点查。 */
  private attachedWork(request: WorkRequest): WorkRow {
    const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
    if (row === undefined) throw notFound();
    return row;
  }

  private async envelopeFor(userId: string, row: WorkRow): Promise<WorkEnvelope> {
    const [snapshot, quota] = await Promise.all([
      this.snapshots.load(row),
      this.quota.readForUser(userId),
    ]);
    return assembleWorkEnvelope(row, snapshot, quota);
  }
}
