import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ComplianceBlocked,
  GateNotSatisfied,
  NotFound,
  type ExportAccepted,
  type ExportPackage,
} from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';
import { AuthGuard } from '../auth/auth.guard.js';
import { requirePrincipal } from '../discover/http.js';
import { OwnershipGuard } from '../works/ownership.guard.js';
import { REQUEST_WORK_KEY } from '../works/works.tokens.js';
import {
  ExportComplianceBlockedError,
  ExportGateNotSatisfiedError,
  ExportMediaNotReadyError,
  ExportService,
} from './export.service.js';

type WorkRequest = Record<string, unknown> & {
  readonly params?: Record<string, string | undefined>;
};

function attachedWork(request: WorkRequest): WorkRow {
  const row = request[REQUEST_WORK_KEY] as WorkRow | undefined;
  if (row === undefined) throw new Error('WORK_NOT_ATTACHED');
  return row;
}

@Controller()
@UseGuards(AuthGuard)
export class ExportController {
  constructor(@Inject(ExportService) private readonly exports: ExportService) {}

  @Post('works/:id/export')
  @UseGuards(OwnershipGuard)
  @HttpCode(202)
  async create(@Req() request: WorkRequest): Promise<ExportAccepted> {
    const work = attachedWork(request);
    try {
      return await this.exports.enqueue(requirePrincipal(request).userId, work);
    } catch (error) {
      if (error instanceof ExportComplianceBlockedError) {
        throw new HttpException(
          ComplianceBlocked.parse({
            code: 'COMPLIANCE_BLOCKED',
            message: '合规检查存在阻断项，先完成修复再导出',
            details: {
              reportId: error.report.id,
              blockingItems: error.report.items.filter((item) => item.blocking),
            },
          }),
          422,
        );
      }
      if (error instanceof ExportGateNotSatisfiedError) {
        throw new ConflictException(
          GateNotSatisfied.parse({
            code: 'GATE_NOT_SATISFIED',
            message: '合规门未解锁，不能导出',
            details: {
              requiredGate: 'G4',
              redirectTo: `/publish/${work.id}`,
              reason: 'COMPLIANCE_REPORT_MISSING',
            },
          }),
        );
      }
      if (error instanceof ExportMediaNotReadyError) {
        throw new ConflictException(
          GateNotSatisfied.parse({
            code: 'GATE_NOT_SATISFIED',
            message: '平台媒体未生成完成，不能导出',
            details: {
              requiredGate: 'G3',
              redirectTo: `/studio/${work.id}/video`,
              reason: 'HD_RENDER_NOT_SUCCEEDED',
            },
          }),
        );
      }
      throw error;
    }
  }

  @Get('exports/:exportId')
  async detail(
    @Req() request: WorkRequest,
    @Param('exportId') exportId: string,
  ): Promise<ExportPackage> {
    try {
      return await this.exports.read(requirePrincipal(request).userId, exportId);
    } catch (error) {
      if ((error as { code?: string }).code === 'EXPORT_NOT_FOUND') {
        throw new HttpException(
          NotFound.parse({ code: 'NOT_FOUND', message: '导出包不存在', details: {} }),
          404,
        );
      }
      throw error;
    }
  }
}
