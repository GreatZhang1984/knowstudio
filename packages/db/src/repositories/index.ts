/**
 * `@knowstudio/db/repositories` —— 仓储层子路径入口（T-10 所有）。
 *
 * 与 WP10 的 `@knowstudio/db`（`.` → src/index.ts，连接层 + schema + 迁移）刻意分开：
 * 两个入口各自独立演进，仓储不需要等连接层 barrel 落地，连接层也不必导出仓储。
 * 包 package.json 的 exports 与根 tsconfig paths / vitest alias 已由协调者配好
 * （子路径排在父路径之前，避免 Vite 前缀替换把子路径吃掉）。
 *
 * 本 barrel **只导出仓储**，不重新导出 schema / client，避免与 WP10 的入口抢同一批符号。
 */
export {
  createUserSourceConfigRepository,
  type SaveUserSourceConfigInput,
  type ScopedUserSourceConfigRepository,
  type UserSourceConfigRepository,
  type UserSourceConfigRow,
} from './user-source-config-repository.js';
export {
  createWorkRepository,
  WorkIdInvalidError,
  WorkScopeRequiredError,
  type CreateWorkInput,
  type ScopedWorkRepository,
  type WorkListFilter,
  type WorkListPage,
  type WorkPageRequest,
  type WorkRepository,
  type WorkRow,
} from './work-repository.js';
export {
  decodeWorkCursor,
  encodeWorkCursor,
  WorkCursorInvalidError,
  type WorkCursor,
} from './work-cursor.js';
export {
  createWorkQuotaReader,
  QuotaAccountMissingError,
  QuotaTimestampInvalidError,
  type WorkQuotaReader,
} from './work-quota-reader.js';
export {
  createWorkTruthSnapshotLoader,
  WorkSnapshotTimestampInvalidError,
  type WorkTruthSnapshotLoader,
} from './work-truth-snapshot.js';
export {
  createSearchSessionRepository,
  SearchSessionIdInvalidError,
  SearchSessionScopeRequiredError,
  type CreateSearchSessionInput,
  type ScopedSearchSessionRepository,
  type SearchSessionRepository,
  type SearchSessionResults,
  type SearchSessionRow,
} from './search-session-repository.js';
export {
  createMaterialRepository,
  MaterialCursorInvalidError,
  MaterialIdInvalidError,
  MaterialScopeRequiredError,
  type LibraryFilter,
  type MaterialPage,
  type MaterialPageRequest,
  type MaterialRepository,
  type MaterialRow,
  type ScopedMaterialRepository,
} from './material-repository.js';
export {
  createWorkMaterialRepository,
  MaterialNotVisibleError,
  WorkMaterialIdInvalidError,
  WorkMaterialScopeRequiredError,
  WorkNotOwnedError,
  type ScopedWorkMaterialRepository,
  type WorkMaterialRepository,
} from './work-material-repository.js';
export {
  createTopicRepository,
  TopicIdInvalidError,
  TopicScopeRequiredError,
  type ScopedTopicRepository,
  type TopicBatchResult,
  type TopicBatchRow,
  type TopicCandidate,
  type TopicRepository,
  type TopicRow,
} from './topic-repository.js';
export {
  createScriptRepository,
  ScriptLockedError,
  ScriptScopeRequiredError,
  ScriptVersionConflictError,
  type ScriptAggregate,
  type ScriptLineInput,
  type ScriptRepository,
  type ScriptRow,
  type ScriptSectionInput,
  type ScriptSectionRow,
  type ScriptLineRow,
  type ScopedScriptRepository,
} from './script-repository.js';
export {
  createStyleRepository,
  StyleScopeRequiredError,
  type ScopedStyleRepository,
  type StyleProfileRow,
  type StyleRepository,
  type StyleSampleRow,
} from './style-repository.js';
