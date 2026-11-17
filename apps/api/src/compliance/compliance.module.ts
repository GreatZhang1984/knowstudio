import type { Provider, Type } from '@nestjs/common';
import { ComplianceController } from './compliance.controller.js';
import { ComplianceService } from './compliance.service.js';

export const COMPLIANCE_PROVIDERS: Provider[] = [ComplianceService];
export const COMPLIANCE_CONTROLLERS: Type[] = [ComplianceController];
