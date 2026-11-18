import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '@knowstudio/db';

export type QueueTransaction = Transaction<Database>;

export interface EnqueueInput {
  readonly queue: string;
  readonly jobId?: string | null;
  readonly userId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly dedupKey: string;
}

interface ReadyQueueRow {
  readonly id: string;
  readonly job_id: string;
  readonly user_id: string;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
}

export interface ClaimedJob {
  readonly id: string;
  readonly queue: string;
  readonly jobId: string | null;
  readonly userId: string | null;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
  readonly leaseToken: string;
}

export async function enqueueInTransaction(
  trx: QueueTransaction,
  input: EnqueueInput,
): Promise<string> {
  const result = await trx
    .insertInto('job_queue')
    .values({
      queue: input.queue,
      job_id: input.jobId,
      user_id: input.userId,
      payload: JSON.stringify(input.payload ?? {}),
      state: 'pending',
      run_after: sql`CURRENT_TIMESTAMP(3)`,
      attempt: 0,
      max_attempt: 3,
      lease_token: '0',
      dedup_key: input.dedupKey,
    })
    .executeTakeFirst();
  return String(result.insertId);
}

export async function claimJob(
  db: Kysely<Database>,
  queue: string,
  owner: string,
): Promise<ClaimedJob | null> {
  return db.transaction().execute(async (trx) => {
    const rows = await sql<ReadyQueueRow>`
      SELECT id, job_id, user_id, payload, attempt
      FROM job_queue
      WHERE queue = ${queue}
        AND state = 'pending'
        AND run_after <= CURRENT_TIMESTAMP(3)
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `.execute(trx);
    const row = rows.rows[0];
    if (row === undefined) return null;

    await sql`
      UPDATE job_queue
      SET state = 'leased',
          lease_owner = ${owner},
          lease_token = LAST_INSERT_ID(lease_token + 1),
          lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 60 SECOND),
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3))
      WHERE id = ${row.id}
    `.execute(trx);
    const tokenRows = await sql<{ readonly lease_token: string }>`
      SELECT LAST_INSERT_ID() AS lease_token
    `.execute(trx);

    return {
      id: row.id,
      queue,
      jobId: row.job_id,
      userId: row.user_id,
      payload: row.payload,
      attempt: row.attempt,
      leaseToken: tokenRows.rows[0]?.lease_token ?? '0',
    };
  });
}

export async function renewLease(
  db: Kysely<Database>,
  jobId: string,
  owner: string,
  token: string,
): Promise<boolean> {
  const result = await db
    .updateTable('job_queue')
    .set({
      lease_expires_at: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 60 SECOND)`,
    })
    .where('job_id', '=', jobId)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', token)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function completeJob(
  db: Kysely<Database>,
  jobId: string,
  owner: string,
  token: string,
): Promise<boolean> {
  const result = await db
    .updateTable('job_queue')
    .set({
      state: 'done',
      finished_at: sql`CURRENT_TIMESTAMP(3)`,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
    })
    .where('job_id', '=', jobId)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', token)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/** 系统任务的 job_id 为 NULL，必须按队列行 id 完成，避免污染 render_job。 */
export async function completeClaimedJob(
  db: Kysely<Database>,
  owner: string,
  claimed: ClaimedJob,
): Promise<boolean> {
  const result = await db
    .updateTable('job_queue')
    .set({
      state: 'done',
      finished_at: sql`CURRENT_TIMESTAMP(3)`,
      lease_owner: null,
    })
    .where('id', '=', claimed.id)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', claimed.leaseToken)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function failJob(
  db: Kysely<Database>,
  jobId: string,
  owner: string,
  token: string,
  error: { readonly code: string; readonly message: string },
): Promise<'ready' | 'dead' | 'fenced'> {
  const rows = await db
    .selectFrom('job_queue')
    .select(['attempt', 'max_attempt'])
    .where('job_id', '=', jobId)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', token)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  if (rows === undefined) return 'fenced';

  const nextAttempt = rows.attempt + 1;
  const dead = nextAttempt >= rows.max_attempt;
  await db
    .updateTable('job_queue')
    .set({
      state: dead ? 'dead' : 'pending',
      attempt: nextAttempt,
      run_after: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL LEAST(300, 5 * POW(2, ${nextAttempt} - 1)) SECOND)`,
      last_error: JSON.stringify(error),
      lease_owner: null,
    })
    .where('job_id', '=', jobId)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', token)
    .execute();
  return dead ? 'dead' : 'ready';
}

/** 系统任务失败也按队列行 fencing，重试或死信并保留结构化错误。 */
export async function failClaimedJob(
  db: Kysely<Database>,
  owner: string,
  claimed: ClaimedJob,
  error: { readonly code: string; readonly message: string },
): Promise<'ready' | 'dead' | 'fenced'> {
  const rows = await db
    .selectFrom('job_queue')
    .select(['attempt', 'max_attempt'])
    .where('id', '=', claimed.id)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', claimed.leaseToken)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  if (rows === undefined) return 'fenced';

  const nextAttempt = rows.attempt + 1;
  const dead = nextAttempt >= rows.max_attempt;
  await db
    .updateTable('job_queue')
    .set({
      state: dead ? 'dead' : 'pending',
      attempt: nextAttempt,
      run_after: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL LEAST(300, 5 * POW(2, ${nextAttempt} - 1)) SECOND)`,
      last_error: JSON.stringify(error),
      lease_owner: null,
      lease_expires_at: null,
      finished_at: dead ? sql`CURRENT_TIMESTAMP(3)` : null,
    })
    .where('id', '=', claimed.id)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', claimed.leaseToken)
    .where('state', '=', 'leased')
    .execute();
  return dead ? 'dead' : 'ready';
}

export async function recoverExpiredLeases(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await sql<ReadyQueueRow & { attempt: number; max_attempt: number }>`
      SELECT id, job_id, user_id, payload, attempt, max_attempt
      FROM job_queue
      WHERE state = 'leased'
        AND lease_expires_at < CURRENT_TIMESTAMP(3)
      ORDER BY id ASC
      FOR UPDATE
    `.execute(trx);

    for (const row of rows.rows) {
      const nextAttempt = row.attempt + 1;
      const dead = nextAttempt >= row.max_attempt;
      await trx
        .updateTable('job_queue')
        .set({
          state: dead ? 'dead' : 'pending',
          attempt: nextAttempt,
          run_after: sql`CURRENT_TIMESTAMP(3)`,
          lease_owner: null,
          lease_expires_at: null,
          last_error: JSON.stringify({
            code: 'QUEUE_LEASE_EXPIRED',
            message: 'worker lease expired',
          }),
        })
        .where('id', '=', row.id)
        .execute();
    }
    return rows.rows.length;
  });
}

export async function cancelClaimedJob(
  db: Kysely<Database>,
  jobId: string,
  owner: string,
  token: string,
): Promise<boolean> {
  const result = await db
    .updateTable('job_queue')
    .set({
      state: 'canceled',
      finished_at: sql`CURRENT_TIMESTAMP(3)`,
      lease_owner: null,
    })
    .where('job_id', '=', jobId)
    .where('lease_owner', '=', owner)
    .where('lease_token', '=', token)
    .where('state', '=', 'leased')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
