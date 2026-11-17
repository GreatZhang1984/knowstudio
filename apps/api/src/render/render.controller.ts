import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  GateNotSatisfied,
  QuotaInsufficient,
  RenderInProgress,
  PatchVideoRequest,
  VideoPatchRequest,
  type PatchVideoResponse,
  type RenderAccepted,
} from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard } from '../auth/auth.guard.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import { notFound, requirePrincipal } from '../discover/http.js';
import {
  RenderInProgressError,
  RenderGateNotSatisfiedError,
  RenderService,
} from './render.service.js';
import { QuotaInsufficientError } from '@knowstudio/quota';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';

type WorkRequest = {
  params?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
} & Record<string, unknown>;

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound('作品不存在');
  return row;
}

async function enqueueOrThrow(
  workId: string,
  run: () => Promise<RenderAccepted>,
  onQuotaInsufficient: () => Promise<void>,
): Promise<RenderAccepted> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RenderGateNotSatisfiedError) {
      throw new ConflictException(
        GateNotSatisfied.parse({
          code: 'GATE_NOT_SATISFIED',
          message: '文案尚未确认，无法生成视频',
          details: {
            requiredGate: 'G2',
            reason: 'SCRIPT_NOT_CONFIRMED',
            redirectTo: `/studio/${workId}/script`,
          },
        }),
      );
    }
    if (error instanceof RenderInProgressError) {
      throw new ConflictException(
        RenderInProgress.parse({
          code: 'RENDER_IN_PROGRESS',
          message: '已有渲染任务进行中',
          details: { activeJobId: error.activeJobId },
        }),
      );
    }
    if (error instanceof QuotaInsufficientError) {
      await onQuotaInsufficient();
      throw new HttpException(
        QuotaInsufficient.parse({
          code: 'QUOTA_INSUFFICIENT',
          message: '点数不够了',
          details: error.details,
        }),
        402,
      );
    }
    throw error;
  }
}

@Controller()
export class RenderController {
  constructor(
    @Inject(RenderService) private readonly render: RenderService,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post('works/:id/video\\:draft')
  @UseGuards(AuthGuard, OwnershipGuard)
  @HttpCode(202)
  async draft(@Req() request: WorkRequest): Promise<RenderAccepted> {
    const work = attachedWork(request);
    const principal = requirePrincipal(request);
    const accepted = await enqueueOrThrow(
      work.id,
      () => this.render.enqueue(principal.userId, work, 'draft'),
      () =>
        this.analytics.record({
          userId: principal.userId,
          workId: work.id,
          event: 'quota_insufficient',
          props: { action: 'draft' },
        }),
    );
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'render_started',
      props: { jobId: accepted.jobId, quality: 'draft' },
    });
    return accepted;
  }

  @Post('works/:id/video\\:render')
  @UseGuards(AuthGuard, OwnershipGuard)
  @HttpCode(202)
  async hd(@Req() request: WorkRequest): Promise<RenderAccepted> {
    const work = attachedWork(request);
    const principal = requirePrincipal(request);
    const accepted = await enqueueOrThrow(
      work.id,
      () => this.render.enqueue(principal.userId, work, 'hd'),
      () =>
        this.analytics.record({
          userId: principal.userId,
          workId: work.id,
          event: 'quota_insufficient',
          props: { action: 'hd' },
        }),
    );
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'render_started',
      props: { jobId: accepted.jobId, quality: 'hd' },
    });
    return accepted;
  }

  @Patch('works/:id/video')
  @UseGuards(AuthGuard, OwnershipGuard)
  async patch(@Req() request: WorkRequest, @Body() body: unknown): Promise<PatchVideoResponse> {
    const input = PatchVideoRequest.parse(body);
    const work = attachedWork(request);
    const principal = requirePrincipal(request);
    const result = await this.render.previewPatch(principal.userId, work, input);
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'draft_previewed',
      props: { invalidatedLayers: result.invalidatedLayers },
    });
    return result;
  }

  @Post('works/:id/video\\:patch')
  @UseGuards(AuthGuard, OwnershipGuard)
  @HttpCode(202)
  async patchRender(
    @Req() request: WorkRequest,
    @Body() body: unknown,
  ): Promise<RenderAccepted> {
    const work = attachedWork(request);
    const input = VideoPatchRequest.parse(body);
    const principal = requirePrincipal(request);
    const accepted = await enqueueOrThrow(
      work.id,
      () => this.render.enqueuePatch(principal.userId, work, input.layerScope),
      () =>
        this.analytics.record({
          userId: principal.userId,
          workId: work.id,
          event: 'quota_insufficient',
          props: { action: 'patch', layerScope: input.layerScope },
        }),
    );
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'render_started',
      props: { jobId: accepted.jobId, quality: 'patch', layerScope: input.layerScope },
    });
    return accepted;
  }

  @Get('jobs/:jobId')
  @UseGuards(AuthGuard)
  async job(@Req() request: WorkRequest, @Param('jobId') jobId: string) {
    return this.render.detail(requirePrincipal(request).userId, jobId);
  }

  @Post('jobs/:jobId\\:cancel')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async cancel(@Req() request: WorkRequest, @Param('jobId') jobId: string) {
    return this.render.cancel(requirePrincipal(request).userId, jobId);
  }

  @Post('jobs/:jobId\\:retry')
  @UseGuards(AuthGuard)
  @HttpCode(202)
  async retry(@Req() request: WorkRequest, @Param('jobId') jobId: string): Promise<RenderAccepted> {
    return this.render.retry(requirePrincipal(request).userId, jobId);
  }

  @Get('jobs/:jobId/events')
  @UseGuards(AuthGuard)
  async events(
    @Req() request: WorkRequest,
    @Param('jobId') jobId: string,
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      write: (value: string) => boolean;
      end: () => void;
      on: (event: 'close', listener: () => void) => unknown;
    },
  ): Promise<void> {
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('x-accel-buffering', 'no');
    let lastSeq = Number(request.headers?.['last-event-id'] ?? -1);
    response.write('retry: 3000\n\n');
    const sendNewEvents = async (): Promise<void> => {
      const events = await this.render.listEvents(jobId, lastSeq);
      for (const item of events) {
        lastSeq = item.seq;
        response.write(
          `id: ${item.seq}\nevent: ${item.event_type}\ndata: ${JSON.stringify(item.payload)}\n\n`,
        );
      }
    };
    await sendNewEvents();
    const heartbeat = setInterval(() => {
      void sendNewEvents()
        .then(() => {
          response.write(': heartbeat\n\n');
        })
        .catch(() => {
          response.write(': heartbeat\n\n');
        });
    }, 15_000);
    response.on('close', () => clearInterval(heartbeat));
  }
}
