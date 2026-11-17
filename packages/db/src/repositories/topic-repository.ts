import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database } from '../schema/index.js';
import type { TopicBatchTable, TopicTable } from '../schema/discover.js';
import { toJsonParam } from '../schema/column-types.js';

export type TopicBatchRow = Selectable<TopicBatchTable>;
export type TopicRow = Selectable<TopicTable>;

export class TopicScopeRequiredError extends Error {
  readonly code = 'TOPIC_SCOPE_REQUIRED';
  constructor() {
    super('topic 仓储作用域必须绑定合法 userId：禁止无身份查询');
    this.name = 'TopicScopeRequiredError';
  }
}

export class TopicIdInvalidError extends Error {
  readonly code = 'TOPIC_ID_INVALID';
  constructor(readonly raw: string) {
    super('topic id 非法');
    this.name = 'TopicIdInvalidError';
  }
}

export interface TopicCandidate {
  readonly hook: string;
  readonly angle: string;
  readonly blankPoint: string;
  readonly basisMaterialIds: readonly string[];
  readonly embedding: readonly number[];
  readonly hookFingerprint: string;
  readonly diversityScore: number;
}

export interface TopicBatchResult {
  readonly batch: TopicBatchRow;
  readonly topics: readonly TopicRow[];
}

export interface ScopedTopicRepository {
  nextBatchIndex(workId: string): Promise<number>;
  listHookFingerprints(workId: string): Promise<string[]>;
  createBatch(
    workId: string,
    basedOnMaterialIds: readonly string[],
    topics: readonly TopicCandidate[],
    minPairwiseCosine: number,
  ): Promise<TopicBatchResult>;
  latestBatch(workId: string): Promise<TopicBatchResult | null>;
  batchByIndex(workId: string, batchIndex: number): Promise<TopicBatchResult | null>;
  findTopic(topicId: string): Promise<TopicRow | null>;
}

export interface TopicRepository {
  forUser(userId: string): ScopedTopicRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new TopicIdInvalidError(raw);
  return raw;
}

function newId(prefix: 'tb' | 't'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function createTopicRepository(db: Kysely<Database>): TopicRepository {
  return {
    forUser(userId: string): ScopedTopicRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId)) {
        throw new TopicScopeRequiredError();
      }
      const scopedBatch = () => db.selectFrom('topic_batch').where('user_id', '=', userId);
      const scopedTopic = () =>
        db
          .selectFrom('topic')
          .innerJoin('topic_batch', 'topic_batch.id', 'topic.batch_id')
          .where('topic_batch.user_id', '=', userId);

      const resultOf = async (batch: TopicBatchRow): Promise<TopicBatchResult> => ({
        batch,
        topics: await scopedTopic()
          .where('batch_id', '=', batch.id)
          .where('topic.work_id', '=', batch.work_id)
          .orderBy('ord', 'asc')
          .selectAll('topic')
          .execute(),
      });

      return {
        async nextBatchIndex(workId: string): Promise<number> {
          const row = await scopedBatch()
            .where('work_id', '=', assertId(workId))
            .select(sql<string>`MAX(batch_index)`.as('max'))
            .executeTakeFirst();
          return row?.max == null ? 1 : Number(row.max) + 1;
        },

        async listHookFingerprints(workId: string): Promise<string[]> {
          const rows = await scopedTopic()
            .where('topic.work_id', '=', assertId(workId))
            .select('hook_fingerprint')
            .execute();
          return rows.map((r) => r.hook_fingerprint);
        },

        async createBatch(
          workId: string,
          basedOnMaterialIds: readonly string[],
          topics: readonly TopicCandidate[],
          minPairwiseCosine: number,
        ): Promise<TopicBatchResult> {
          const w = assertId(workId);
          if (topics.length === 0) throw new Error('TOPIC_BATCH_EMPTY');
          const batchIndex = await this.nextBatchIndex(w);
          const batchId = newId('tb');
          await db.transaction().execute(async (trx) => {
            await trx
              .insertInto('topic_batch')
              .values({
                id: batchId,
                work_id: w,
                user_id: userId,
                batch_index: batchIndex,
                based_on_material_ids: toJsonParam([...basedOnMaterialIds]),
                hook_fingerprints: toJsonParam(topics.map((t) => t.hookFingerprint)),
                min_pairwise_cosine: minPairwiseCosine.toFixed(3),
                regen_attempts: Math.max(0, batchIndex - 1),
                effective_count: topics.length,
              })
              .execute();
            await trx
              .insertInto('topic')
              .values(
                topics.map((topic, index) => ({
                  id: newId('t'),
                  batch_id: batchId,
                  work_id: w,
                  hook: topic.hook,
                  angle: topic.angle,
                  blank_point: topic.blankPoint,
                  basis_material_ids: toJsonParam([...topic.basisMaterialIds]),
                  diversity_score: topic.diversityScore.toFixed(3),
                  embedding: toJsonParam([...topic.embedding]),
                  hook_fingerprint: topic.hookFingerprint,
                  ord: index,
                })),
              )
              .execute();
          });
          const batch = await scopedBatch()
            .where('id', '=', batchId)
            .selectAll()
            .executeTakeFirst();
          if (batch === undefined) throw new Error('TOPIC_BATCH_INSERT_FAILED');
          return resultOf(batch);
        },

        async latestBatch(workId: string): Promise<TopicBatchResult | null> {
          const batch = await scopedBatch()
            .where('work_id', '=', assertId(workId))
            .orderBy('batch_index', 'desc')
            .selectAll()
            .executeTakeFirst();
          return batch === undefined ? null : resultOf(batch);
        },

        async batchByIndex(workId: string, batchIndex: number): Promise<TopicBatchResult | null> {
          const batch = await scopedBatch()
            .where('work_id', '=', assertId(workId))
            .where('batch_index', '=', batchIndex)
            .selectAll()
            .executeTakeFirst();
          return batch === undefined ? null : resultOf(batch);
        },

        async findTopic(topicId: string): Promise<TopicRow | null> {
          const id = assertId(topicId);
          const batchIds = await db
            .selectFrom('topic_batch')
            .where('user_id', '=', userId)
            .select('id')
            .execute();
          if (batchIds.length === 0) return null;
          return (
            (await db
              .selectFrom('topic')
              .where('id', '=', id)
              .where(
                'batch_id',
                'in',
                batchIds.map((batch) => batch.id),
              )
              .selectAll()
              .executeTakeFirst()) ?? null
          );
        },
      };
    },
  };
}
