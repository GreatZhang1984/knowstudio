import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@knowstudio/db';
import {
  claimJob,
  completeJob,
  enqueueInTransaction,
  recoverExpiredLeases,
  renewLease,
} from '../src/index';

describe('T-44 持久队列租约与 fencing', () => {
  let handle: DbHandle;
  const jobId = `job_queue_fence_${Date.now()}`;
  const expiredJobId = `job_queue_expired_${Date.now()}`;
  const deadJobId = `job_queue_dead_${Date.now()}`;

  beforeAll(() => {
    handle = createDb({ connectionLimit: 2 });
  });

  afterAll(async () => {
    await handle.db
      .deleteFrom('job_queue')
      .where('job_id', 'in', [jobId, expiredJobId, deadJobId])
      .execute();
    await handle.destroy();
  });

  it('同一任务只有一个 claim；错误 token 无法续租或完成', async () => {
    await handle.db.transaction().execute(async (trx) => {
      await enqueueInTransaction(trx, {
        queue: 'render.hd',
        jobId,
        userId: 'u_queue_test_000000000000000',
        payload: { test: true },
        dedupKey: `queue-test:${jobId}`,
      });
    });

    const claimed = await claimJob(handle.db, 'render.hd', 'worker-a');
    expect(claimed?.jobId).toBe(jobId);
    expect(await claimJob(handle.db, 'render.hd', 'worker-b')).toBeNull();
    expect(await renewLease(handle.db, jobId, 'worker-a', '0')).toBe(false);
    expect(await completeJob(handle.db, jobId, 'worker-a', '0')).toBe(false);
    expect(await renewLease(handle.db, jobId, 'worker-a', claimed!.leaseToken)).toBe(true);
    expect(await completeJob(handle.db, jobId, 'worker-a', claimed!.leaseToken)).toBe(true);
  });

  it('租约过期后重投；旧 token 被 fencing 拒绝；达到上限进入死信', async () => {
    await handle.db.transaction().execute(async (trx) => {
      await enqueueInTransaction(trx, {
        queue: 'render.hd',
        jobId: expiredJobId,
        userId: 'u_queue_test_000000000000000',
        payload: { test: true },
        dedupKey: `queue-expired:${expiredJobId}`,
      });
      await enqueueInTransaction(trx, {
        queue: 'render.hd',
        jobId: deadJobId,
        userId: 'u_queue_test_000000000000000',
        payload: { test: true },
        dedupKey: `queue-dead:${deadJobId}`,
      });
    });

    const expired = await claimJob(handle.db, 'render.hd', 'worker-old');
    const dead = await claimJob(handle.db, 'render.hd', 'worker-old');
    expect(expired?.jobId).toBe(expiredJobId);
    expect(dead?.jobId).toBe(deadJobId);
    await handle.db
      .updateTable('job_queue')
      .set({ max_attempt: 1 })
      .where('job_id', '=', deadJobId)
      .execute();
    await handle.db
      .updateTable('job_queue')
      .set({ lease_expires_at: '2000-01-01 00:00:00.000' })
      .where('job_id', 'in', [expiredJobId, deadJobId])
      .execute();

    expect(await recoverExpiredLeases(handle.db)).toBe(2);
    expect(await renewLease(handle.db, expiredJobId, 'worker-old', expired!.leaseToken)).toBe(false);
    const reclaimed = await claimJob(handle.db, 'render.hd', 'worker-new');
    expect(reclaimed?.jobId).toBe(expiredJobId);
    expect(reclaimed?.attempt).toBe(1);

    const deadRow = await handle.db
      .selectFrom('job_queue')
      .select(['state', 'attempt'])
      .where('job_id', '=', deadJobId)
      .executeTakeFirstOrThrow();
    expect(deadRow.state).toBe('dead');
    expect(deadRow.attempt).toBe(1);

    expect(await completeJob(handle.db, expiredJobId, 'worker-new', reclaimed!.leaseToken)).toBe(true);
  });
});
