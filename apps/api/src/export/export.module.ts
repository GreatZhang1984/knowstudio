import type { Provider, Type } from '@nestjs/common';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

export const EXPORT_PROVIDERS: Provider[] = [ExportService];
export const EXPORT_CONTROLLERS: Type[] = [ExportController];
