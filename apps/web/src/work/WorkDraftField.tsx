import { useWorkStore } from './store';

/**
 * 分片容器的第一个真实消费点：**未保存草稿**（架构 §11.2 分片内容清单里的一项）。
 *
 * T-31 的 contenteditable 编辑器落地后替换掉这个输入框，但状态仍从这里取——
 * 它存在的意义是让「两个 Work 来回切换，草稿各自独立」在真机上可点验，
 * 而不是只有一个没人用的容器。不落库、不 autosave（那是 T-16）。
 *
 * 刻意用原生控件而不是 AntD Input：架构 §11.4 明确「编辑器自建，不引 AntD Form」，
 * 顺手把 rc-textarea 拉进包里只会让首屏 chunk 更胖（SPEC §10 LCP ≤2.0s）。
 */
export function WorkDraftField({ workId }: { workId: string }) {
  const draft = useWorkStore(workId, (s) => s.draft);
  const setDraftText = useWorkStore(workId, (s) => s.setDraftText);
  const undo = useWorkStore(workId, (s) => s.undo);
  const canUndo = useWorkStore(workId, (s) => s.undoStack.length > 0);

  return (
    <section className="work-draft" data-work-id={workId} aria-label={`作品 ${workId} 的本地草稿`}>
      <div className="work-draft__head">
        <strong>本地草稿</strong>
        <span className="work-draft__tag" data-dirty={draft.dirty}>
          {draft.dirty ? '未保存' : '无改动'}
        </span>
        <button type="button" className="work-draft__undo" disabled={!canUndo} onClick={undo}>
          撤销
        </button>
      </div>
      <textarea
        className="work-draft__input"
        aria-label={`作品 ${workId} 的本地草稿`}
        rows={4}
        value={draft.text}
        placeholder="这里输入的内容只属于当前作品，切换作品不会串台。"
        onChange={(e) => setDraftText(e.target.value)}
      />
    </section>
  );
}