import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Database, Kysely } from '@knowstudio/db';
import { enqueueInTransaction } from '@knowstudio/queue';
import {
  MetricRecomputeRequest,
  Unauthenticated,
  ValidationFailed,
  type MetricRecomputeAccepted,
  type MetricsResponse,
} from '@knowstudio/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { DB_CLIENT } from '../shared/tokens.js';
import { METRICS_READER } from './observability.tokens.js';

type MetricsRequest = {
  readonly headers: Record<string, string | string[] | undefined>;
} & Record<string, unknown>;

@Controller('metrics')
@UseGuards(AuthGuard)
export class MetricsController {
  constructor(
    @Inject(METRICS_READER) private readonly read: () => Promise<MetricsResponse>,
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
  ) {}

  @Get()
  async list(): Promise<MetricsResponse> {
    return this.read();
  }

  @Post('recompute')
  @HttpCode(202)
  async recompute(
    @Req() request: MetricsRequest,
    @Body() body: unknown,
  ): Promise<MetricRecomputeAccepted> {
    this.assertOperator(request);
    const parsed = MetricRecomputeRequest.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        ValidationFailed.parse({
          code: 'VALIDATION_FAILED',
          message: '请求参数校验失败',
          details: {
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.') || 'bucket',
              message: issue.message,
            })),
          },
        }),
      );
    }
    const bucket = this.bucketOf(parsed.data.bucket);
    if (bucket === null) {
      throw new BadRequestException(
        ValidationFailed.parse({
          code: 'VALIDATION_FAILED',
          message: '请求参数校验失败',
          details: {
            fields: [{ path: 'bucket', message: '必须是最近 90 天内且不晚于当前小时的小时桶' }],
          },
        }),
      );
    }

    const activeRows = await this.db
      .selectFrom('job_queue')
      .select(['id', 'payload'])
      .where('queue', '=', 'sys.metric')
      .where('state', 'in', ['pending', 'leased'])
      .execute();
    const existing = activeRows.find((row) => {
      const payload = row.payload as Record<string, unknown> | null;
      return payload?.bucket === bucket;
    });
    if (existing !== undefined)
      return { bucket: `${bucket.replace(' ', 'T')}Z`, queued: false, dedupKey: null };

    const dedupKey = `metric:manual:${bucket}:${randomUUID()}`;
    await this.db.transaction().execute(async (trx) =>
      enqueueInTransaction(trx, {
        queue: 'sys.metric',
        jobId: null,
        userId: null,
        payload: { bucket },
        dedupKey,
      }),
    );
    return { bucket: `${bucket.replace(' ', 'T')}Z`, queued: true, dedupKey };
  }

  private assertOperator(request: MetricsRequest): void {
    const expected = process.env['METRIC_RECOMPUTE_TOKEN'];
    const provided = request.headers['x-metric-recompute-token'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    const developmentAllowed = process.env['NODE_ENV'] !== 'production' && expected === undefined;
    if (developmentAllowed || (expected !== undefined && token === expected)) return;
    throw new UnauthorizedException(
      Unauthenticated.parse({
        code: 'UNAUTHENTICATED',
        message: '未认证或会话已失效',
        details: { loginUrl: '/login' },
      }),
    );
  }

  private bucketOf(input: string | undefined): string | null {
    const now = Date.now();
    const timestamp = input === undefined ? now : Date.parse(input);
    if (
      !Number.isFinite(timestamp) ||
      timestamp > now ||
      now - timestamp > 90 * 24 * 60 * 60 * 1000
    ) {
      return null;
    }
    if (timestamp % 3_600_000 !== 0) return null;
    return `${new Date(timestamp).toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');
  }
}
