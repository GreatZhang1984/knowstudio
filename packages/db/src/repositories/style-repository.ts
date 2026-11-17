import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database } from '../schema/index.js';
import type { StyleSampleTable, StyleProfileTable } from '../schema/user.js';
import { toJsonParam } from '../schema/column-types.js';

export type StyleSampleRow = Selectable<StyleSampleTable>;
export type StyleProfileRow = Selectable<StyleProfileTable>;

export class StyleScopeRequiredError extends Error {
  readonly code = 'STYLE_SCOPE_REQUIRED';
  constructor() {
    super('style 仓储作用域必须绑定合法 userId');
    this.name = 'StyleScopeRequiredError';
  }
}

export interface ScopedStyleRepository {
  list(): Promise<readonly StyleSampleRow[]>;
  create(input: {
    title: string;
    content: string;
    source: 'upload' | 'paste';
  }): Promise<StyleSampleRow>;
  findByIds(ids: readonly string[]): Promise<readonly StyleSampleRow[]>;
  profile(): Promise<StyleProfileRow>;
}

export interface StyleRepository {
  forUser(userId: string): ScopedStyleRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

export function createStyleRepository(db: Kysely<Database>): StyleRepository {
  return {
    forUser(userId: string): ScopedStyleRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId))
        throw new StyleScopeRequiredError();

      return {
        list: () =>
          db
            .selectFrom('style_sample')
            .where('user_id', '=', userId)
            .orderBy('created_at', 'desc')
            .selectAll()
            .execute(),

        async create(input) {
          const id = `sty_${randomUUID().replace(/-/g, '')}`;
          const row = await db
            .insertInto('style_sample')
            .values({
              id,
              user_id: userId,
              title: input.title,
              content: input.content,
              source: input.source,
              status: 'ready',
              char_count: [...input.content].length,
            })
            .executeTakeFirstOrThrow();
          void row;
          await db
            .insertInto('style_profile')
            .values({
              user_id: userId,
              catchphrases: toJsonParam([]),
              sentence_patterns: toJsonParam([]),
              case_preferences: toJsonParam([]),
              tone: null,
              sample_count: 1,
              version: 1,
              is_default: 0,
              updated_at: sql`CURRENT_TIMESTAMP(3)`,
            })
            .onDuplicateKeyUpdate({
              sample_count: sql`sample_count + 1`,
              version: sql`version + 1`,
              is_default: 0,
              updated_at: sql`CURRENT_TIMESTAMP(3)`,
            })
            .execute();
          return db
            .selectFrom('style_sample')
            .where('id', '=', id)
            .selectAll()
            .executeTakeFirstOrThrow();
        },

        findByIds: (ids) =>
          db
            .selectFrom('style_sample')
            .where('user_id', '=', userId)
            .where('id', 'in', ids)
            .selectAll()
            .execute(),

        async profile() {
          const existing = await db
            .selectFrom('style_profile')
            .where('user_id', '=', userId)
            .selectAll()
            .executeTakeFirst();
          if (existing !== undefined) return existing;
          await db
            .insertInto('style_profile')
            .values({
              user_id: userId,
              catchphrases: toJsonParam([]),
              sentence_patterns: toJsonParam([]),
              case_preferences: toJsonParam([]),
              tone: null,
              sample_count: 0,
              version: 1,
              is_default: 1,
            })
            .execute();
          return db
            .selectFrom('style_profile')
            .where('user_id', '=', userId)
            .selectAll()
            .executeTakeFirstOrThrow();
        },
      };
    },
  };
}
