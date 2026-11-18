import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../schema/index.js';
import type { UserSourceConfigTable } from '../schema/user.js';
import { toJsonParam } from '../schema/column-types.js';

export type UserSourceConfigRow = Selectable<UserSourceConfigTable>;

export interface SaveUserSourceConfigInput {
  readonly sourceId: UserSourceConfigRow['source_id'];
  readonly enabled: boolean;
  readonly settings: Record<string, unknown>;
  readonly credentialCiphertext: string | null;
  readonly credentialLast4: string | null;
}

export interface ScopedUserSourceConfigRepository {
  list(): Promise<UserSourceConfigRow[]>;
  upsert(input: SaveUserSourceConfigInput): Promise<UserSourceConfigRow>;
  markTested(sourceId: SaveUserSourceConfigInput['sourceId']): Promise<void>;
  delete(sourceId: SaveUserSourceConfigInput['sourceId']): Promise<boolean>;
}

export interface UserSourceConfigRepository {
  forUser(userId: string): ScopedUserSourceConfigRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function utcLiteral(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export function createUserSourceConfigRepository(db: Kysely<Database>): UserSourceConfigRepository {
  return {
    forUser(userId: string): ScopedUserSourceConfigRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId)) {
        throw new Error('USER_SOURCE_CONFIG_USER_INVALID');
      }

      return {
        async list(): Promise<UserSourceConfigRow[]> {
          return db
            .selectFrom('user_source_config')
            .where('user_id', '=', userId)
            .selectAll()
            .orderBy('source_id')
            .execute();
        },

        async upsert(input: SaveUserSourceConfigInput): Promise<UserSourceConfigRow> {
          const values = {
            user_id: userId,
            source_id: input.sourceId,
            enabled: (input.enabled ? 1 : 0) as 0 | 1,
            settings: toJsonParam(input.settings),
            credential_ciphertext: input.credentialCiphertext,
            credential_last4: input.credentialLast4,
          };
          await db
            .insertInto('user_source_config')
            .values(values)
            .onDuplicateKeyUpdate({
              enabled: values.enabled,
              settings: values.settings,
              credential_ciphertext: values.credential_ciphertext,
              credential_last4: values.credential_last4,
              tested_at: null,
            })
            .execute();
          const row = await db
            .selectFrom('user_source_config')
            .where('user_id', '=', userId)
            .where('source_id', '=', input.sourceId)
            .selectAll()
            .executeTakeFirst();
          if (row === undefined) throw new Error('USER_SOURCE_CONFIG_UPSERT_FAILED');
          return row;
        },

        async markTested(sourceId: SaveUserSourceConfigInput['sourceId']): Promise<void> {
          await db
            .updateTable('user_source_config')
            .set({ tested_at: utcLiteral(new Date()) })
            .where('user_id', '=', userId)
            .where('source_id', '=', sourceId)
            .execute();
        },

        async delete(sourceId: SaveUserSourceConfigInput['sourceId']): Promise<boolean> {
          const rows = await db
            .deleteFrom('user_source_config')
            .where('user_id', '=', userId)
            .where('source_id', '=', sourceId)
            .executeTakeFirst();
          return Number(rows?.numDeletedRows ?? 0) > 0;
        },
      };
    },
  };
}
