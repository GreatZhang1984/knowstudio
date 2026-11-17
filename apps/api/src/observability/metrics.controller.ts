import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { MetricsResponse } from '@knowstudio/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { METRICS_READER } from './observability.tokens.js';

@Controller('metrics')
@UseGuards(AuthGuard)
export class MetricsController {
  constructor(
    @Inject(METRICS_READER) private readonly read: () => Promise<MetricsResponse>,
  ) {}

  @Get()
  async list(): Promise<MetricsResponse> {
    return this.read();
  }
}
