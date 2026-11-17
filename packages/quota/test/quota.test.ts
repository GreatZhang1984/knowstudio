import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, seedId, type DbHandle } from '@knowstudio/db';
import { QuotaInsufficientError, readQuota, reserveQuotaInTransaction } from '../src/index';

describe('T-42/T-43 配额行锁与预扣', () => {
  let handle: DbHandle;
  let workId: string;

  beforeAll(() => {
    handle = createDb({ connectionLimit: 5 });
    workId = `w_quota_${Math.random().toString(36).slice(2, 10)}`;
  });

  afterAll(async () => {
    await handle.db.deleteFrom('quota_ledger').where('work_id', '=', workId).execute();
    await handle.db.deleteFrom('quota_reservation').where('work_id', '=', workId).execute();
    await handle.db
      .updateTable('quota_account')
      .set({ used: 22, reserved: 0 })
      .where('user_id', '=', seedId('u', 'u1'))
      .execute();
    await handle.destroy();
  });

  it('并发 20 笔 2 点预扣：最多保留 19 笔，绝不超支', async () => {
    const userId = seedId('u', 'u1');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        handle.db.transaction().execute(async (trx) =>
          reserveQuotaInTransaction(trx, {
            userId,
            workId,
            jobId: `job_quota_parallel_${String(index).padStart(2, '0')}`,
            points: 2,
          }),
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(19);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(QuotaInsufficientError);
    const quota = await readQuota(handle.db, userId);
    expect(quota.reserved).toBe(38);
    expect(quota.left).toBe(0);
  });
});
