import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { MaterialSourcesResponse } from '@knowstudio/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { MATERIAL_SOURCES } from './discover.tokens.js';

@Controller('material-sources')
@UseGuards(AuthGuard)
export class MaterialSourcesController {
  constructor(@Inject(MATERIAL_SOURCES) private readonly sources: MaterialSourcesResponse) {}

  @Get()
  list(): MaterialSourcesResponse {
    return this.sources;
  }
}
