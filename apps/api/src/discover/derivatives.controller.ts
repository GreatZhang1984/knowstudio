import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  GateNotSatisfied,
  GenerateDerivativesRequest,
  PatchDerivativeRequest,
  type RenderAccepted,
  type TitleRegenerateResponse,
} from '@knowstudio/contracts';
import type { PlatformId } from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard } from '../auth/auth.guard.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import { notFound, parseOr400, requirePrincipal, validationFailed } from './http.js';
import {
  DerivativeGateNotSatisfiedError,
  DerivativesService,
  type DerivativesView,
} from './derivatives.service.js';

type WorkRequest = {
  readonly params?: Record<string, string | undefined>;
} & Record<string, unknown>;

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound('作品不存在');
  return row;
}

function platformIdOf(value: string): PlatformId {
  if (value === 'douyin' || value === 'sph' || value === 'bili' || value === 'xhs') return value;
  throw new NotFoundException();
}

function throwDerivativeError(err: unknown, work: WorkRow): never {
  if (err instanceof DerivativeGateNotSatisfiedError) {
    throw new ConflictException(
      GateNotSatisfied.parse({
        code: 'GATE_NOT_SATISFIED',
        message:
          err.requiredGate === 'G2' ? '文案尚未确认，无法编辑派生' : '高清成片未完成，无法派生媒体',
        details: {
          requiredGate: err.requiredGate,
          reason: err.reason,
          redirectTo: err.redirectTo,
        },
      }),
    );
  }
  const code = (err as { code?: string }).code ?? (err as Error).message;
  if (code === 'DERIVATIVE_NOT_FOUND' || code === 'PLATFORM_RULE_NOT_FOUND') {
    throw notFound('派生信息不存在');
  }
  if (code === 'DERIVATIVE_TITLE_REQUIRED') {
    throw validationFailed([{ path: 'title', message: '标题不能为空' }]);
  }
  if (code === 'DERIVATIVE_METADATA_REQUIRED') {
    throw validationFailed([
      { path: 'platformIds', message: '请先生成所选平台的元数据' },
    ]);
  }
  if (code === 'DERIVATIVE_VALIDATION_BLOCKED') {
    throw validationFailed([{ path: 'validation', message: '请先修正 block 校验项' }]);
  }
  if (code === 'DERIVATIVE_MEDIA_IN_PROGRESS' || code === 'DERIVATIVE_MEDIA_NOT_IMPLEMENTED') {
    throw new ConflictException(
      GateNotSatisfied.parse({
        code: 'GATE_NOT_SATISFIED',
        message: '媒体派生将在 G3 成片后开放',
        details: {
          requiredGate: 'G3',
          reason: 'HD_RENDER_NOT_SUCCEEDED',
          redirectTo: `/studio/${work.id}/video`,
        },
      }),
    );
  }
  throw err;
}

@Controller('works')
@UseGuards(AuthGuard)
export class DerivativesController {
  constructor(
    @Inject(DerivativesService) private readonly derivatives: DerivativesService,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post(':id/derivatives\\:generate')
  @UseGuards(OwnershipGuard)
  @HttpCode(202)
  async generate(
    @Req() request: WorkRequest,
    @Body() body: unknown,
  ): Promise<DerivativesView | RenderAccepted> {
    const principal = requirePrincipal(request);
    const input = parseOr400(GenerateDerivativesRequest, body);
    const work = attachedWork(request);
    try {
      const result = await this.derivatives.generate(principal.userId, work, input);
      if ('derivatives' in result) {
        await this.analytics.recordMany(
          result.derivatives
            .filter(() => input.scope === 'metadata')
            .map((item) => ({
              userId: principal.userId,
              workId: work.id,
              event: 'derivative_generated' as const,
              props: { derivativeId: item.id, platformId: item.platformId },
            })),
        );
      }
      return result;
    } catch (err) {
      throwDerivativeError(err, work);
    }
  }

  @Get(':id/derivatives')
  @UseGuards(OwnershipGuard)
  async list(@Req() request: WorkRequest): Promise<DerivativesView> {
    const work = attachedWork(request);
    try {
      return await this.derivatives.list(requirePrincipal(request).userId, work);
    } catch (err) {
      throwDerivativeError(err, work);
    }
  }

  @Patch(':id/derivatives/:platformId')
  @UseGuards(OwnershipGuard)
  async patch(
    @Req() request: WorkRequest,
    @Param('platformId') rawPlatformId: string,
    @Body() body: unknown,
  ): Promise<DerivativesView> {
    const principal = requirePrincipal(request);
    const input = parseOr400(PatchDerivativeRequest, body);
    const work = attachedWork(request);
    try {
      const result = await this.derivatives.patch(
        principal.userId,
        work,
        platformIdOf(rawPlatformId),
        input,
      );
      await this.analytics.record({
        userId: principal.userId,
        workId: work.id,
        event: 'derivative_edited',
        props: { platformId: platformIdOf(rawPlatformId), fields: Object.keys(input) },
      });
      return result;
    } catch (err) {
      throwDerivativeError(err, work);
    }
  }

  @Post(':id/derivatives/:platformId/title\\:regenerate')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async regenerateTitle(
    @Req() request: WorkRequest,
    @Param('platformId') rawPlatformId: string,
  ): Promise<TitleRegenerateResponse> {
    const work = attachedWork(request);
    try {
      const result = await this.derivatives.regenerateTitle(
        requirePrincipal(request).userId,
        work,
        platformIdOf(rawPlatformId),
      );
      await this.analytics.record({
        userId: requirePrincipal(request).userId,
        workId: work.id,
        event: 'derivative_edited',
        props: { platformId: platformIdOf(rawPlatformId), fields: ['title'] },
      });
      return result;
    } catch (err) {
      throwDerivativeError(err, work);
    }
  }
}
