import { Inject, Injectable } from '@nestjs/common';
import {
  GateNotSatisfied,
  JobSchema,
  ScriptSchema,
  StyleHunkSchema,
  type Job,
  type Script,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import {
  generateRestyleHunks,
  generateScript,
  findPlagiarism,
  rewritePlagiarizedLines,
  type LlmPort,
} from '@knowstudio/ai';
import type {
  MaterialRepository,
  ScriptAggregate,
  ScriptRepository,
  StyleRepository,
  TopicRepository,
  WorkMaterialRepository,
  WorkRow,
} from '@knowstudio/db/repositories';
import { assembleWorkEnvelope } from '../works/work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { WORK_QUOTA_READER, WORK_TRUTH_SNAPSHOT } from '../works/works.tokens.js';
import { toMaterial } from './material-view.js';
import {
  LLM_PORT,
  MATERIAL_REPOSITORY,
  SCRIPT_REPOSITORY,
  STYLE_REPOSITORY,
  TOPIC_REPOSITORY,
  WORK_MATERIAL_REPOSITORY,
} from './discover.tokens.js';

export class ScriptGateNotSatisfiedError extends Error {
  readonly code = 'SCRIPT_GATE_NOT_SATISFIED';
  constructor() {
    super('SCRIPT_GATE_NOT_SATISFIED');
    this.name = 'ScriptGateNotSatisfiedError';
  }
}

export function gateNotSatisfied() {
  return GateNotSatisfied.parse({
    code: 'GATE_NOT_SATISFIED',
    message: '请先选择一个角度',
    details: { requiredGate: 'G1', reason: 'TOPIC_NOT_SELECTED', redirectTo: '/discover/topics' },
  });
}

function toRfc3339(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

@Injectable()
export class ScriptService {
  constructor(
    @Inject(SCRIPT_REPOSITORY) private readonly scripts: ScriptRepository,
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(WORK_MATERIAL_REPOSITORY) private readonly workMaterials: WorkMaterialRepository,
    @Inject(MATERIAL_REPOSITORY) private readonly materials: MaterialRepository,
    @Inject(STYLE_REPOSITORY) private readonly styles: StyleRepository,
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
  ) {}

  async generate(userId: string, work: WorkRow): Promise<Job> {
    if (work.selected_topic_id == null) throw new ScriptGateNotSatisfiedError();
    const topic = await this.topics.forUser(userId).findTopic(work.selected_topic_id);
    if (topic === null || topic.work_id !== work.id) throw new ScriptGateNotSatisfiedError();
    const materialIds = await this.workMaterials.forUser(userId).listMaterialIdsForWork(work.id);
    const rows = await this.materials.forUser(userId).findByIds(materialIds);
    const materialContracts = rows.map((row) => toMaterial(row, true));
    const generated = await generateScript(
      {
        keyword: work.keyword ?? '',
        topicHook: topic.hook,
        topicGap: topic.blank_point,
        materials: materialContracts,
      },
      this.llm,
    );
    const flatLines = generated.sections.flatMap((section) => section.lines);
    const plagiarismHits = findPlagiarism(
      flatLines,
      materialContracts.map((material) => material.summary).filter((summary) => summary !== ''),
    );
    const rewrittenLines =
      plagiarismHits.length === 0
        ? flatLines
        : await rewritePlagiarizedLines(flatLines, plagiarismHits, this.llm);
    let cursor = 0;
    const sectionsForCreate = generated.sections.map((section) => ({
      kind: section.kind,
      lines: section.lines.map((_, index) => {
        const text = rewrittenLines[cursor] ?? '';
        cursor += 1;
        return { text, ord: index };
      }),
    }));
    const created = await this.scripts
      .forUser(userId)
      .create(
        work.id,
        sectionsForCreate,
        sectionsForCreate.flatMap((section) => section.lines).join('\n'),
      );
    const at = toRfc3339(created.row.created_at);
    return JobSchema.parse({
      id: created.row.id,
      workId: work.id,
      type: 'script',
      status: 'succeeded',
      stage: null,
      progress: 100,
      costPoints: 0,
      reservationId: null,
      attempt: 0,
      error: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  async get(userId: string, work: WorkRow): Promise<Script> {
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    return this.toContract(script);
  }

  async patch(
    userId: string,
    work: WorkRow,
    input: {
      baseVersion: number;
      sections: readonly {
        kind: 'hook3s' | 'body' | 'outro';
        lines: readonly { id?: string; ord: number; text: string }[];
      }[];
    },
  ): Promise<{ script: Script; envelope: WorkEnvelope }> {
    const script = await this.scripts.forUser(userId).patch(
      work.id,
      input.baseVersion,
      input.sections.map((section) => ({
        kind: section.kind,
        lines: section.lines.map((line) => ({ ...line })),
      })),
    );
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    return { script: this.toContract(script), envelope: await this.envelopeFor(userId, work) };
  }

  async restyle(
    userId: string,
    work: WorkRow,
    sampleIds: readonly string[],
  ): Promise<{ hunks: ReturnType<typeof StyleHunkSchema.parse>[]; envelope: WorkEnvelope }> {
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const samples = await this.styles.forUser(userId).findByIds(sampleIds);
    if (samples.length !== new Set(sampleIds).size) throw new Error('STYLE_SAMPLE_NOT_FOUND');
    const lines = script.sections.flatMap((section) => section.lines.map((line) => line.text));
    const generated = await generateRestyleHunks(
      {
        lines,
        samples: samples.map((sample) => ({ title: sample.title, content: sample.content })),
      },
      this.llm,
    );
    const lineIds = script.sections.flatMap((section) => section.lines.map((line) => line.id));
    const hunks = await this.scripts.forUser(userId).createHunks(
      work.id,
      generated.map((hunk, index) => ({ ...hunk, lineId: lineIds[index] ?? null })),
    );
    return {
      hunks: StyleHunkSchema.array().parse(
        hunks.map((hunk) => ({ ...hunk, scriptId: script.row.id, resolvedAt: null })),
      ),
      envelope: await this.envelopeFor(userId, work),
    };
  }

  async resolveHunk(
    userId: string,
    work: WorkRow,
    hunkId: string,
    accept: boolean,
  ): Promise<{
    hunk: ReturnType<typeof StyleHunkSchema.parse>;
    script: Script;
    envelope: WorkEnvelope;
  }> {
    const hunk = await this.scripts.forUser(userId).resolveHunk(hunkId, accept);
    if (hunk === null) throw new Error('HUNK_NOT_FOUND');
    let script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    if (accept && hunk.lineId != null) {
      script = await this.scripts.forUser(userId).patch(
        work.id,
        script.row.version,
        script.sections.map((section) => ({
          kind: section.row.kind,
          lines: section.lines.map((line) => ({
            id: line.id,
            ord: line.ord,
            text: line.id === hunk.lineId ? hunk.rewritten : line.text,
          })),
        })),
      );
      if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    }
    return {
      hunk: StyleHunkSchema.parse({
        ...hunk,
        scriptId: script.row.id,
        resolvedAt: new Date().toISOString(),
      }),
      script: this.toContract(script),
      envelope: await this.envelopeFor(userId, work),
    };
  }

  async confirm(
    userId: string,
    work: WorkRow,
  ): Promise<{ script: Script; envelope: WorkEnvelope }> {
    const result = await this.scripts.forUser(userId).confirm(work.id);
    if (result === null) throw new Error('SCRIPT_NOT_FOUND');
    return {
      script: this.toContract(result.script),
      envelope: await this.envelopeFor(userId, result.work),
    };
  }

  async unlock(userId: string, work: WorkRow): Promise<WorkEnvelope> {
    const result = await this.scripts.forUser(userId).unlock(work.id);
    if (result === null) throw new Error('SCRIPT_NOT_FOUND');
    return this.envelopeFor(userId, result.work);
  }

  toContract(script: ScriptAggregate): Script {
    return ScriptSchema.parse({
      id: script.row.id,
      workId: script.row.work_id,
      version: script.row.version,
      status: script.row.status,
      confirmedAt: script.row.confirmed_at === null ? null : toRfc3339(script.row.confirmed_at),
      estimatedDuration: script.row.estimated_duration,
      actualDuration: script.row.actual_duration,
      sections: script.sections.map((section) => ({
        id: section.row.id,
        kind: section.row.kind,
        ord: section.row.ord,
        rangeStart: section.row.range_start,
        rangeEnd: section.row.range_end,
        lines: section.lines.map((line) => ({
          id: line.id,
          sectionId: line.section_id,
          ord: line.ord,
          text: line.text,
          editedByUser: line.edited_by_user === 1,
          charCount: line.char_count,
        })),
      })),
    });
  }

  private async envelopeFor(userId: string, work: WorkRow): Promise<WorkEnvelope> {
    const [snapshot, quota] = await Promise.all([
      this.snapshots.load(work),
      this.quota.readForUser(userId),
    ]);
    return assembleWorkEnvelope(work, snapshot, quota);
  }
}
