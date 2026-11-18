import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  GenerateTopicsRequest,
  JobSchema,
  RerollAccepted,
  SelectTopicRequest,
  TopicsQuery,
  type Job,
  type TopicBatch,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard } from '../auth/auth.guard.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import { notFound, parseOr400, requirePrincipal, validationFailed } from './http.js';
import {
  TopicsService,
  TopicMaterialNotCollectedError,
  TopicRerollLimitError,
} from './topics.service.js';

type WorkRequest = {
  params?: Record<string, string | undefined>;
} & Record<string, unknown>;

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound('作品不存在');
  return row;
}

@Controller('works')
@UseGuards(AuthGuard)
export class TopicsController {
  constructor(
    @Inject(TopicsService) private readonly topics: TopicsService,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post(':id/topics\\:generate')
  @UseGuards(OwnershipGuard)
  @HttpCode(202)
  async generate(@Req() request: WorkRequest, @Body() body: unknown): Promise<Job> {
    const principal = requirePrincipal(request);
    const input = parseOr400(GenerateTopicsRequest, body);
    try {
      const result = await this.topics.generate(principal.userId, attachedWork(request), input);
      await this.analytics.record({
        userId: principal.userId,
        workId: result.batch.work_id,
        event: 'topic_batch_generated',
        props: { batchId: result.batch.id, topicCount: result.topics.length },
      });
      return JobSchema.parse(this.topics.jobOf(result));
    } catch (err) {
      if (err instanceof TopicMaterialNotCollectedError) {
        throw validationFailed([{ path: 'materialIds', message: '素材必须先收藏到当前作品' }]);
      }
      if ((err as { code?: string }).code === 'TOPIC_MATERIALS_REQUIRED') {
        throw validationFailed([{ path: 'materialIds', message: '先收藏至少一条素材' }]);
      }
      throw err;
    }
  }

  @Get(':id/topics')
  @UseGuards(OwnershipGuard)
  async list(@Req() request: WorkRequest, @Query() query: unknown): Promise<TopicBatch> {
    const principal = requirePrincipal(request);
    const { batch } = parseOr400(TopicsQuery, query);
    try {
      return await this.topics.batch(principal.userId, attachedWork(request), batch);
    } catch (err) {
      // service 抛裸 Error(message=code)，与 derivatives.controller 同一惯例双查。
      const code = (err as { code?: string }).code ?? (err as Error).message;
      if (code === 'TOPIC_BATCH_NOT_FOUND') throw notFound('选题不存在');
      throw err;
    }
  }

  @Post(':id/topics\\:reroll')
  @UseGuards(OwnershipGuard)
  @HttpCode(202)
  async reroll(@Req() request: WorkRequest): Promise<RerollAccepted> {
    const principal = requirePrincipal(request);
    try {
      const result = await this.topics.reroll(principal.userId, attachedWork(request));
      return RerollAccepted.parse({
        batchId: result.batch.id,
        batchIndex: result.batch.batch_index,
        status: 'succeeded',
      });
    } catch (err) {
      if (err instanceof TopicRerollLimitError) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: err.message,
          details: {},
        });
      }
      if ((err as { code?: string }).code === 'TOPIC_MATERIALS_REQUIRED') {
        throw validationFailed([{ path: 'materialIds', message: '先收藏至少一条素材' }]);
      }
      throw err;
    }
  }

  @Post(':id/topic\\:select')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async select(@Req() request: WorkRequest, @Body() body: unknown): Promise<WorkEnvelope> {
    const principal = requirePrincipal(request);
    const input = parseOr400(SelectTopicRequest, body);
    try {
      const result = await this.topics.select(principal.userId, attachedWork(request), input.topicId);
      await this.analytics.record({
        userId: principal.userId,
        workId: result.id,
        event: 'topic_selected',
        props: { topicId: input.topicId },
      });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === 'TOPIC_NOT_FOUND') throw notFound('选题不存在');
      throw err;
    }
  }
}
