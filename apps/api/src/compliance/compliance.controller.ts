import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AttachMaterialLicenseRequest,
  type AttachMaterialLicenseResponse,
  type ComplianceReport,
  QueryBoolean,
} from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import { AuthGuard } from '../auth/auth.guard.js';
import { notFound, parseOr400, requirePrincipal } from '../discover/http.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import { ComplianceMaterialNotReferencedError, ComplianceService } from './compliance.service.js';

type WorkRequest = {
  readonly params?: Record<string, string | undefined>;
} & Record<string, unknown>;

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw notFound('作品不存在');
  return row;
}

@Controller('works')
@UseGuards(AuthGuard)
export class ComplianceController {
  constructor(@Inject(ComplianceService) private readonly compliance: ComplianceService) {}

  @Get(':id/compliance')
  @UseGuards(OwnershipGuard)
  async report(
    @Req() request: WorkRequest,
    @Query() query: unknown,
  ): Promise<ComplianceReport> {
    const force = parseOr400(QueryBoolean.optional(), (query as { force?: unknown }).force ?? 'false');
    return this.compliance.check(
      requirePrincipal(request).userId,
      attachedWork(request),
      force,
    );
  }

  @Post(':id/materials/:mid/license')
  @UseGuards(OwnershipGuard)
  @HttpCode(200)
  async attachLicense(
    @Req() request: WorkRequest,
    @Param('mid') materialId: string,
    @Body() body: unknown,
  ): Promise<AttachMaterialLicenseResponse> {
    const input = parseOr400(AttachMaterialLicenseRequest, body);
    try {
      return await this.compliance.attachLicense(
        requirePrincipal(request).userId,
        attachedWork(request),
        materialId,
        input,
      );
    } catch (err) {
      if (err instanceof ComplianceMaterialNotReferencedError) throw notFound('素材未被当前作品引用');
      throw err;
    }
  }
}
