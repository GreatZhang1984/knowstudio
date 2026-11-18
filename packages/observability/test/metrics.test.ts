import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@knowstudio/db';
import { createAnalyticsRecorder, computeMetricSnapshots, readMetrics } from '../src/index.js';

describe('T-60 小时级指标聚合', () => {
  let handle: DbHandle;
  const workId = `w_t60_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const userId = `u_t60_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const taskDedupKey = `metric-task:${randomUUID()}`;
  const bucket = `${new Date(Date.now() - 3_600_000).toISOString().slice(0, 13)}:00:00.000`.replace(
    'T',
    ' ',
  );
  const finishedAt = new Date(Date.parse(`${bucket.replace(' ', 'T')}Z`) + 2_000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');

  beforeAll(() => {
    handle = createDb({ connectionLimit: 2 });
  });

  afterAll(async () => {
    await handle.db.deleteFrom('metric_snapshot').where('bucket', '=', bucket).execute();
    await handle.db.deleteFrom('analytics_event').where('work_id', '=', workId).execute();
    await handle.db.deleteFrom('job_queue').where('dedup_key', '=', taskDedupKey).execute();
    await handle.destroy();
  });

  it('同一 bucket 重复执行只 upsert，不产生重复快照', async () => {
    const recorder = createAnalyticsRecorder(handle.db);
    const at = (minutesAgo: number): string =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await recorder.record({
      userId,
      workId,
      event: 'work_created',
      occurredAt: at(2),
    });
    await recorder.record({
      userId,
      workId,
      event: 'export_completed',
      occurredAt: at(1),
    });

    await computeMetricSnapshots(handle.db, bucket);
    const response = await readMetrics(handle.db);
    expect(response.dataStatus).toBe('fresh');
    expect(response.expectedBucket).toMatch(/T00:00:00\.000Z$|T\d{2}:00:00\.000Z$/u);

    await handle.db
      .insertInto('job_queue')
      .values({
        queue: 'sys.metric',
        job_id: null,
        user_id: null,
        payload: JSON.stringify({ bucket }),
        state: 'done',
        run_after: bucket,
        attempt: 1,
        max_attempt: 3,
        lease_token: '1',
        dedup_key: taskDedupKey,
        started_at: bucket,
        finished_at: finishedAt,
        last_error: null,
      })
      .execute();
    const responseWithTask = await readMetrics(handle.db);
    expect(responseWithTask.task).toMatchObject({
      bucket: `${bucket.replace(' ', 'T')}Z`,
      status: 'succeeded',
      state: 'done',
      attempt: 1,
      maxAttempt: 3,
      durationMs: 2000,
      lastError: null,
    });

    const first = await handle.db
      .selectFrom('metric_snapshot')
      .select(['metric', 'value_num', 'sample_n'])
      .where('bucket', '=', bucket)
      .execute();
    await computeMetricSnapshots(handle.db, bucket);
    const second = await handle.db
      .selectFrom('metric_snapshot')
      .select(['metric', 'value_num', 'sample_n'])
      .where('bucket', '=', bucket)
      .orderBy('metric')
      .execute();

    expect(first).toHaveLength(11);
    expect(second).toHaveLength(11);
    expect(second.map((row) => `${row.metric}:${row.value_num}`)).toEqual(
      first
        .slice()
        .sort((a, b) => a.metric.localeCompare(b.metric))
        .map((row) => `${row.metric}:${row.value_num}`),
    );
  });
});
