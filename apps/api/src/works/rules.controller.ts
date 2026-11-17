import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { PlatformRuleSchema, type PlatformRule } from '@knowstudio/contracts';
import type { Database, Kysely } from '@knowstudio/db';
import { AuthGuard } from '../auth/auth.guard.js';
import { DB_CLIENT } from '../shared/tokens.js';

@Controller('platform-rules')
@UseGuards(AuthGuard)
export class PlatformRuleController {
  constructor(@Inject(DB_CLIENT) private readonly db: Kysely<Database>) {}

  @Get()
  async list(): Promise<PlatformRule[]> {
    const rows = await this.db
      .selectFrom('platform_rule')
      .selectAll()
      .where('is_current', '=', 1)
      .orderBy('platform_id', 'asc')
      .execute();
    return rows.map((row) =>
      PlatformRuleSchema.parse({
        platformId: row.platform_id,
        version: row.version,
        name: row.name,
        ratio: row.ratio,
        isCurrent: row.is_current === 1,
        titleMax: row.title_max,
        titleHardMax: row.title_hard_max,
        tagMax: row.tag_max,
        maxDurationSec: row.max_duration,
        orient: row.orient,
        brandColor: row.brand_color,
        styleHint: row.style_hint,
        bannedPatterns: row.banned_patterns,
        updatedAt: `${row.updated_at.replace(' ', 'T')}Z`,
      }),
    );
  }
}
