/**
 * 搜索 HTTP 层（SPEC §5 搜索行 / 架构 §10.1·§10.4）。
 *  POST /discover/search      202{searchId}（受理，进程内异步）/ 200{session}（24h 缓存命中）
 *  GET  /discover/search/:id  轮询读持久化会话（五态由 status+materials+partialErrors 决定）
 *
 * Guard 链：AuthGuard（控制器级）→ Handler。搜索不带 :id 资源归属（workId 在 body，由服务校验），
 * 故不挂 OwnershipGuard；GET :id 的会话归属由服务按 user_id 作用域兜底（不存在/不属于你→404）。
 *
 * G5：本控制器只读素材/落搜索会话，无任何平台发布写端点，不 import 发布 SDK。
 */
import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SearchAccepted, SearchRequest, type SearchSession } from '@knowstudio/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { DiscoverService } from './discover.service.js';
import { parseOr400, requirePrincipal, type HttpResponse } from './http.js';

@Controller('discover')
@UseGuards(AuthGuard)
export class DiscoverController {
  constructor(@Inject(DiscoverService) private readonly discover: DiscoverService) {}

  /**
   * 动态状态码：命中 200 / 受理 202。用 @Res()（非 passthrough）手动 status().json()，
   * 避免 Nest 默认 POST 201 覆盖处理器设的状态（passthrough 下默认码会回写，故不用）。
   */
  @Post('search')
  async search(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const principal = requirePrincipal(request);
    const input = parseOr400(SearchRequest, body);
    const outcome = await this.discover.search(principal.userId, input);
    if (outcome.kind === 'hit') {
      res.status(200).json(outcome.session);
      return;
    }
    res.status(202).json(SearchAccepted.parse({ searchId: outcome.searchId, cacheHit: false }));
  }

  @Get('search/:id')
  async getSession(
    @Req() request: Record<string, unknown>,
    @Param('id') id: string,
  ): Promise<SearchSession> {
    const principal = requirePrincipal(request);
    return this.discover.getSession(principal.userId, id);
  }
}