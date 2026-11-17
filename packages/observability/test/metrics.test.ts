import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@knowstudio/db';
import { createAnalyticsRecorder, computeMetricSnapshots } from '../src/index.js';

describe('T-60 小时级指标聚合', () => {
  let handle: DbHandle;
  const workId = `w_t60_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const userId = `u_t60_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const bucket = `${new Date(Date.now() - 3_600_000).toISOString().slice(0, 13)}:00:00.000`.replace(
    'T',
    ' ',
  );

  beforeAll(() => {
    handle = createDb({ connectionLimit: 2 });
  });

  afterAll(async () => {
    await handle.db
      .deleteFrom('metric_snapshot')
      .where('bucket', '=', bucket)
      .execute();
    await handle.db.deleteFrom('analytics_event').where('work_id', '=', workId).execute();
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
