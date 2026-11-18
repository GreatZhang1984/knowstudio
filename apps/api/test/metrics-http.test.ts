import 'reflect-metadata';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricRecomputeAccepted } from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('T-63 指标任务健康与受控重算', () => {
  let t: DiscoverTestApp;
  let runWorker: (db: DiscoverTestApp['db']) => Promise<void>;
  let storageRoot: string;
  let testStart: string;
  let manualDedupKey: string | null = null;
  let invalidDedupKey: string | null = null;
  const manualBucket =
    `${new Date(Date.now() - 3_600_000).toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');

  beforeAll(async () => {
    process.env['WORKER_STANDALONE'] = 'false';
    process.env['METRIC_RECOMPUTE_TOKEN'] = 'metric-operator-token';
    storageRoot = resolve('apps', 'worker', '.local-storage-metrics-http');
    process.env['LOCAL_STORAGE_ROOT'] = storageRoot;
    const worker = await import('../../worker/src/main.js');
    runWorker = worker.runOnce;
    t = await createDiscoverTestApp();
    testStart = new Date().toISOString().replace('T', ' ').replace('Z', '');
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      if (manualDedupKey !== null) {
        await t.db.deleteFrom('job_queue').where('dedup_key', '=', manualDedupKey).execute();
      }
      if (invalidDedupKey !== null) {
        await t.db.deleteFrom('job_queue').where('dedup_key', '=', invalidDedupKey).execute();
      }
      const currentBucket = `${new Date().toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');
      await t.db
        .deleteFrom('job_queue')
        .where('queue', '=', 'sys.metric')
        .where('dedup_key', '=', `metric:${currentBucket}`)
        .where('created_at', '>=', testStart)
        .execute();
      await t.db.deleteFrom('metric_snapshot').where('bucket', '=', manualBucket).execute();
      delete process.env['METRIC_RECOMPUTE_TOKEN'];
      await t.cleanup();
    }
    await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('受控重算入队指定 bucket，Worker 按 payload 聚合且任务状态可读取', async () => {
    const denied = await fetch(`${t.baseUrl}/api/metrics/recompute`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ bucket: `${manualBucket.replace(' ', 'T')}Z` }),
    });
    expect(denied.status).toBe(401);

    const invalid = await fetch(`${t.baseUrl}/api/metrics/recompute`, {
      method: 'POST',
      headers: { ...auth(t.tokenA), 'x-metric-recompute-token': 'metric-operator-token' },
      body: JSON.stringify({ bucket: new Date().toISOString() }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe('VALIDATION_FAILED');

    const acceptedRes = await fetch(`${t.baseUrl}/api/metrics/recompute`, {
      method: 'POST',
      headers: { ...auth(t.tokenA), 'x-metric-recompute-token': 'metric-operator-token' },
      body: JSON.stringify({ bucket: `${manualBucket.replace(' ', 'T')}Z` }),
    });
    expect(acceptedRes.status).toBe(202);
    const accepted = MetricRecomputeAccepted.parse(await acceptedRes.json());
    expect(accepted.bucket).toBe(`${manualBucket.replace(' ', 'T')}Z`);
    expect(accepted.queued).toBe(true);
    expect(accepted.dedupKey).not.toBeNull();
    manualDedupKey = accepted.dedupKey;

    await runWorker(t.db);
    const queueRow = await t.db
      .selectFrom('job_queue')
      .select(['state', 'attempt', 'started_at', 'finished_at', 'last_error'])
      .where('dedup_key', '=', manualDedupKey)
      .executeTakeFirstOrThrow();
    expect(queueRow.state).toBe('done');
    expect(queueRow.attempt).toBe(0);
    expect(queueRow.started_at).not.toBeNull();
    expect(queueRow.finished_at).not.toBeNull();
    expect(queueRow.last_error).toBeNull();

    const snapshots = await t.db
      .selectFrom('metric_snapshot')
      .select('metric')
      .where('bucket', '=', manualBucket)
      .execute();
    expect(snapshots).toHaveLength(11);

    const metricsRes = await fetch(`${t.baseUrl}/api/metrics`, { headers: auth(t.tokenA) });
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as {
      task: { bucket: string; status: string; durationMs: number | null } | null;
    };
    expect(metrics.task).not.toBeNull();
    expect(['queued', 'succeeded']).toContain(metrics.task?.status);

    await t.db
      .deleteFrom('job_queue')
      .where('queue', '=', 'sys.metric')
      .where('state', 'in', ['pending', 'leased'])
      .where('created_at', '>=', testStart)
      .execute();
    invalidDedupKey = `metric:invalid:${Date.now()}`;
    await t.db
      .insertInto('job_queue')
      .values({
        queue: 'sys.metric',
        job_id: null,
        user_id: null,
        payload: JSON.stringify({ bucket: 'invalid-bucket' }),
        state: 'pending',
        run_after: manualBucket,
        attempt: 0,
        max_attempt: 3,
        lease_token: '0',
        dedup_key: invalidDedupKey,
      })
      .execute();
    await runWorker(t.db);
    const failedRow = await t.db
      .selectFrom('job_queue')
      .select(['state', 'attempt', 'lease_owner', 'last_error'])
      .where('dedup_key', '=', invalidDedupKey)
      .executeTakeFirstOrThrow();
    expect(failedRow.state).toBe('pending');
    expect(failedRow.attempt).toBe(1);
    expect(failedRow.lease_owner).toBeNull();
    expect(failedRow.last_error).toMatchObject({
      code: 'METRIC_AGGREGATION_FAILED',
      message: 'METRIC_BUCKET_INVALID',
    });
  }, 120_000);
});
