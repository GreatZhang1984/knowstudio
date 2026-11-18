import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  MaterialSourceConfigRequest,
  MaterialSourceConfigTestRequest,
  type MaterialSourceConfigResponse,
  type MaterialSourceConfigTestResponse,
  type MaterialSourcesResponse,
} from '@knowstudio/contracts';
import { AuthGuard } from '../auth/auth.guard.js';
import { MATERIAL_SOURCE_SERVICE } from './discover.tokens.js';
import { parseOr400, requirePrincipal, validationFailed } from './http.js';
import { MaterialSourceConfigInvalidError } from './material-source.service.js';
import type { MaterialSourceService } from './material-source.service.js';

@Controller('material-sources')
@UseGuards(AuthGuard)
export class MaterialSourcesController {
  constructor(@Inject(MATERIAL_SOURCE_SERVICE) private readonly sources: MaterialSourceService) {}

  @Get()
  async list(@Req() request: Record<string, unknown>): Promise<MaterialSourcesResponse> {
    return this.sources.list(requirePrincipal(request).userId);
  }

  @Get('config')
  async getConfig(@Req() request: Record<string, unknown>): Promise<MaterialSourceConfigResponse> {
    return this.sources.getConfig(requirePrincipal(request).userId);
  }

  @Put('config')
  async saveConfig(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<MaterialSourceConfigResponse> {
    const principal = requirePrincipal(request);
    try {
      return await this.sources.save(
        principal.userId,
        parseOr400(MaterialSourceConfigRequest, body),
      );
    } catch (error) {
      if (error instanceof MaterialSourceConfigInvalidError) throw validationFailed(error.fields);
      throw error;
    }
  }

  @Post('config/test')
  @HttpCode(200)
  async testConfig(
    @Req() request: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<MaterialSourceConfigTestResponse> {
    const principal = requirePrincipal(request);
    const input = parseOr400(MaterialSourceConfigTestRequest, body);
    return this.sources.test(principal.userId, input.sourceId);
  }

  @Delete('config/:sourceId')
  async deleteConfig(
    @Req() request: Record<string, unknown>,
    @Param('sourceId') sourceId: string,
  ): Promise<void> {
    const principal = requirePrincipal(request);
    if (sourceId !== 'web_search' && sourceId !== 'obsidian') {
      throw validationFailed([{ path: 'sourceId', message: '只支持 web_search 或 obsidian' }]);
    }
    await this.sources.remove(principal.userId, sourceId);
  }
}
