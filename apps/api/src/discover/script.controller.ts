import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AutosaveConflict,
  GateNotSatisfied,
  GenerateScriptRequest,
  PatchScriptRequest,
  RestyleRequest,
  ScriptLocked,
  type Job,
  type Script,
  type ScriptSnapshot,
  type UnlockScriptResponse,
} from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard } from '../auth/auth.guard.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import { notFound, parseOr400, requirePrincipal, validationFailed } from './http.js';
import { ScriptService } from './script.service.js';

type WorkRequest = {
  params?: Record<string, string | undefined>;
} & Record<string, unknown>;

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound('作品不存在');
  return row;
}

function conflictOf(err: unknown): never {
  const e = err as {
    serverSnapshot: ScriptSnapshot;
    clientSnapshot: ScriptSnapshot;
  };
  throw new ConflictException(
    AutosaveConflict.parse({
      code: 'AUTOSAVE_CONFLICT',
      message: '文案已有新版本',
      details: {
        serverVersion: e.serverSnapshot.version,
        serverSnapshot: e.serverSnapshot,
        clientSnapshot: e.clientSnapshot,
      },
    }),
  );
}

@Controller('works')
@UseGuards(AuthGuard)
export class ScriptController {
  constructor(
    @Inject(ScriptService) private readonly scripts: ScriptService,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post(':id/script\\:generate')
  @UseGuards(OwnershipGuard)
  @HttpCode(202)
  async generate(@Req() request: WorkRequest, @Body() body: unknown): Promise<Job> {
    const principal = requirePrincipal(request);
    parseOr400(GenerateScriptRequest, body);
    try {
      const job = await this.scripts.generate(principal.userId, attachedWork(request));
      await this.analytics.record({
        userId: principal.userId,
        workId: job.workId,
        event: 'script_generated',
        props: { scriptId: job.id },
      });
      return job;
    } catch (err) {
      if ((err as { code?: string }).code === 'SCRIPT_GATE_NOT_SATISFIED') {
        throw new ConflictException(
          GateNotSatisfied.parse({
            code: 'GATE_NOT_SATISFIED',
            message: '请先选择一个角度',
            details: {
              requiredGate: 'G1',
              reason: 'TOPIC_NOT_SELECTED',
              redirectTo: '/discover/topics',
            },
          }),
        );
      }
      throw err;
    }
  }

  @Get(':id/script')
  @UseGuards(OwnershipGuard)
  async get(@Req() request: WorkRequest): Promise<Script> {
    const principal = requirePrincipal(request);
    try {
      return await this.scripts.get(principal.userId, attachedWork(request));
    } catch (err) {
      if ((err as { code?: string }).code === 'SCRIPT_NOT_FOUND') throw notFound('文案不存在');
      throw err;
    }
  }

  @Patch(':id/script')
  @UseGuards(OwnershipGuard)
  async patch(@Req() request: WorkRequest, @Body() body: unknown) {
    const principal = requirePrincipal(request);
    const input = parseOr400(PatchScriptRequest, body);
    try {
      return await this.scripts.patch(principal.userId, attachedWork(request), input);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SCRIPT_VERSION_CONFLICT') conflictOf(err);
      if (code === 'SCRIPT_LOCKED') {
        const work = attachedWork(request);
        throw new ConflictException(
          ScriptLocked.parse({
            code: 'SCRIPT_LOCKED',
            message: '文案已确认并锁定',
            details: { unlockUrl: `/studio/${work.id}/script` },
          }),
        );
      }
      if (code === 'SCRIPT_NOT_FOUND') throw notFound('文案不存在');
      throw err;
    }
  }

  @Post(':id/script\\:restyle')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async restyle(@Req() request: WorkRequest, @Body() body: unknown) {
    const principal = requirePrincipal(request);
    const input = parseOr400(RestyleRequest, body);
    try {
      return await this.scripts.restyle(principal.userId, attachedWork(request), input.sampleIds);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SCRIPT_NOT_FOUND') throw notFound('文案不存在');
      if (code === 'STYLE_SAMPLE_NOT_FOUND') {
        throw validationFailed([{ path: 'sampleIds', message: '风格样本不存在' }]);
      }
      throw err;
    }
  }

  @Post(':id/script/hunks/:hid\\:accept')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async accept(@Req() request: WorkRequest, @Param('hid') _hid: string) {
    const hunkId = request.params?.hid;
    if (hunkId === undefined) throw notFound('重写建议不存在');
    return this.resolve(request, hunkId, true);
  }

  @Post(':id/script/hunks/:hid\\:reject')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async reject(@Req() request: WorkRequest) {
    const hunkId = request.params?.hid;
    if (hunkId === undefined) throw notFound('重写建议不存在');
    return this.resolve(request, hunkId, false);
  }

  @Post(':id/script\\:confirm')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async confirm(@Req() request: WorkRequest) {
    const principal = requirePrincipal(request);
    try {
      const result = await this.scripts.confirm(principal.userId, attachedWork(request));
      const lines = result.script.sections.flatMap((section) => section.lines);
      const totalChars = lines.reduce((sum, line) => sum + line.charCount, 0);
      const editedChars = lines
        .filter((line) => line.editedByUser)
        .reduce((sum, line) => sum + line.charCount, 0);
      await this.analytics.record({
        userId: principal.userId,
        workId: result.script.workId,
        event: 'script_confirmed',
        props: { editDistanceRatio: totalChars === 0 ? 0 : editedChars / totalChars },
      });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === 'SCRIPT_NOT_FOUND') throw notFound('文案不存在');
      throw err;
    }
  }

  @Post(':id/script\\:unlock')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async unlock(@Req() request: WorkRequest): Promise<UnlockScriptResponse> {
    const principal = requirePrincipal(request);
    try {
      const envelope = await this.scripts.unlock(principal.userId, attachedWork(request));
      return { affectedAssets: [], rerenderCost: 0, envelope };
    } catch (err) {
      if ((err as { code?: string }).code === 'SCRIPT_NOT_FOUND') throw notFound('文案不存在');
      throw err;
    }
  }

  private async resolve(request: WorkRequest, hunkId: string, accept: boolean) {
    const principal = requirePrincipal(request);
    try {
      const result = await this.scripts.resolveHunk(
        principal.userId,
        attachedWork(request),
        hunkId,
        accept,
      );
      await this.analytics.record({
        userId: principal.userId,
        workId: result.script.workId,
        event: accept ? 'style_hunk_accepted' : 'style_hunk_rejected',
        props: { hunkId },
      });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === 'HUNK_NOT_FOUND') throw notFound('重写建议不存在');
      throw err;
    }
  }
}
