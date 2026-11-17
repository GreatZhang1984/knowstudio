import { sql, type Kysely, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Quota } from '@knowstudio/contracts';
import type { Database } from '@knowstudio/db';

export type QuotaTransaction = Transaction<Database>;

export class QuotaAccountMissingError extends Error {
  readonly code = 'QUOTA_ACCOUNT_MISSING';
  constructor(readonly userId: string) {
    super(`用户 ${userId} 缺少配额账户`);
    this.name = 'QuotaAccountMissingError';
  }
}

export interface QuotaInsufficientDetail {
  readonly need: number;
  readonly left: number;
  readonly resetAt: string;
  readonly options: readonly { kind: string; label: string }[];
}

export class QuotaInsufficientError extends Error {
  readonly code = 'QUOTA_INSUFFICIENT';
  readonly details: QuotaInsufficientDetail;
  constructor(need: number, left: number, resetAt: string) {
    super('额度不足');
    this.name = 'QuotaInsufficientError';
    this.details = {
      need,
      left,
      resetAt,
      options: [
        { kind: 'upgrade', label: '升级套餐' },
        { kind: 'wait-reset', label: '等待月度重置' },
        { kind: 'draft', label: '先生成低清草稿' },
      ],
    };
  }
}

export class QuotaReservationStateError extends Error {
  readonly code = 'QUOTA_RESERVATION_STATE_INVALID';
  constructor(
    readonly reservationId: string,
    readonly state: string,
  ) {
    super(`配额预扣 ${reservationId} 状态不可结算：${state}`);
    this.name = 'QuotaReservationStateError';
  }
}

export function quotaOfRow(row: {
  total: number;
  used: number;
  reserved: number;
  reset_at: string;
}): Quota {
  return {
    total: row.total,
    used: row.used,
    reserved: row.reserved,
    left: row.total - row.used - row.reserved,
    resetAt: `${row.reset_at.replace(' ', 'T')}Z`,
  };
}

export async function readQuota(db: Kysely<Database>, userId: string): Promise<Quota> {
  const row = await db
    .selectFrom('quota_account')
    .where('user_id', '=', userId)
    .selectAll()
    .executeTakeFirst();
  if (row === undefined) throw new QuotaAccountMissingError(userId);
  return quotaOfRow(row);
}

export async function reserveQuotaInTransaction(
  trx: QuotaTransaction,
  input: { userId: string; workId: string; jobId: string; points: number },
): Promise<string | null> {
  if (input.points < 0) throw new Error('QUOTA_POINTS_INVALID');
  if (input.points === 0) return null;
  const account = await trx
    .selectFrom('quota_account')
    .where('user_id', '=', input.userId)
    .forUpdate()
    .selectAll()
    .executeTakeFirst();
  if (account === undefined) throw new QuotaAccountMissingError(input.userId);
  const left = account.total - account.used - account.reserved;
  if (input.points > left) {
    throw new QuotaInsufficientError(input.points, left, `${account.reset_at.replace(' ', 'T')}Z`);
  }

  const reservationId = `qr_${randomUUID().replace(/-/g, '')}`;
  await trx
    .insertInto('quota_reservation')
    .values({
      id: reservationId,
      user_id: input.userId,
      work_id: input.workId,
      job_id: input.jobId,
      points: input.points,
      state: 'held',
      expires_at: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 24 HOUR)`,
    })
    .execute();
  if (input.points > 0) {
    await trx
      .updateTable('quota_account')
      .set({ reserved: account.reserved + input.points, version: sql`version + 1` })
      .where('user_id', '=', input.userId)
      .execute();
    await trx
      .insertInto('quota_ledger')
      .values({
        user_id: input.userId,
        work_id: input.workId,
        job_id: input.jobId,
        reservation_id: reservationId,
        action: 'reserve',
        points: input.points,
        balance_after: left - input.points,
        idempotency_key: `reserve:${reservationId}`,
        note: '渲染预扣',
      })
      .execute();
  }
  return reservationId;
}

async function reservationOf(
  trx: QuotaTransaction,
  reservationId: string,
): Promise<{ id: string; user_id: string; points: number; state: string }> {
  const row = await trx
    .selectFrom('quota_reservation')
    .where('id', '=', reservationId)
    .selectAll()
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new QuotaReservationStateError(reservationId, 'missing');
  return row;
}

export async function commitQuotaInTransaction(
  trx: QuotaTransaction,
  reservationId: string,
): Promise<Quota> {
  const reservation = await reservationOf(trx, reservationId);
  if (reservation.state !== 'held') {
    throw new QuotaReservationStateError(reservationId, reservation.state);
  }
  const account = await trx
    .selectFrom('quota_account')
    .where('user_id', '=', reservation.user_id)
    .forUpdate()
    .selectAll()
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('quota_account')
    .set({
      used: account.used + reservation.points,
      reserved: account.reserved - reservation.points,
      version: sql`version + 1`,
    })
    .where('user_id', '=', reservation.user_id)
    .execute();
  await trx
    .updateTable('quota_reservation')
    .set({ state: 'committed', settled_at: sql`CURRENT_TIMESTAMP(3)` })
    .where('id', '=', reservationId)
    .execute();
  if (reservation.points > 0) {
    await trx
      .insertInto('quota_ledger')
      .values({
        user_id: reservation.user_id,
        reservation_id: reservationId,
        action: 'commit',
        points: reservation.points,
        balance_after: account.total - account.used - reservation.points,
        idempotency_key: `commit:${reservationId}`,
        note: '渲染完成',
      })
      .execute();
  }
  return quotaOfRow({
    ...account,
    used: account.used + reservation.points,
    reserved: account.reserved - reservation.points,
  });
}

export async function releaseQuotaInTransaction(
  trx: QuotaTransaction,
  reservationId: string,
  reason: string,
): Promise<Quota> {
  const reservation = await reservationOf(trx, reservationId);
  if (reservation.state !== 'held') {
    throw new QuotaReservationStateError(reservationId, reservation.state);
  }
  const account = await trx
    .selectFrom('quota_account')
    .where('user_id', '=', reservation.user_id)
    .forUpdate()
    .selectAll()
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('quota_account')
    .set({ reserved: account.reserved - reservation.points, version: sql`version + 1` })
    .where('user_id', '=', reservation.user_id)
    .execute();
  await trx
    .updateTable('quota_reservation')
    .set({ state: 'released', settled_at: sql`CURRENT_TIMESTAMP(3)` })
    .where('id', '=', reservationId)
    .execute();
  if (reservation.points > 0) {
    await trx
      .insertInto('quota_ledger')
      .values({
        user_id: reservation.user_id,
        reservation_id: reservationId,
        action: 'release',
        points: reservation.points,
        balance_after: account.total - account.used - (account.reserved - reservation.points),
        idempotency_key: `release:${reservationId}`,
        note: reason,
      })
      .execute();
  }
  return quotaOfRow({
    ...account,
    reserved: account.reserved - reservation.points,
  });
}
