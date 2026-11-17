import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { ScriptSnapshot, SectionKind } from '@knowstudio/contracts';
import { nextStep, phaseOf } from '@knowstudio/domain';
import type { Database } from '../schema/index.js';
import type { ScriptDiffEntry } from '../schema/json-shapes.js';
import type { ScriptTable, ScriptSectionTable, ScriptLineTable } from '../schema/script.js';
import { toJsonParam } from '../schema/column-types.js';
import type { WorkRow } from './work-repository.js';

export type ScriptRow = Selectable<ScriptTable>;
export type ScriptSectionRow = Selectable<ScriptSectionTable>;
export type ScriptLineRow = Selectable<ScriptLineTable>;

export interface ScriptLineInput {
  readonly id?: string;
  readonly ord: number;
  readonly text: string;
}

export interface ScriptSectionInput {
  readonly kind: SectionKind;
  readonly lines: readonly ScriptLineInput[];
}

export interface ScriptAggregate {
  readonly row: ScriptRow;
  readonly sections: readonly {
    row: ScriptSectionRow;
    lines: readonly ScriptLineRow[];
  }[];
}

export class ScriptScopeRequiredError extends Error {
  readonly code = 'SCRIPT_SCOPE_REQUIRED';
  constructor() {
    super('script 仓储作用域必须绑定合法 userId');
    this.name = 'ScriptScopeRequiredError';
  }
}

export class ScriptVersionConflictError extends Error {
  readonly code = 'SCRIPT_VERSION_CONFLICT';
  constructor(
    readonly baseVersion: number,
    readonly serverSnapshot: ScriptSnapshot,
    readonly clientSnapshot: ScriptSnapshot,
  ) {
    super(`文案版本冲突：客户端 ${baseVersion}，服务端 ${serverSnapshot.version}`);
    this.name = 'ScriptVersionConflictError';
  }
}

export class ScriptLockedError extends Error {
  readonly code = 'SCRIPT_LOCKED';
  constructor(readonly unlockUrl: string) {
    super('文案已确认，不能直接编辑');
    this.name = 'ScriptLockedError';
  }
}

export interface ScopedScriptRepository {
  findLatest(workId: string): Promise<ScriptAggregate | null>;
  create(
    workId: string,
    sections: readonly ScriptSectionInput[],
    generatedText: string,
  ): Promise<ScriptAggregate>;
  patch(
    workId: string,
    baseVersion: number,
    sections: readonly ScriptSectionInput[],
  ): Promise<ScriptAggregate | null>;
  confirm(workId: string): Promise<{ script: ScriptAggregate; work: WorkRow } | null>;
  unlock(workId: string): Promise<{ script: ScriptAggregate; work: WorkRow } | null>;
  createHunks(
    workId: string,
    hunks: readonly { lineId: string | null; original: string; rewritten: string }[],
  ): Promise<
    readonly {
      id: string;
      lineId: string | null;
      ord: number;
      original: string;
      rewritten: string;
      status: 'pending';
      resolvedAt: null;
    }[]
  >;
  resolveHunk(
    hunkId: string,
    accept: boolean,
  ): Promise<{
    id: string;
    lineId: string | null;
    ord: number;
    original: string;
    rewritten: string;
    status: 'pending' | 'accepted' | 'rejected';
  } | null>;
}

export interface ScriptRepository {
  forUser(userId: string): ScopedScriptRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;
function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new Error('SCRIPT_ID_INVALID');
  return raw;
}

function newId(prefix: 'sc' | 'ss' | 'sl' | 'sh' | 'sr'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function snapshotOf(aggregate: ScriptAggregate): ScriptSnapshot {
  return {
    version: aggregate.row.version,
    sections: aggregate.sections.map((section) => ({
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
  };
}

function clientSnapshot(version: number, sections: readonly ScriptSectionInput[]): ScriptSnapshot {
  return {
    version,
    sections: sections.map((section, sectionIndex) => ({
      id: `client_s_${sectionIndex}`,
      kind: section.kind,
      ord: sectionIndex,
      rangeStart: null,
      rangeEnd: null,
      lines: section.lines.map((line, lineIndex) => ({
        id: line.id ?? `client_l_${sectionIndex}_${lineIndex}`,
        sectionId: `client_s_${sectionIndex}`,
        ord: line.ord,
        text: line.text,
        editedByUser: true,
        charCount: [...line.text].length,
      })),
    })),
  };
}

export function scriptCharCount(sections: readonly { text: string }[]): number {
  return sections.reduce((sum, line) => sum + [...line.text].length, 0);
}

export function createScriptRepository(db: Kysely<Database>): ScriptRepository {
  return {
    forUser(userId: string): ScopedScriptRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId))
        throw new ScriptScopeRequiredError();

      const load = async (workId: string, scriptId: string): Promise<ScriptAggregate | null> => {
        const row = await db
          .selectFrom('script')
          .where('id', '=', scriptId)
          .where('work_id', '=', assertId(workId))
          .where('user_id', '=', userId)
          .selectAll()
          .executeTakeFirst();
        if (row === undefined) return null;
        const sectionRows = await db
          .selectFrom('script_section')
          .where('script_id', '=', row.id)
          .orderBy('ord', 'asc')
          .selectAll()
          .execute();
        const lineRows = await db
          .selectFrom('script_line')
          .innerJoin('script_section', 'script_section.id', 'script_line.section_id')
          .where('script_section.script_id', '=', row.id)
          .orderBy('script_section.ord', 'asc')
          .orderBy('script_line.ord', 'asc')
          .select([
            'script_line.id',
            'script_line.section_id',
            'script_line.ord',
            'script_line.text',
            'script_line.edited_by_user',
            'script_line.char_count',
          ])
          .execute();
        return {
          row,
          sections: sectionRows.map((section) => ({
            row: section,
            lines: lineRows.filter((line) => line.section_id === section.id),
          })),
        };
      };

      const insertSections = async (
        trx: Parameters<Parameters<ReturnType<typeof db.transaction>['execute']>[0]>[0],
        scriptId: string,
        sections: readonly ScriptSectionInput[],
        editedByUser: 0 | 1,
      ) => {
        for (const [sectionIndex, section] of sections.entries()) {
          const sectionId = newId('ss');
          await trx
            .insertInto('script_section')
            .values({
              id: sectionId,
              script_id: scriptId,
              kind: section.kind,
              ord: sectionIndex,
              range_start: null,
              range_end: null,
            })
            .execute();
          for (const [lineIndex, line] of section.lines.entries()) {
            await trx
              .insertInto('script_line')
              .values({
                id: line.id ?? newId('sl'),
                section_id: sectionId,
                ord: lineIndex,
                text: line.text,
                edited_by_user: editedByUser,
              })
              .execute();
          }
        }
        return scriptId;
      };

      return {
        findLatest: async (workId) => {
          const row = await db
            .selectFrom('script')
            .where('work_id', '=', assertId(workId))
            .where('user_id', '=', userId)
            .orderBy('version', 'desc')
            .selectAll()
            .executeTakeFirst();
          return row === undefined ? null : load(workId, row.id);
        },

        create: async (workId, sections, generatedText) => {
          const w = assertId(workId);
          const chars = scriptCharCount(sections.flatMap((section) => [...section.lines]));
          const scriptId = newId('sc');
          await db.transaction().execute(async (trx) => {
            await trx
              .insertInto('script')
              .values({
                id: scriptId,
                work_id: w,
                user_id: userId,
                version: 1,
                status: 'draft',
                estimated_duration: Math.round(chars / 4.2),
                generated_text:
                  generatedText === ''
                    ? sections
                        .flatMap((section) => section.lines.map((line) => line.text))
                        .join('\n')
                    : generatedText,
              })
              .execute();
            await insertSections(trx, scriptId, sections, 0);
          });
          const created = await load(w, scriptId);
          if (created === null) throw new Error('SCRIPT_INSERT_FAILED');
          return created;
        },

        patch: async (workId, baseVersion, sections) => {
          const w = assertId(workId);
          const scriptId = await db.transaction().execute(async (trx) => {
            const row = await trx
              .selectFrom('script')
              .where('work_id', '=', w)
              .where('user_id', '=', userId)
              .orderBy('version', 'desc')
              .forUpdate()
              .selectAll()
              .executeTakeFirst();
            if (row === undefined) return null;
            const before = await load(w, row.id);
            if (before === null) return null;
            if (row.status === 'confirmed') {
              throw new ScriptLockedError(`/studio/${w}/script`);
            }
            if (row.version !== baseVersion) {
              throw new ScriptVersionConflictError(
                baseVersion,
                snapshotOf(before),
                clientSnapshot(baseVersion, sections),
              );
            }

            const beforeLines = before.sections.flatMap((section) => section.lines);
            const afterText = sections.flatMap((section) => section.lines.map((line) => line.text));
            const diff: ScriptDiffEntry[] = afterText
              .slice(0, beforeLines.length)
              .map((text, index) => ({
                lineId: beforeLines[index]?.id ?? newId('sl'),
                before: beforeLines[index]?.text ?? '',
                after: text,
              }));
            const chars = scriptCharCount(sections.flatMap((section) => [...section.lines]));
            await trx.deleteFrom('script_section').where('script_id', '=', row.id).execute();
            await insertSections(trx, row.id, sections, 1);
            await trx
              .updateTable('script')
              .set({
                version: row.version + 1,
                estimated_duration: Math.round(chars / 4.2),
                updated_at: sql`CURRENT_TIMESTAMP(3)`,
              })
              .where('id', '=', row.id)
              .execute();
            await trx
              .insertInto('script_revision')
              .values({
                id: newId('sr'),
                script_id: row.id,
                version: row.version + 1,
                diff: toJsonParam(diff),
                reason: 'edit',
                snapshot: toJsonParam(clientSnapshot(row.version + 1, sections)),
              })
              .execute();
            return row.id;
          });
          return scriptId === null ? null : (await load(w, scriptId))!;
        },

        confirm: async (workId) => {
          const w = assertId(workId);
          const result = await db.transaction().execute(async (trx) => {
            const script = await trx
              .selectFrom('script')
              .where('work_id', '=', w)
              .where('user_id', '=', userId)
              .orderBy('version', 'desc')
              .forUpdate()
              .selectAll()
              .executeTakeFirst();
            if (script === undefined) return null;
            if (script.status === 'confirmed') return null;
            await trx
              .updateTable('script')
              .set({
                status: 'confirmed',
                confirmed_at: sql`CURRENT_TIMESTAMP(3)`,
                updated_at: sql`CURRENT_TIMESTAMP(3)`,
              })
              .where('id', '=', script.id)
              .execute();
            const work = await trx
              .selectFrom('work')
              .where('id', '=', w)
              .forUpdate()
              .selectAll()
              .executeTakeFirst();
            if (work === undefined) return null;
            const step = nextStep(work.step, 'script:confirm');
            await trx
              .updateTable('work')
              .set({
                script_confirmed_at: sql`CURRENT_TIMESTAMP(3)`,
                step,
                phase: phaseOf(step),
                updated_at: sql`CURRENT_TIMESTAMP(3)`,
              })
              .where('id', '=', w)
              .execute();
            const updatedWork = await trx
              .selectFrom('work')
              .where('id', '=', w)
              .selectAll()
              .executeTakeFirst();
            return updatedWork === undefined ? null : { scriptId: script.id, work: updatedWork };
          });
          if (result === null) return null;
          return { script: (await load(w, result.scriptId))!, work: result.work };
        },

        unlock: async (workId) => {
          const w = assertId(workId);
          const result = await db.transaction().execute(async (trx) => {
            const script = await trx
              .selectFrom('script')
              .where('work_id', '=', w)
              .where('user_id', '=', userId)
              .orderBy('version', 'desc')
              .forUpdate()
              .selectAll()
              .executeTakeFirst();
            if (script === undefined) return null;
            await trx
              .updateTable('script')
              .set({ status: 'stale', confirmed_at: null, updated_at: sql`CURRENT_TIMESTAMP(3)` })
              .where('id', '=', script.id)
              .execute();
            await trx
              .updateTable('video_asset')
              .set({ stale: 1 })
              .where('work_id', '=', w)
              .where('user_id', '=', userId)
              .execute();
            const work = await trx
              .selectFrom('work')
              .where('id', '=', w)
              .forUpdate()
              .selectAll()
              .executeTakeFirst();
            if (work === undefined) return null;
            await trx
              .updateTable('work')
              .set({
                script_confirmed_at: null,
                step: 'script',
                phase: 1,
                updated_at: sql`CURRENT_TIMESTAMP(3)`,
              })
              .where('id', '=', w)
              .execute();
            const updatedWork = await trx
              .selectFrom('work')
              .where('id', '=', w)
              .selectAll()
              .executeTakeFirst();
            return updatedWork === undefined ? null : { scriptId: script.id, work: updatedWork };
          });
          if (result === null) return null;
          return { script: (await load(w, result.scriptId))!, work: result.work };
        },

        createHunks: async (workId, hunks) => {
          const latestRow = await db
            .selectFrom('script')
            .where('work_id', '=', assertId(workId))
            .where('user_id', '=', userId)
            .orderBy('version', 'desc')
            .selectAll()
            .executeTakeFirst();
          const script = latestRow === undefined ? null : await load(workId, latestRow.id);
          if (script === null) return [];
          const result: {
            id: string;
            lineId: string | null;
            ord: number;
            original: string;
            rewritten: string;
            status: 'pending';
            resolvedAt: null;
          }[] = [];
          for (const [index, hunk] of hunks.entries()) {
            const id = newId('sh');
            await db
              .insertInto('style_hunk')
              .values({
                id,
                script_id: script.row.id,
                line_id: hunk.lineId,
                ord: index,
                original: hunk.original,
                rewritten: hunk.rewritten,
                status: 'pending',
                resolved_at: null,
              })
              .execute();
            result.push({ ...hunk, id, ord: index, status: 'pending', resolvedAt: null });
          }
          return result;
        },

        resolveHunk: async (hunkId, accept) => {
          const hunk = await db
            .selectFrom('style_hunk')
            .innerJoin('script', 'script.id', 'style_hunk.script_id')
            .where('style_hunk.id', '=', assertId(hunkId))
            .where('script.user_id', '=', userId)
            .select([
              'style_hunk.id',
              'style_hunk.line_id',
              'style_hunk.ord',
              'style_hunk.original',
              'style_hunk.rewritten',
              'style_hunk.status',
            ])
            .executeTakeFirst();
          if (hunk === undefined) return null;
          await db
            .updateTable('style_hunk')
            .set({
              status: accept ? 'accepted' : 'rejected',
              resolved_at: sql`CURRENT_TIMESTAMP(3)`,
            })
            .where('id', '=', hunk.id)
            .execute();
          return { ...hunk, lineId: hunk.line_id, status: accept ? 'accepted' : 'rejected' };
        },
      };
    },
  };
}
