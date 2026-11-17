import { sql } from 'kysely';
import type { Database, Kysely, Transaction } from '@knowstudio/db';
import type { MetricName, MetricSnapshotItem, MetricsResponse } from '@knowstudio/contracts';

export const METRIC_NAMES: readonly MetricName[] = [
  'g1_e2e_p50',
  'g2_daily_days',
  'g3_polish_p50',
  'g5_adapt_p50',
  'g5_platform_coverage',
  'g6_cost_per_work',
  'major_edit_rate',
  'avg_points_per_work',
  'render_failure_rate',
  'compliance_block_rate',
  'north_star_within_60m',
];

type MetricTransaction = Transaction<Database>;

interface EventRow {
  readonly user_id: string;
  readonly work_id: string | null;
  readonly event: string;
  readonly props: Record<string, unknown> | null;
  readonly occurred_at: string;
}

interface MetricRow {
  readonly metric: MetricName;
  readonly value_num: string;
  readonly sample_n: number;
  readonly bucket: string;
  readonly computed_at: string;
}

function hourBucket(date = new Date()): string {
  return `${date.toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');
}

function ms(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function numberOr(props: Record<string, unknown> | null, key: string): number | null {
  const value = props?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function metricCell(value: number | null, sample: number): { value_num: string; sample_n: number } {
  return value === null || !Number.isFinite(value)
    ? { value_num: '0.0000', sample_n: 0 }
    : { value_num: value.toFixed(4), sample_n: sample };
}

function finiteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function metricRows(trx: MetricTransaction, bucket: string): Promise<MetricRow[]> {
  const since = new Date(ms(bucket) - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
  const events = (await trx
    .selectFrom('analytics_event')
    .select(['user_id', 'work_id', 'event', 'props', 'occurred_at'])
    .where('event', 'in', [
      'work_created',
      'script_first_edit',
      'script_confirmed',
      'render_succeeded',
      'render_failed',
      'derivative_generated',
      'derivative_edited',
      'compliance_blocked',
      'export_completed',
      'publish_receipt_marked',
    ])
    .orderBy('occurred_at', 'asc')
    .execute()) as EventRow[];

  const workCreated = new Map<string, string>();
  const firstEdit = new Map<string, string>();
  const confirmed = new Map<string, string>();
  const derivativeGenerated = new Map<string, string[]>();
  const derivativeEdited = new Map<string, string>();
  const exportCompleted = new Map<string, string>();
  const blockedWorks = new Set<string>();
  const publishDates = new Set<string>();
  const renderSucceeded = new Set<string>();
  const renderFailed = new Set<string>();
  const platformIds = new Set<string>();
  let majorEdits = 0;
  let confirmedCount = 0;

  for (const row of events) {
    if (row.work_id === null) continue;
    if (!Number.isFinite(ms(row.occurred_at))) continue;
    switch (row.event) {
      case 'work_created':
        if (!workCreated.has(row.work_id)) workCreated.set(row.work_id, row.occurred_at);
        break;
      case 'script_first_edit':
        if (!firstEdit.has(row.work_id)) firstEdit.set(row.work_id, row.occurred_at);
        break;
      case 'script_confirmed': {
        if (!confirmed.has(row.work_id)) {
          confirmed.set(row.work_id, row.occurred_at);
          confirmedCount += 1;
          if ((numberOr(row.props, 'editDistanceRatio') ?? 0) > 0.3) majorEdits += 1;
        }
        break;
      }
      case 'derivative_generated': {
        const list = derivativeGenerated.get(row.work_id) ?? [];
        list.push(row.occurred_at);
        derivativeGenerated.set(row.work_id, list);
        if (typeof row.props?.platformId === 'string') platformIds.add(row.props.platformId);
        break;
      }
      case 'derivative_edited':
        if (!derivativeEdited.has(row.work_id)) derivativeEdited.set(row.work_id, row.occurred_at);
        break;
      case 'export_completed':
        if (!exportCompleted.has(row.work_id)) exportCompleted.set(row.work_id, row.occurred_at);
        break;
      case 'compliance_blocked':
        blockedWorks.add(row.work_id);
        break;
      case 'render_succeeded':
        renderSucceeded.add(row.work_id);
        break;
      case 'render_failed':
        renderFailed.add(row.work_id);
        break;
      case 'publish_receipt_marked':
        if (row.occurred_at >= since) publishDates.add(row.occurred_at.slice(0, 10));
        break;
    }
  }

  const e2eMinutes = [...exportCompleted.keys()]
    .filter((workId) => workCreated.has(workId))
    .map((workId) => (ms(exportCompleted.get(workId)!) - ms(workCreated.get(workId)!)) / 60_000);
  const polishMinutes = [...confirmed.keys()]
    .filter((workId) => firstEdit.has(workId))
    .map((workId) => (ms(confirmed.get(workId)!) - ms(firstEdit.get(workId)!)) / 60_000);
  const adaptMinutes = [...derivativeEdited.keys()]
    .filter((workId) => (derivativeGenerated.get(workId)?.length ?? 0) > 0)
    .map((workId) => {
      const generated = derivativeGenerated.get(workId)!.map(ms);
      return (ms(derivativeEdited.get(workId)!) - Math.min(...generated)) / 60_000;
    });

  const ai = await sql<{ total_cost: string | null; works: number }>`
    SELECT SUM(cost_cny) AS total_cost, COUNT(DISTINCT work_id) AS works
    FROM ai_call_log WHERE work_id IS NOT NULL
  `.execute(trx);
  const quota = await sql<{ points: string | null; works: number }>`
    SELECT SUM(points) AS points, COUNT(DISTINCT work_id) AS works
    FROM quota_ledger WHERE action = 'commit' AND work_id IS NOT NULL
  `.execute(trx);
  const compliance = await sql<{ works: number }>`
    SELECT COUNT(DISTINCT work_id) AS works FROM compliance_report
  `.execute(trx);

  const aiRow = ai.rows[0];
  const quotaRow = quota.rows[0];
  const renderTotal = renderSucceeded.size + renderFailed.size;
  const values: Record<MetricName, { value: number | null; sample: number }> = {
    g1_e2e_p50: { value: percentile(e2eMinutes, 0.5), sample: e2eMinutes.length },
    g2_daily_days: { value: publishDates.size, sample: publishDates.size },
    g3_polish_p50: { value: percentile(polishMinutes, 0.5), sample: polishMinutes.length },
    g5_adapt_p50: { value: percentile(adaptMinutes, 0.5), sample: adaptMinutes.length },
    g5_platform_coverage: { value: platformIds.size, sample: platformIds.size },
    g6_cost_per_work: {
      value:
        aiRow?.works && finiteNumber(aiRow.total_cost) !== null
          ? (finiteNumber(aiRow.total_cost) as number) / aiRow.works
          : null,
      sample: aiRow?.works ?? 0,
    },
    major_edit_rate: { value: ratio(majorEdits, confirmedCount), sample: confirmedCount },
    avg_points_per_work: {
      value:
        quotaRow?.works && finiteNumber(quotaRow.points) !== null
          ? (finiteNumber(quotaRow.points) as number) / quotaRow.works
          : null,
      sample: quotaRow?.works ?? 0,
    },
    render_failure_rate: { value: ratio(renderFailed.size, renderTotal), sample: renderTotal },
    compliance_block_rate: {
      value: ratio(blockedWorks.size, compliance.rows[0]?.works ?? 0),
      sample: compliance.rows[0]?.works ?? 0,
    },
    north_star_within_60m: {
      value: ratio(e2eMinutes.filter((minutes) => minutes <= 60).length, e2eMinutes.length),
      sample: e2eMinutes.length,
    },
  };

  return Object.entries(values).map(([metric, item]) => ({
    metric: metric as MetricName,
    ...metricCell(item.value, item.sample),
    bucket,
    computed_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
  }));
}

export async function computeMetricSnapshots(
  db: Kysely<Database>,
  bucket = hourBucket(),
): Promise<MetricName[]> {
  return db.transaction().execute(async (trx) => {
    const lock = await sql<{ locked: number }>`
      SELECT GET_LOCK('knowstudio:metric_hourly', 0) AS locked
    `.execute(trx);
    if (Number(lock.rows[0]?.locked ?? 0) !== 1) return [];
    try {
      const rows = await metricRows(trx, bucket);
      for (const row of rows) {
        await trx
          .insertInto('metric_snapshot')
          .values({
            metric: row.metric,
            scope: 'global',
            scope_id: '-',
            bucket: row.bucket,
            value_num: row.value_num,
            sample_n: row.sample_n,
            computed_at: row.computed_at,
          })
          .onDuplicateKeyUpdate({
            value_num: row.value_num,
            sample_n: row.sample_n,
            computed_at: row.computed_at,
          })
          .execute();
      }
      return rows.map((row) => row.metric);
    } finally {
      await sql`SELECT RELEASE_LOCK('knowstudio:metric_hourly')`.execute(trx);
    }
  });
}

export async function readMetrics(db: Kysely<Database>): Promise<MetricsResponse> {
  const rows = await db
    .selectFrom('metric_snapshot')
    .select(['metric', 'value_num', 'sample_n', 'bucket', 'computed_at'])
    .where('metric', 'in', [...METRIC_NAMES])
    .execute();
  const latest = new Map<MetricName, (typeof rows)[number]>();
  for (const row of rows) {
    const current = latest.get(row.metric as MetricName);
    if (current === undefined || ms(row.bucket) > ms(current.bucket))
      latest.set(row.metric as MetricName, row);
  }
  const items: MetricSnapshotItem[] = [...latest.values()].map((row) => ({
    metric: row.metric as MetricName,
    value: row.sample_n === 0 ? null : Number(row.value_num),
    sampleN: row.sample_n,
    bucket: `${row.bucket.replace(' ', 'T')}Z`,
    computedAt: `${row.computed_at.replace(' ', 'T')}Z`,
  }));
  const generatedAt = items.reduce<string | null>(
    (acc, item) => (acc === null || item.computedAt > acc ? item.computedAt : acc),
    null,
  );
  const fresh =
    latest.size === METRIC_NAMES.length &&
    generatedAt !== null &&
    Date.now() - Date.parse(generatedAt) < 2 * 60 * 60 * 1000;
  return {
    items,
    fresh,
    generatedAt,
    g4BlindTest: { source: 'manual', value: null },
  };
}
