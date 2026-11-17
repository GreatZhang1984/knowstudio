import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import type { Script, StyleHunk } from '@knowstudio/contracts';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import {
  confirmScript,
  fetchScript,
  fetchStyleSamples,
  generateScript,
  patchScript,
  resolveStyleHunk,
  restyleScript,
  unlockScript,
} from '../work/api';
import { indexedDbDraftPort } from '../work/autosave';
import { trackFirstScriptEdit } from '../work/observability';
import { useWorkEnvelope, workKeys } from '../work/queries';
import { apiErrorOf } from './discover/searchLogic';

interface LocalLine {
  readonly id?: string;
  readonly ord: number;
  readonly text: string;
}

interface LocalSection {
  readonly kind: 'hook3s' | 'body' | 'outro';
  readonly lines: LocalLine[];
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

const SECTION_LABEL: Record<LocalSection['kind'], string> = {
  hook3s: '黄金 3 秒',
  body: '知识点结构',
  outro: '互动结尾',
};

function localOf(script: Script): LocalSection[] {
  return script.sections.map((section) => ({
    kind: section.kind,
    lines: section.lines.map((line) => ({ id: line.id, ord: line.ord, text: line.text })),
  }));
}

function charCount(sections: readonly LocalSection[]): number {
  return sections
    .flatMap((section) => section.lines)
    .reduce((sum, line) => sum + [...line.text].length, 0);
}

function EditableLine({
  value,
  ordinal,
  onInput,
}: {
  value: string;
  ordinal: number;
  onInput: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current != null && ref.current.textContent !== value) ref.current.textContent = value;
  }, [value]);
  return (
    <div className="script-line">
      <span className="script-line__ord" aria-hidden="true">
        {ordinal}
      </span>
      <div
        ref={ref}
        className="script-line__editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={`第 ${ordinal} 句`}
        data-placeholder="输入这一句口播"
        onInput={(event) => onInput(event.currentTarget.textContent ?? '')}
      />
    </div>
  );
}

export default function ScriptPage() {
  const { id } = useParams();
  const workId = id ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const envelope = useWorkEnvelope(workId);
  const scriptQuery = useQuery({
    queryKey: workKeys.script(workId),
    queryFn: () => fetchScript(workId),
    enabled: workId !== '',
  });
  const styleQuery = useQuery({
    queryKey: workKeys.styleSamples(),
    queryFn: fetchStyleSamples,
  });

  const [sections, setSections] = useState<LocalSection[]>([]);
  const [baseVersion, setBaseVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [undoStack, setUndoStack] = useState<readonly LocalSection[][]>([]);
  const [redoStack, setRedoStack] = useState<readonly LocalSection[][]>([]);
  const [hunks, setHunks] = useState<readonly StyleHunk[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const initialized = useRef(false);
  const restored = useRef(false);

  const script = scriptQuery.data;
  useEffect(() => {
    if (initialized.current || script == null) return;
    initialized.current = true;
    setSections(localOf(script));
    setBaseVersion(script.version);
    if (restored.current) return;
    restored.current = true;
    void indexedDbDraftPort
      .load(`script:${workId}`)
      .then((draft) => {
        if (draft?.baseVersion !== script.version) {
          if (draft != null) void indexedDbDraftPort.clear(`script:${workId}`);
          return;
        }
        setSections(draft.payload as LocalSection[]);
        setDirty(true);
        setSaveState(navigator.onLine ? 'dirty' : 'offline');
      })
      .catch(() => undefined);
  }, [script, workId]);

  useEffect(() => {
    if (!dirty || script?.status === 'confirmed') return;
    setSaveState('dirty');
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      void indexedDbDraftPort
        .save({
          key: `script:${workId}`,
          savedAt: new Date().toISOString(),
          payload: sections,
          baseVersion,
        })
        .then(() => patchScript(workId, { baseVersion, sections }))
        .then((result) => {
          setBaseVersion(result.script.version);
          setDirty(false);
          setSaveState('saved');
          queryClient.setQueryData(workKeys.script(workId), result.script);
          return indexedDbDraftPort.clear(`script:${workId}`);
        })
        .catch((error: unknown) => {
          setSaveError(error);
          const apiError = apiErrorOf(error);
          setSaveState(
            apiError?.code === 'AUTOSAVE_CONFLICT'
              ? 'conflict'
              : navigator.onLine
                ? 'error'
                : 'offline',
          );
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [baseVersion, dirty, queryClient, script?.status, sections, workId]);

  const mutateSections = (next: LocalSection[]) => {
    trackFirstScriptEdit(
      workId,
      sections.flatMap((section) => section.lines.map((line) => line.text)).join('\n'),
      next.flatMap((section) => section.lines.map((line) => line.text)).join('\n'),
    );
    setUndoStack((stack) => [...stack.slice(-19), sections]);
    setRedoStack([]);
    setSections(next);
    setDirty(true);
  };

  const undo = () => {
    const previous = undoStack[undoStack.length - 1];
    if (previous === undefined) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, sections]);
    setSections(previous);
    setDirty(true);
  };

  const redo = () => {
    const next = redoStack[redoStack.length - 1];
    if (next === undefined) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, sections]);
    setSections(next);
    setDirty(true);
  };

  const generateMutation = useMutation({
    mutationFn: () => generateScript(workId),
    onSuccess: () => {
      initialized.current = false;
      void queryClient.invalidateQueries({ queryKey: workKeys.script(workId) });
    },
  });

  const restyleMutation = useMutation({
    mutationFn: () => restyleScript(workId, styleQuery.data?.map((sample) => sample.id) ?? []),
    onSuccess: (result) => setHunks(result.hunks),
  });

  const hunkMutation = useMutation({
    mutationFn: ({ hunk, accept }: { hunk: StyleHunk; accept: boolean }) =>
      resolveStyleHunk(workId, hunk.id, accept),
    onSuccess: (_, variables) => {
      setHunks((current) =>
        current.map((hunk) =>
          hunk.id === variables.hunk.id
            ? {
                ...hunk,
                status: variables.accept ? 'accepted' : 'rejected',
                resolvedAt: new Date().toISOString(),
              }
            : hunk,
        ),
      );
      if (variables.accept) {
        initialized.current = false;
        void queryClient.invalidateQueries({ queryKey: workKeys.script(workId) });
      }
    },
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmScript(workId),
    onSuccess: (updated) => {
      queryClient.setQueryData(workKeys.envelope(workId), updated);
      setConfirmOpen(false);
      void navigate(`/studio/${workId}/video`);
    },
  });

  const unlockMutation = useMutation({
    mutationFn: () => unlockScript(workId),
    onSuccess: (updated) => {
      queryClient.setQueryData(workKeys.envelope(workId), updated);
      initialized.current = false;
      void queryClient.invalidateQueries({ queryKey: workKeys.script(workId) });
    },
  });

  const chars = useMemo(() => charCount(sections), [sections]);
  const duration = Math.round(chars / 4.2);
  const work = envelope.data;
  const locked = script?.status === 'confirmed';
  const hasSample = (styleQuery.data?.length ?? 0) > 0;
  const saveLabel: Record<SaveState, string> = {
    idle: '自动保存已就绪',
    dirty: '编辑中，等待自动保存',
    saving: '正在保存',
    saved: '已自动保存',
    offline: '离线，已暂存在本机',
    conflict: '版本冲突，需刷新后选择版本',
    error: '保存失败，输入仍保留',
  };

  return (
    <section className="script-page">
      <header className="discover-head">
        <div>
          <h1>文案编辑器</h1>
          <p>{work?.title ?? '当前作品'}</p>
        </div>
        <div className="script-head__meta">
          <Tag>{chars} 字</Tag>
          <Tag color={duration >= 60 && duration <= 90 ? 'green' : 'orange'}>约 {duration} 秒</Tag>
          <Tag>{saveLabel[saveState]}</Tag>
        </div>
      </header>

      {scriptQuery.isPending || generateMutation.isPending ? (
        <LoadingState variant="text" label="正在生成文案" testId="script-loading" />
      ) : script == null ? (
        <EmptyState
          title="还没有口播文案"
          description="先根据选定的角度生成三段式草稿。"
          level="section"
          actions={[
            {
              key: 'generate',
              label: '生成口播文案',
              primary: true,
              onClick: () => generateMutation.mutate(),
            },
          ]}
          testId="script-empty"
        />
      ) : (
        <>
          {locked ? (
            <Alert
              type="success"
              showIcon
              message="文案已人工确认并锁定"
              description="解锁后需要重新生成视频与合规检查。"
              action={
                <Button
                  size="small"
                  loading={unlockMutation.isPending}
                  onClick={() => unlockMutation.mutate()}
                >
                  解锁
                </Button>
              }
            />
          ) : null}

          {saveState === 'conflict' || saveState === 'error' ? (
            <ErrorState
              error={apiErrorOf(saveError) ?? undefined}
              title={saveState === 'conflict' ? '文案版本冲突' : '自动保存失败'}
              description="你刚才的输入仍在本页与本地暂存中。"
              level="section"
              testId="script-save-error"
            />
          ) : null}

          <div className="script-toolbar">
            <Button size="small" disabled={undoStack.length === 0 || locked} onClick={undo}>
              撤销
            </Button>
            <Button size="small" disabled={redoStack.length === 0 || locked} onClick={redo}>
              重做
            </Button>
            <span>{undoStack.length} / 20 步</span>
          </div>

          <div className="script-sections">
            {sections.map((section, sectionIndex) => (
              <section className="script-section" data-kind={section.kind} key={sectionIndex}>
                <header>
                  <h2>{SECTION_LABEL[section.kind]}</h2>
                  <span>{section.lines.length} 句</span>
                </header>
                {section.lines.map((line, lineIndex) => (
                  <EditableLine
                    key={line.id ?? `${sectionIndex}-${lineIndex}`}
                    ordinal={lineIndex + 1}
                    value={line.text}
                    onInput={(text) =>
                      mutateSections(
                        sections.map((item, index) =>
                          index === sectionIndex
                            ? {
                                ...item,
                                lines: item.lines.map((current, currentLineIndex) =>
                                  currentLineIndex === lineIndex ? { ...current, text } : current,
                                ),
                              }
                            : item,
                        ),
                      )
                    }
                  />
                ))}
              </section>
            ))}
          </div>

          <section className="script-style">
            <header>
              <h2>风格重写</h2>
              <span>已学习 {styleQuery.data?.length ?? 0} 篇样本</span>
            </header>
            <div>
              <Button
                disabled={!hasSample || locked}
                title={hasSample ? undefined : '先在风格样本页添加至少一篇样本'}
                loading={restyleMutation.isPending}
                onClick={() => restyleMutation.mutate()}
              >
                生成风格重写
              </Button>
            </div>
            {hunks.length === 0 ? (
              <p>生成后会逐句给出原版与改写版，可逐条接受或拒绝。</p>
            ) : (
              <ul>
                {hunks.map((hunk) => (
                  <li key={hunk.id} data-status={hunk.status}>
                    <div>
                      <span>原版</span>
                      <p>{hunk.original}</p>
                    </div>
                    <div>
                      <span>改写</span>
                      <p>{hunk.rewritten}</p>
                    </div>
                    <footer>
                      <Button
                        size="small"
                        disabled={hunk.status !== 'pending' || locked}
                        loading={hunkMutation.isPending}
                        onClick={() => hunkMutation.mutate({ hunk, accept: true })}
                      >
                        接受
                      </Button>
                      <Button
                        size="small"
                        disabled={hunk.status !== 'pending' || locked}
                        onClick={() => hunkMutation.mutate({ hunk, accept: false })}
                      >
                        拒绝
                      </Button>
                    </footer>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <footer className="discover-action-bar">
            <div>
              <strong>
                {chars} 字 · 约 {duration} 秒
              </strong>
              <span>确认后文案锁定并解锁视频生成</span>
            </div>
            <div>
              <Button disabled={locked} onClick={() => setConfirmOpen(true)}>
                确认文案
              </Button>
              <Button
                type="primary"
                disabled={!locked}
                title={locked ? undefined : '先人工确认文案'}
                href={locked ? `/studio/${workId}/video` : undefined}
              >
                去生成视频
              </Button>
            </div>
          </footer>
        </>
      )}

      <Modal
        open={confirmOpen}
        title="确认并锁定文案"
        okText="确认锁定"
        cancelText="继续编辑"
        confirmLoading={confirmMutation.isPending}
        onOk={() => confirmMutation.mutate()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>确认后文案将锁定，知影不会替你跳过这一步。</p>
        <p>后续如果要修改，需要解锁并重新生成受影响的视频资产。</p>
      </Modal>
    </section>
  );
}
