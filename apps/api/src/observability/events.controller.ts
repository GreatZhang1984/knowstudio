import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  RecordEventsRequest,
  ValidationFailed,
  type RecordEventsResponse,
  type AnalyticsEventRequest,
} from '@knowstudio/contracts';
import type { WorkRepository } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard, readPrincipal } from '../auth/auth.guard.js';
import { WORK_REPOSITORY } from '../works/works.tokens.js';
import { ANALYTICS_RECORDER } from './observability.tokens.js';

type EventsRequest = Record<string, unknown>;

@Controller('events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(
    @Inject(WORK_REPOSITORY) private readonly works: WorkRepository,
    @Inject(ANALYTICS_RECORDER) private readonly recorder: AnalyticsRecorder,
  ) {}

  @Post()
  @HttpCode(200)
  async record(
    @Req() request: EventsRequest,
    @Body() body: unknown,
  ): Promise<RecordEventsResponse> {
    const parsed = RecordEventsRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        ValidationFailed.parse({
          code: 'VALIDATION_FAILED',
          message: '请求参数校验失败',
          details: {
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          },
        }),
      );
    }
    const principal = readPrincipal(request);
    if (principal === null) throw new Error('UNAUTHENTICATED');
    const now = Date.now();
    let accepted = 0;
    for (const event of parsed.data.events) {
      if (!this.validTime(event, now) || !(await this.owned(event.workId, principal.userId))) continue;
      await this.recorder.record({
        userId: principal.userId,
        workId: event.workId,
        event: event.event,
        props: event.props,
        occurredAt: event.occurredAt,
      });
      accepted += 1;
    }
    return { accepted };
  }

  private validTime(event: AnalyticsEventRequest, now: number): boolean {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at <= now + 60_000 && at >= now - 5 * 60_000;
  }

  private async owned(workId: string, userId: string): Promise<boolean> {
    return (await this.works.forUser(userId).findById(workId)) !== null;
  }
}
