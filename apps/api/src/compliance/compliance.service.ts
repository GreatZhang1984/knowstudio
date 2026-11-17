import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ComplianceReportSchema,
  type ComplianceReport,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import { buildComplianceReport, type ComplianceMaterial } from '@knowstudio/compliance';
import { toJsonParam, type Database, type Kysely } from '@knowstudio/db';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { AnalyticsRecorder } from '@knowstudio/observability';
import { assembleWorkEnvelope } from '../works/work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../works/work-ports.js';
import {
  WORK_QUOTA_READER,
  WORK_TRUTH_SNAPSHOT,
} from '../works/works.tokens.js';
import { DB_CLIENT } from '../shared/tokens.js';
import { ANALYTICS_RECORDER } from '../observability/observability.tokens.js';

export class ComplianceMaterialNotReferencedError extends Error {
  readonly code = 'COMPLIANCE_MATERIAL_NOT_REFERENCED';
  constructor() {
    super('素材未被当前作品引用');
    this.name = 'ComplianceMaterialNotReferencedError';
  }
}

function utcLiteralNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function evidenceExpiresAt(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function evidenceVersion(value: unknown): number {
  const version = (value as { version?: unknown } | null)?.version;
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 0;
}

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
    @Inject(ANALYTICS_RECORDER) private readonly analytics: AnalyticsRecorder,
  ) {}

  async check(userId: string, work: WorkRow, force = false): Promise<ComplianceReport> {
    const snapshot = await this.snapshots.load(work);
    const built = buildComplianceReport({
      snapshot,
      materials: await this.materialsFor(userId, work.id),
      scriptLines: await this.scriptLinesFor(userId, work.id),
      bannedPatterns: await this.bannedPatterns(),
      now: new Date().toISOString(),
    });
    if (built.blockingCount > 0) {
      await this.analytics.record({
        userId,
        workId: work.id,
        event: 'compliance_blocked',
        props: { blockingCount: built.blockingCount, warnCount: built.warnCount },
      });
    }

    const cached = await this.db
      .selectFrom('compliance_report')
      .selectAll()
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .where('fingerprint', '=', built.fingerprint)
      .executeTakeFirst();
    if (cached !== undefined && !force) return this.toReport(cached);

    const id = `cr_${randomUUID().replace(/-/g, '')}`;
    try {
      await this.db
        .insertInto('compliance_report')
        .values({
          id,
          work_id: work.id,
          user_id: userId,
          items: toJsonParam(built.items),
          blocking_count: built.blockingCount,
          warn_count: built.warnCount,
          fingerprint: built.fingerprint,
          checked_at: utcLiteralNow(),
        })
        .execute();
    } catch {
      // 同指纹缓存被并发写入时复用先落库的报告；不同真相的指纹不受 uq 影响。
      const existing = await this.db
        .selectFrom('compliance_report')
        .selectAll()
        .where('work_id', '=', work.id)
        .where('fingerprint', '=', built.fingerprint)
        .executeTakeFirst();
      if (existing === undefined) throw new Error('COMPLIANCE_REPORT_WRITE_FAILED');
      return this.toReport(existing);
    }
    const inserted = await this.db
      .selectFrom('compliance_report')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.toReport(inserted);
  }

  async attachLicense(
    userId: string,
    work: WorkRow,
    materialId: string,
    input: {
      evidenceType: 'commercial_use_grant' | 'license_document' | 'authorization_letter';
      evidenceUrl: string;
      expiresAt?: string;
    },
  ): Promise<{ materialId: string; report: ComplianceReport; envelope: WorkEnvelope }> {
    const nextMaterialId = await this.db.transaction().execute(async (trx) => {
      const referenced = await trx
        .selectFrom('work_material')
        .innerJoin('material', 'material.id', 'work_material.material_id')
        .selectAll('material')
        .where('work_material.work_id', '=', work.id)
        .where('work_material.user_id', '=', userId)
        .where('work_material.material_id', '=', materialId)
        .executeTakeFirst();
      if (referenced === undefined) throw new ComplianceMaterialNotReferencedError();

      const now = new Date().toISOString();
      const evidence = {
        type: input.evidenceType,
        url: input.evidenceUrl,
        expiresAt: input.expiresAt ?? null,
        uploadedAt: now,
        version: evidenceVersion(referenced.license_evidence) + 1,
      };

      if (referenced.user_id === userId) {
        await trx
          .updateTable('material')
          .set({ license: 'cleared', license_evidence: toJsonParam(evidence) })
          .where('id', '=', referenced.id)
          .where('user_id', '=', userId)
          .execute();
        return referenced.id;
      }

      const cloneId = `mat_${createHash('sha256')
        .update(`${userId}:${work.id}:${referenced.id}`)
        .digest('hex')
        .slice(0, 26)}`;
      const existingClone = await trx
        .selectFrom('material')
        .select('id')
        .where('id', '=', cloneId)
        .executeTakeFirst();
      if (existingClone === undefined) {
        await trx
          .insertInto('material')
          .values({
            ...referenced,
            id: cloneId,
            user_id: userId,
            license: 'cleared',
            tags: toJsonParam(referenced.tags),
            meta: toJsonParam(referenced.meta),
            license_evidence: toJsonParam(evidence),
          })
          .execute();
      } else {
        await trx
          .updateTable('material')
          .set({ license: 'cleared', license_evidence: toJsonParam(evidence) })
          .where('id', '=', cloneId)
          .where('user_id', '=', userId)
          .execute();
      }
      await trx
        .updateTable('work_material')
        .set({ material_id: cloneId })
        .where('work_id', '=', work.id)
        .where('user_id', '=', userId)
        .where('material_id', '=', referenced.id)
        .execute();
      return cloneId;
    });

    const report = await this.check(userId, work, true);
    return {
      materialId: nextMaterialId,
      report,
      envelope: await this.envelopeFor(userId, work),
    };
  }

  private async materialsFor(userId: string, workId: string): Promise<ComplianceMaterial[]> {
    const rows = await this.db
      .selectFrom('work_material')
      .innerJoin('material', 'material.id', 'work_material.material_id')
      .select([
        'material.id',
        'material.type',
        'material.title',
        'material.license',
        'material.license_evidence',
        'material.body_text',
        'work_material.used_in',
      ])
      .where('work_material.work_id', '=', workId)
      .where('work_material.user_id', '=', userId)
      .execute();
    return rows.map((row) => ({
      materialId: row.id,
      type: row.type,
      title: row.title,
      license: row.license,
      evidenceExpiresAt: evidenceExpiresAt(
        (row.license_evidence as { expiresAt?: unknown } | null)?.expiresAt,
      ),
      bodyText: row.body_text,
      usedIn: Array.isArray(row.used_in) ? (row.used_in as ComplianceMaterial['usedIn']) : [],
    }));
  }

  private async scriptLinesFor(
    userId: string,
    workId: string,
  ): Promise<{ lineId: string; text: string }[]> {
    const script = await this.db
      .selectFrom('script')
      .select('id')
      .where('work_id', '=', workId)
      .where('user_id', '=', userId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (script === undefined) return [];
    const rows = await this.db
      .selectFrom('script_line')
      .innerJoin('script_section', 'script_section.id', 'script_line.section_id')
      .select(['script_line.id', 'script_line.text'])
      .where('script_section.script_id', '=', script.id)
      .orderBy('script_section.ord', 'asc')
      .orderBy('script_line.ord', 'asc')
      .execute();
    return rows.map((row) => ({ lineId: row.id, text: row.text }));
  }

  private async bannedPatterns(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('platform_rule')
      .select('banned_patterns')
      .where('is_current', '=', 1)
      .execute();
    return rows.flatMap((row) =>
      Array.isArray(row.banned_patterns)
        ? row.banned_patterns.filter((item): item is string => typeof item === 'string')
        : [],
    );
  }

  private async envelopeFor(userId: string, work: WorkRow): Promise<WorkEnvelope> {
    const [snapshot, quota] = await Promise.all([
      this.snapshots.load(work),
      this.quota.readForUser(userId),
    ]);
    return assembleWorkEnvelope(work, snapshot, quota);
  }

  private toReport(row: {
    id: string;
    work_id: string;
    items: unknown;
    blocking_count: number;
    warn_count: number;
    fingerprint: string;
    checked_at: string;
  }): ComplianceReport {
    return ComplianceReportSchema.parse({
      id: row.id,
      workId: row.work_id,
      items: Array.isArray(row.items) ? row.items : [],
      blockingCount: row.blocking_count,
      warnCount: row.warn_count,
      fingerprint: row.fingerprint,
      checkedAt: `${row.checked_at.replace(' ', 'T')}Z`,
    });
  }
}
