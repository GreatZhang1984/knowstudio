import type { AnalyticsEventName } from '@knowstudio/contracts';
import { toJsonParam, type Database, type Kysely } from '@knowstudio/db';

export interface RecordAnalyticsEventInput {
  readonly userId: string;
  readonly workId?: string | null;
  readonly event: AnalyticsEventName;
  readonly props?: Record<string, unknown>;
  readonly occurredAt?: string;
}

export interface AnalyticsRecorder {
  record(input: RecordAnalyticsEventInput): Promise<void>;
  recordMany(inputs: readonly RecordAnalyticsEventInput[]): Promise<void>;
}

function dbLiteral(value: string): string {
  return value.replace('T', ' ').replace('Z', '');
}

/** 埋点失败只记录错误，不阻断业务动作；关键事件仍由业务事务后的调用点触发。 */
export function createAnalyticsRecorder(db: Kysely<Database>): AnalyticsRecorder {
  const record = async (input: RecordAnalyticsEventInput): Promise<void> => {
    try {
      await db
        .insertInto('analytics_event')
        .values({
          user_id: input.userId,
          work_id: input.workId ?? null,
          event: input.event,
          props: toJsonParam(input.props ?? {}),
          occurred_at: dbLiteral(input.occurredAt ?? new Date().toISOString()),
        })
        .execute();
    } catch (error) {
      console.error('[observability] analytics event failed', error);
    }
  };

  return {
    record,
    async recordMany(inputs) {
      for (const input of inputs) await record(input);
    },
  };
}
