import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateStyleSampleRequest,
  StyleProfileSchema,
  StyleSampleSchema,
} from '@knowstudio/contracts';
import type { StyleRepository } from '@knowstudio/db/repositories';
import { AuthGuard } from '../auth/auth.guard.js';
import { STYLE_REPOSITORY } from './discover.tokens.js';
import { parseOr400, requirePrincipal } from './http.js';

function toRfc3339(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

@Controller()
@UseGuards(AuthGuard)
export class StyleController {
  constructor(@Inject(STYLE_REPOSITORY) private readonly styles: StyleRepository) {}

  @Get('style-samples')
  async list(@Req() request: Record<string, unknown>) {
    const principal = requirePrincipal(request);
    const rows = await this.styles.forUser(principal.userId).list();
    return StyleSampleSchema.array().parse(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        source: row.source,
        status: row.status,
        charCount: row.char_count,
        createdAt: toRfc3339(row.created_at),
      })),
    );
  }

  @Post('style-samples')
  @HttpCode(202)
  async create(@Req() request: Record<string, unknown>, @Body() body: unknown) {
    const principal = requirePrincipal(request);
    const input = parseOr400(CreateStyleSampleRequest, body);
    const row = await this.styles.forUser(principal.userId).create(input);
    return StyleSampleSchema.parse({
      id: row.id,
      title: row.title,
      source: row.source,
      status: row.status,
      charCount: row.char_count,
      createdAt: toRfc3339(row.created_at),
    });
  }

  @Get('style-profile')
  async profile(@Req() request: Record<string, unknown>, @Query() _query: unknown) {
    const principal = requirePrincipal(request);
    const row = await this.styles.forUser(principal.userId).profile();
    return StyleProfileSchema.parse({
      catchphrases: row.catchphrases,
      sentencePatterns: row.sentence_patterns,
      casePreferences: row.case_preferences,
      tone: row.tone,
      sampleCount: row.sample_count,
      version: row.version,
      isDefault: row.is_default === 1,
      updatedAt: toRfc3339(row.updated_at),
    });
  }
}
