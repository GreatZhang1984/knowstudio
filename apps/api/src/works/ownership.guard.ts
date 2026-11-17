/**
 * OwnershipGuard —— 架构 §5.3 Guard 链第二环、§10.1「隔离」、§13「数据隔离」。
 *
 * ## 为什么是 404 而不是 403
 * 架构 §10.1（1826 行）：所有 `:id` 资源校验 `resource.userId === token.userId`，
 * **不匹配返回 404（不是 403），避免存在性枚举探测**。
 * 若「别人的作品」回 403、「不存在的作品」回 404，攻击者就能用状态差遍历出全站有效 workId。
 * 因此本 Guard 让两种情况走**同一条代码路径、同一个响应体**：
 * 仓储按 userId 作用域查询，「不属于你」与「不存在」都表现为 null，天然不可区分。
 *
 * ## 为什么放在 apps/api/src/works/ 而不是 shared/
 * 它需要 work 归属数据（仓储），属 works 领域；shared/ 由协调者冻结且只放跨域令牌与形状。
 *
 * ## 链序
 * AuthGuard（控制器级，WP12 提供）→ OwnershipGuard（路由级，本文件）→ …→ Handler。
 * Nest 的守卫执行序是 全局 → 控制器 → 路由，故控制器级 AuthGuard 必先于本 Guard。
 * 本 Guard 另外**自带 fail-closed**：读不到 principal 直接 401，
 * 即使上游漏挂 AuthGuard 也不会放行匿名请求（纵深防御，不替代 AuthGuard）。
 *
 * 本批只做前两环。GateGuard / IdempotencyInterceptor / QuotaInterceptor 属后续 Task，不提前实现。
 */
import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { NotFound, Unauthenticated } from '@knowstudio/contracts';
import type { WorkRepository, WorkRow } from '@knowstudio/db/repositories';
import { readPrincipal } from '../auth/auth.guard.js';
import { REQUEST_WORK_KEY, WORK_REPOSITORY } from './works.tokens.js';

type WorkRequest = {
  params?: Record<string, string | undefined>;
} & Record<string, unknown>;

/**
 * 唯一的「不存在或不属于你」响应。两条语义共用此函数，
 * 保证 status / code / message / details 逐字节相同（不可区分）。
 */
function notFound(): NotFoundException {
  return new NotFoundException(
    NotFound.parse({ code: 'NOT_FOUND', message: '作品不存在', details: {} }),
  );
}

function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException(
    Unauthenticated.parse({
      code: 'UNAUTHENTICATED',
      message: '未认证或会话已失效',
      details: { loginUrl: '/login' },
    }),
  );
}

@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(@Inject(WORK_REPOSITORY) private readonly works: WorkRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkRequest>();

    const principal = readPrincipal(request);
    if (principal === null) throw unauthenticated();

    const rawId = request.params?.['id'];
    if (typeof rawId !== 'string') throw notFound();

    let work: WorkRow | null;
    try {
      // 作用域已绑定 principal.userId：调用方无法查询他人数据。
      work = await this.works.forUser(principal.userId).findById(rawId);
    } catch (err) {
      // 按结构化 code 分支，绝不解析 message（工程纪律）。
      // 非法 id 不可能存在任何作品，故同样回 404 —— 若回 400 就又多一个可区分信号。
      if ((err as { code?: string }).code === 'WORK_ID_INVALID') throw notFound();
      throw err;
    }

    if (work === null) throw notFound();

    // 校验通过：把行挂到 request，handler 直接复用，避免二次点查与 TOCTOU 窗口。
    request[REQUEST_WORK_KEY] = work;
    return true;
  }
}