import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ExportAccepted,
  ExportFileSchema,
  type ComplianceReport,
  type ExportPackage,
} from '@knowstudio/contracts';
import { deriveGates, nextStep, phaseOf } from '@knowstudio/domain';
import { enqueueInTransaction } from '@knowstudio/queue';
import { toJsonParam, type Database, type Kysely } from '@knowstudio/db';
import type { ObjectStorage } from '@knowstudio/storage';
import type { WorkRow } from '@knowstudio/db/repositories';
import type { WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { WORK_TRUTH_SNAPSHOT } from '../works/works.tokens.js';
import { ComplianceService } from '../compliance/compliance.service.js';
import { DB_CLIENT, OBJECT_STORAGE } from '../shared/tokens.js';

const SIGN_TTL_MS = 24 * 60 * 60 * 1_000;

export class ExportComplianceBlockedError extends Error {
  constructor(readonly report: ComplianceReport) {
    super('合规检查存在阻断项');
    this.name = 'ExportComplianceBlockedError';
  }
}

export class ExportGateNotSatisfiedError extends Error {
  readonly code = 'EXPORT_GATE_NOT_SATISFIED';
  constructor() {
    super('G4 未满足，不能导出');
    this.name = 'ExportGateNotSatisfiedError';
  }
}

export class ExportMediaNotReadyError extends Error {
  readonly code = 'EXPORT_MEDIA_NOT_READY';
  constructor() {
    super('平台媒体未生成完成');
    this.name = 'ExportMediaNotReadyError';
  }
}

function nowLiteral(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

@Injectable()
export class ExportService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(ComplianceService)
    private readonly compliance: ComplianceService,
  ) {}

  async enqueue(userId: string, work: WorkRow): Promise<ExportAccepted> {
    const report = await this.compliance.check(userId, work, true);
    if (report.blockingCount > 0) throw new ExportComplianceBlockedError(report);
    const gates = deriveGates(await this.snapshots.load(work));
    if (!gates.G4) throw new ExportGateNotSatisfiedError();

    const derivatives = await this.db
      .selectFrom('derivative')
      .select(['platform_id', 'media_ready'])
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .execute();
    if (derivatives.length !== 4 || derivatives.some((row) => row.media_ready !== 1)) {
      throw new ExportMediaNotReadyError();
    }

    const exportId = `exp_${randomUUID().replace(/-/g, '')}`;
    const jobId = `job_${randomUUID().replace(/-/g, '')}`;
    const idempotencyKey = createHash('sha256')
      .update(`${userId}:${work.id}:${report.fingerprint}`)
      .digest('hex');

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('export_package')
        .values({
          id: exportId,
          work_id: work.id,
          user_id: userId,
          status: 'queued',
          files: toJsonParam([]),
          report_id: report.id,
          expires_at: new Date(Date.now() + SIGN_TTL_MS).toISOString().replace('T', ' ').replace('Z', ''),
        })
        .execute();
      await trx
        .insertInto('render_job')
        .values({
          id: jobId,
          work_id: work.id,
          user_id: userId,
          type: 'export',
          layer_scope: toJsonParam([]),
          status: 'queued',
          progress: 0,
          stage: 'queued',
          cost_points: 0,
          attempt: 0,
          error: null,
          cancel_requested: 0,
          idempotency_key: idempotencyKey,
        })
        .execute();
      const step = nextStep(work.step, 'export:enqueued');
      await trx
        .updateTable('work')
        .set({ step, phase: phaseOf(step), updated_at: nowLiteral() })
        .where('id', '=', work.id)
        .execute();
      await enqueueInTransaction(trx, {
        queue: 'export.pack',
        jobId,
        userId,
        payload: { workId: work.id, exportId, reportId: report.id },
        dedupKey: idempotencyKey,
      });
    });

    return ExportAccepted.parse({ exportId });
  }

  async read(userId: string, exportId: string): Promise<ExportPackage> {
    const found = await this.db
      .selectFrom('export_package')
      .selectAll()
      .where('id', '=', exportId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (found === undefined) throw new Error('EXPORT_NOT_FOUND');
    let row = found;

    const expiresAtMs = Date.parse(`${row.expires_at.replace(' ', 'T')}Z`);
    if (row.status === 'succeeded' && expiresAtMs <= Date.now()) {
      const expiresAt = new Date(Date.now() + SIGN_TTL_MS)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
      await this.db
        .updateTable('export_package')
        .set({ expires_at: expiresAt })
        .where('id', '=', row.id)
        .execute();
      row = { ...row, expires_at: expiresAt };
    }

    const storedFiles = ExportFileSchema.omit({ url: true }).array().parse(row.files);
    const files = await Promise.all(
      storedFiles.map(async (file) => ({
        ...file,
        url: await this.storage.presignGet({
          key: file.key,
          artifact: 'export',
          expiresInSeconds: 86_400,
        }),
      })),
    );

    return {
      id: row.id,
      workId: row.work_id,
      status: row.status,
      files,
      reportId: row.report_id,
      expiresAt: `${row.expires_at.replace(' ', 'T')}Z`,
      createdAt: `${row.created_at.replace(' ', 'T')}Z`,
    };
  }

}
