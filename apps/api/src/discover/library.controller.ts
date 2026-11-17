/**
 * 素材库 HTTP 层（SPEC §1.5 注 / §3.9 最小可用 / 架构 §10.1 游标分页）。
 *  GET /library?q=&type=&license=&limit=&cursor=  → {items:Material[], nextCursor, total}
 *
 * 可见性由仓储 visible() 兜底（自有 OR 全局公共库 NULL，排除软删）；collected 按**用户任一 work**
 * 叠加（listCollectedMaterialIdsForUser，跨 work 去重）——素材库的收藏态是用户级，不是单 work 级（D-21）。
 * 非法游标是客户端输入错误 → 400 VALIDATION_FAILED（按结构化 code 分支，不解析 message）。
 *
 * [待确认 #16] 种子 library:true 8 条归属用户 + library:false 2 条全局（p2/p3），visible() 返回 10。
 * SPEC §3.9「素材库 8」与全局池是否计入素材库列表的口径分歧归 #16 裁决；本层忠实反映仓储可见性语义。
 *
 * G5：只读素材库，无平台发布写端点，不 import 发布 SDK。
 */
import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { LibraryQuery, MaterialSchema, pageOf, type Material } from '@knowstudio/contracts';
import type {
  LibraryFilter,
  MaterialPage,
  MaterialRepository,
  WorkMaterialRepository,
} from '@knowstudio/db/repositories';
import { AuthGuard } from '../auth/auth.guard.js';
import { MATERIAL_REPOSITORY, WORK_MATERIAL_REPOSITORY } from './discover.tokens.js';
import { parseOr400, requirePrincipal, validationFailed } from './http.js';
import { toMaterial } from './material-view.js';

@Controller('library')
@UseGuards(AuthGuard)
export class LibraryController {
  constructor(
    @Inject(MATERIAL_REPOSITORY) private readonly materials: MaterialRepository,
    @Inject(WORK_MATERIAL_REPOSITORY) private readonly workMaterials: WorkMaterialRepository,
  ) {}

  @Get()
  async list(
    @Req() request: Record<string, unknown>,
    @Query() query: unknown,
  ): Promise<{ items: Material[]; nextCursor: string | null; total: number }> {
    const principal = requirePrincipal(request);
    const { limit, cursor, q, type, license } = parseOr400(LibraryQuery, query);

    const repo = this.materials.forUser(principal.userId);
    const filter: LibraryFilter = {
      ...(q === undefined ? {} : { q }),
      ...(type === undefined ? {} : { type }),
      ...(license === undefined ? {} : { license }),
    };

    let page: MaterialPage;
    try {
      page = await repo.listLibrary(filter, { limit, ...(cursor === undefined ? {} : { cursor }) });
    } catch (err) {
      if ((err as { code?: string }).code === 'MATERIAL_CURSOR_INVALID') {
        throw validationFailed([
          { path: 'cursor', message: '游标非法：必须是服务端下发的 opaque cursor' },
        ]);
      }
      throw err;
    }
    const total = await repo.countLibrary(filter);

    // 素材库 collected 是用户级（任一 work 收藏即视为已收藏），跨 work 去重。
    const collected = new Set(
      await this.workMaterials.forUser(principal.userId).listCollectedMaterialIdsForUser(),
    );
    const items = page.items.map((row) => toMaterial(row, collected.has(row.id)));

    const parsed = pageOf(MaterialSchema).parse({ items, nextCursor: page.nextCursor, total });
    return { items: parsed.items, nextCursor: parsed.nextCursor, total };
  }
}