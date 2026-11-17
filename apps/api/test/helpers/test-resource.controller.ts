/**
 * 测试夹具：演示 AuthGuard + 归属校验的跨用户 404 语义（与 WP11 OwnershipGuard 对齐）。
 * 真实的 /works 归属校验属 WP11（src/works/，不在本工作包）；本夹具仅在测试里证明
 * 「用户 A 的 token 拿不到用户 B 的资源 → 404 NOT_FOUND」这条 DoD。
 */
import { Controller, Get, HttpException, Param, Req, UseGuards } from '@nestjs/common';
import { NotFound } from '@knowstudio/contracts';
import { AuthGuard, readPrincipal } from '../../src/auth/auth.guard.js';

export interface TestResource {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
}

@Controller('test-resources')
export class TestResourceController {
  private readonly resources = new Map<string, TestResource>();

  seed(resource: TestResource): void {
    this.resources.set(resource.id, resource);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  get(@Req() req: Record<string, unknown>, @Param('id') id: string): TestResource {
    const principal = readPrincipal(req);
    const resource = this.resources.get(id);
    // 不存在**或不属于你**一律 404（arch §10.1，避免枚举探测），不是 403。
    if (resource === undefined || principal === null || resource.userId !== principal.userId) {
      throw new HttpException(
        NotFound.parse({ code: 'NOT_FOUND', message: '不存在或不属于你', details: {} }),
        404,
      );
    }
    return resource;
  }
}