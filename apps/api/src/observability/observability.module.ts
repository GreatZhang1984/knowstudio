import type { Provider } from '@nestjs/common';
import type { MetricsResponse } from '@knowstudio/contracts';
import {
  createAnalyticsRecorder,
  readMetrics,
  type AnalyticsRecorder,
} from '@knowstudio/observability';
import { DB_CLIENT } from '../shared/tokens.js';
import { EventsController } from './events.controller.js';
import { MetricsController } from './metrics.controller.js';
import { ANALYTICS_RECORDER, METRICS_READER } from './observability.tokens.js';

export const OBSERVABILITY_PROVIDERS: Provider[] = [
  {
    provide: ANALYTICS_RECORDER,
    useFactory: (db: unknown): AnalyticsRecorder => createAnalyticsRecorder(db as never),
    inject: [DB_CLIENT],
  },
  {
    provide: METRICS_READER,
    useFactory: (db: unknown) => (): Promise<MetricsResponse> => readMetrics(db as never),
    inject: [DB_CLIENT],
  },
];

export const OBSERVABILITY_CONTROLLERS = [EventsController, MetricsController];
