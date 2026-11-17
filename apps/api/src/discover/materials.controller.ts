/**
 * 收藏 HTTP 层（SPEC §3.2 收藏即建立 WorkMaterial 引用 / 架构 §5.6 action-bar）。
 *  POST   /works/:id/materials       幂等收藏 → {collectedCount, envelope}
 *  DELETE /works/:id/materials/:mid  取消收藏 → {collectedCount, envelope}
 *
 * Guard 链：AuthGuard（控制器级）→ OwnershipGuard（路由级，校验 :id work 归属并挂行）→ Handler。
 * 仓储 collect 再做写前纵深防御（work 归属 / material 可见），失败按结构化 code 映射 404，绝不解析 message。
 *
 * collectedCount 与 envelope 同源真实：count 来自 work_material 实算，envelope 由快照+配额装配
 * （闸门一律 deriveGates 派生，不硬编码、不读缓存）。取消收藏也回新信封，action-bar 即时刷新。
 *
 * G5：只建/删素材引用，无平台发布写端点，不 import 发布 SDK。
 */
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CollectMaterialRequest,
  CollectMaterialResponse,
  ReplaceMaterialRequest,
  type RenderAccepted,
} from '@knowstudio/contracts';
import type {
  ScopedWorkMaterialRepository,
  WorkMaterialRepository,
  WorkRow,
} from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { AuthGuard } from '../auth/auth.guard.js';
import { assembleWorkEnvelope } from '../works/work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import {
  REQUEST_WORK_KEY,
  WORK_QUOTA_READER,
  WORK_TRUTH_SNAPSHOT,
} from '../works/works.tokens.js';
import { RenderService } from '../render/render.service.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';
import { WORK_MATERIAL_REPOSITORY } from './discover.tokens.js';
import { notFound, parseOr400, requirePrincipal, validationFailed } from './http.js';

type MaterialsRequest = {
  params?: Record<string, string | undefined>;
} & Record<string, unknown>;

/** OwnershipGuard 已把 work 行挂到 request，直接复用，避免二次点查与 TOCTOU。 */
function attachedWork(request: MaterialsRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound();
  return row;
}

@Controller('works')
@UseGuards(AuthGuard)
export class MaterialsController {
  constructor(
    @Inject(WORK_MATERIAL_REPOSITORY) private readonly workMaterials: WorkMaterialRepository,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
    @Inject(RenderService)
    private readonly render: RenderService,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  @Post(':id/materials')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async collect(
    @Req() request: MaterialsRequest,
    @Body() body: unknown,
  ): Promise<CollectMaterialResponse> {
    const principal = requirePrincipal(request);
    const input = parseOr400(CollectMaterialRequest, body);
    const work = attachedWork(request);
    const repo = this.workMaterials.forUser(principal.userId);
    try {
      await repo.collect(work.id, input.materialId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 写前纵深防御失败：work 非本人 / material 不可见 / id 非法 → 同一 404（防枚举）。
      if (
        code === 'WORK_NOT_OWNED' ||
        code === 'MATERIAL_NOT_VISIBLE' ||
        code === 'WORK_MATERIAL_ID_INVALID'
      ) {
        throw notFound();
      }
      throw err;
    }
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'material_collected',
      props: { materialId: input.materialId },
    });
    return this.responseFor(principal.userId, work, repo);
  }

  @Delete(':id/materials/:mid')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async uncollect(
    @Req() request: MaterialsRequest,
    @Param('mid') mid: string,
  ): Promise<CollectMaterialResponse> {
    const principal = requirePrincipal(request);
    const work = attachedWork(request);
    const repo = this.workMaterials.forUser(principal.userId);
    if (!/^[A-Za-z0-9_-]{1,36}$/u.test(mid)) throw notFound();

    // 幂等：原本没收藏也回 200 + 当前计数；影响课件时同事务创建 0 点 slides patch。
    const patchJob = await this.render.removeMaterialWithSlidesPatch(
      principal.userId,
      work,
      mid,
    );
    await this.analytics.record({
      userId: principal.userId,
      workId: work.id,
      event: 'material_uncollected',
      props: { materialId: mid },
    });
    return this.responseFor(principal.userId, work, repo, patchJob);
  }

  @Post(':id/materials/:mid/replace')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async replace(
    @Req() request: MaterialsRequest,
    @Param('mid') mid: string,
    @Body() body: unknown,
  ): Promise<CollectMaterialResponse> {
    const principal = requirePrincipal(request);
    const work = attachedWork(request);
    const input = parseOr400(ReplaceMaterialRequest, body);
    const repo = this.workMaterials.forUser(principal.userId);

    try {
      const patchJob = await this.render.replaceMaterialWithSlidesPatch(
        principal.userId,
        work,
        mid,
        input.materialId,
      );
      return this.responseFor(principal.userId, work, repo, patchJob);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'MATERIAL_NOT_VISIBLE') throw notFound('替换素材不存在或不可见');
      const message = (err as { message?: string }).message;
      if (message === 'MATERIAL_TYPE_MISMATCH') {
        throw validationFailed([{ path: 'materialId', message: '替换素材类型必须与原素材一致' }]);
      }
      if (message === 'MATERIAL_ALREADY_REFERENCED') {
        throw validationFailed([{ path: 'materialId', message: '替换素材已在当前作品中' }]);
      }
      throw err;
    }
  }

  private async responseFor(
    userId: string,
    work: WorkRow,
    repo: ScopedWorkMaterialRepository,
    patchJob: RenderAccepted | null = null,
  ): Promise<CollectMaterialResponse> {
    const [collectedCount, snapshot, quota] = await Promise.all([
      repo.countForWork(work.id),
      this.snapshots.load(work),
      this.quota.readForUser(userId),
    ]);
    const envelope = assembleWorkEnvelope(work, snapshot, quota);
    return CollectMaterialResponse.parse({
      collectedCount,
      envelope,
      patchJob:
        patchJob === null
          ? null
          : {
              jobId: patchJob.jobId,
              costPoints: patchJob.costPoints,
              sseUrl: patchJob.sseUrl,
            },
    });
  }
}
