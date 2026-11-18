import { Button, Checkbox, Input, Tag } from 'antd';
import { Link } from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PartialSuccessState,
  formatTimestamp,
} from '@knowstudio/ui';
import type { ApiError, Material, MaterialSource, SearchSession } from '@knowstudio/contracts';
import {
  confidencePercent,
  licenseLabel,
  materialGroups,
  partialItemsOf,
  platformLabels,
  saturationColor,
  saturationLabel,
  searchInputIssue,
  topicsTarget,
} from './searchLogic';
import type { SearchViewState } from './searchLogic';

export interface DiscoverViewProps {
  readonly workId?: string | null;
  readonly workTitle?: string | null;
  readonly workLoading: boolean;
  readonly keyword: string;
  readonly domain: string;
  readonly materialSources: readonly MaterialSource[];
  readonly selectedSourceIds: readonly string[];
  readonly sourcesLoading: boolean;
  readonly sameResult: boolean;
  readonly submitting: boolean;
  readonly session: SearchSession | null;
  readonly view: SearchViewState;
  readonly error: ApiError | null;
  readonly collectError: ApiError | null;
  readonly collectFailed: boolean;
  readonly collectingMaterialId: string | null;
  readonly onKeywordChange: (value: string) => void;
  readonly onDomainChange: (value: string) => void;
  readonly onToggleSource: (source: MaterialSource) => void;
  readonly onSubmit: () => void;
  readonly onRetry: () => void;
  readonly onToggleCollect: (material: Material) => void;
}

const EXAMPLES = ['费曼学习法'] as const;

function SaturationGauge({ session }: { session: SearchSession }) {
  const saturation = session.saturation;
  if (saturation == null) return null;
  const circumference = Math.PI * 70;
  const color = saturationColor(saturation.level);
  return (
    <section className="discover-gauge" aria-label="知识点饱和度">
      <svg
        viewBox="0 0 180 104"
        role="img"
        aria-label={`饱和度 ${saturation.score}，${saturationLabel(saturation.level)}`}
      >
        <path
          d="M 15 92 A 70 70 0 0 1 165 92"
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d="M 15 92 A 70 70 0 0 1 165 92"
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${(saturation.score / 100) * circumference} ${circumference}`}
        />
        <text x="90" y="68" className="discover-gauge__score" textAnchor="middle">
          {saturation.score}
        </text>
        <text x="90" y="88" className="discover-gauge__caption" textAnchor="middle">
          {saturationLabel(saturation.level)}
        </text>
      </svg>
      {saturation.sufficient ? null : <p className="discover-gauge__warning">数据不足，仅供参考</p>}
    </section>
  );
}

function SaturationDetails({ session }: { session: SearchSession }) {
  const saturation = session.saturation;
  if (saturation == null) return null;
  return (
    <section className="discover-gauge__details" aria-label="饱和度依据">
      <dl>
        <div>
          <dt>置信度</dt>
          <dd>{confidencePercent(saturation.confidence)}</dd>
        </div>
        <div>
          <dt>样本量</dt>
          <dd>{saturation.sampleSize}</dd>
        </div>
        <div>
          <dt>覆盖平台</dt>
          <dd>{platformLabels(saturation.coveredPlatforms).join(' / ') || '暂无'}</dd>
        </div>
        <div>
          <dt>聚合时间</dt>
          <dd>{formatTimestamp(session.createdAt)}</dd>
        </div>
      </dl>
      <p className="discover-gauge__sources">
        来源：{saturation.sources.length > 0 ? saturation.sources.join('、') : '暂无'}
      </p>
    </section>
  );
}

function MaterialCard({
  material,
  pending,
  onToggleCollect,
}: {
  material: Material;
  pending: boolean;
  onToggleCollect: (material: Material) => void;
}) {
  return (
    <article className="discover-material" data-material-id={material.id}>
      <header>
        <span className="discover-material__source">
          <i aria-hidden="true" />
          {material.source}
        </span>
        <Tag className="discover-material__license" data-license={material.license}>
          {licenseLabel(material.license)}
        </Tag>
      </header>
      <h3>{material.title}</h3>
      <p>{material.summary === '' ? '暂无摘要，可从来源判断适用性。' : material.summary}</p>
      <footer>
        {material.url == null ? (
          <span className="discover-material__linkless">站内摘要</span>
        ) : (
          <a href={material.url} target="_blank" rel="noreferrer">
            打开来源
          </a>
        )}
        <Button
          size="small"
          aria-pressed={material.collected}
          loading={pending}
          onClick={() => onToggleCollect(material)}
        >
          {material.collected ? '已收藏' : '收藏'}
        </Button>
      </footer>
    </article>
  );
}

function MaterialBoard({
  session,
  collectingMaterialId,
  onToggleCollect,
}: {
  session: SearchSession;
  collectingMaterialId: string | null;
  onToggleCollect: (material: Material) => void;
}) {
  return (
    <div className="discover-materials">
      {materialGroups(session.materials).map((group) => (
        <section key={group.kind} className="discover-materials__group" data-kind={group.kind}>
          <header>
            <h3>{group.label}</h3>
            <span>{group.materials.length}</span>
          </header>
          <p>{group.description}</p>
          {group.materials.map((material) => (
            <MaterialCard
              key={material.id}
              material={material}
              pending={collectingMaterialId === material.id}
              onToggleCollect={onToggleCollect}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ResultSummary({ session }: { session: SearchSession }) {
  return (
    <section className="discover-summary">
      <div className="discover-summary__main">
        <SaturationGauge session={session} />
        <SaturationDetails session={session} />
      </div>
      <section className="discover-angles" aria-label="空白角度">
        <h2>空白角度</h2>
        {session.blankAngles.length === 0 ? (
          <p>这批素材里暂无明确空白角度。</p>
        ) : (
          <ul>
            {session.blankAngles.map((angle) => (
              <li key={angle.id}>
                <Link to={topicsTarget(session, angle)} title={angle.rationale}>
                  + {angle.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function ActionBar({ session, workId }: { session: SearchSession; workId?: string | null }) {
  const collectedCount = session.materials.filter((m) => m.collected).length;
  return (
    <footer className="discover-action-bar">
      <div>
        <strong>已收藏 {collectedCount} 条素材</strong>
        <span>将作为选题脑暴输入</span>
      </div>
      <div>
        <Link className="discover-action-bar__secondary" to="/library">
          查看素材库
        </Link>
        <Button
          type="primary"
          disabled={collectedCount === 0}
          title={collectedCount === 0 ? '先收藏至少一条素材' : undefined}
          href={collectedCount === 0 ? undefined : topicsTarget(session)}
        >
          去选题
        </Button>
      </div>
      {workId == null ? null : (
        <span className="discover-action-bar__work">当前作品：{workId}</span>
      )}
    </footer>
  );
}

export function DiscoverView(props: DiscoverViewProps) {
  const {
    workId,
    workTitle,
    workLoading,
    keyword,
    domain,
    materialSources,
    selectedSourceIds,
    sourcesLoading,
    sameResult,
    submitting,
    session,
    view,
    error,
    collectError,
    collectFailed,
    collectingMaterialId,
    onKeywordChange,
    onDomainChange,
    onToggleSource,
    onSubmit,
    onRetry,
    onToggleCollect,
  } = props;
  const issue = searchInputIssue(keyword, domain);
  const submitLabel = sameResult ? '已是最新结果' : session == null ? '开始聚合' : '重新聚合';
  const realSourceConfigured = materialSources.some(
    (source) => source.configured && source.id !== 'recorded',
  );

  return (
    <section className="discover-page">
      <header className="discover-head">
        <div>
          <h1>素材搜索</h1>
          <p>输入一个知识点，判断还能怎么讲。</p>
        </div>
        <div className="discover-head__work">
          {workId == null ? (
            <Tag color="warning">提交后创建作品</Tag>
          ) : (
            <>
              <span>当前作品</span>
              <strong>{workTitle ?? workId}</strong>
            </>
          )}
        </div>
      </header>

      <form
        className="discover-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="discover-form__main">
          <label>
            关键词或领域
            <Input
              value={keyword}
              maxLength={40}
              placeholder="例如：费曼学习法"
              aria-label="关键词或领域"
              onChange={(event) => onKeywordChange(event.target.value)}
            />
          </label>
          <label>
            领域偏好（可选）
            <Input
              value={domain}
              maxLength={40}
              placeholder="例如：学习方法"
              aria-label="领域偏好（可选）"
              onChange={(event) => onDomainChange(event.target.value)}
            />
          </label>
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting || (workLoading && workId == null)}
            disabled={issue != null || sameResult || (workLoading && workId == null)}
          >
            {submitLabel}
          </Button>
        </div>
        <div className="discover-form__examples">
          <span>试试：</span>
          {EXAMPLES.map((example) => (
            <Button key={example} type="text" size="small" onClick={() => onKeywordChange(example)}>
              {example}
            </Button>
          ))}
          {issue == null ? null : <span className="discover-form__issue">{issue}</span>}
        </div>
        <fieldset className="discover-form__sources" aria-label="素材源">
          <legend>素材源</legend>
          {sourcesLoading ? (
            <span className="discover-form__source-status">正在读取配置</span>
          ) : (
            <div className="discover-form__source-list">
              {materialSources.map((source) => (
                <label
                  key={source.id}
                  className="discover-form__source"
                  data-configured={source.configured}
                >
                  <Checkbox
                    checked={source.configured && selectedSourceIds.includes(source.id)}
                    disabled={!source.configured}
                    onChange={() => onToggleSource(source)}
                  >
                    {source.name}
                  </Checkbox>
                  <span>{source.description}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </form>

      {collectFailed ? (
        <ErrorState
          error={collectError ?? undefined}
          title="收藏没有生效"
          description="素材状态保持不变，请重试。"
          level="section"
          testId="discover-collect-error"
        />
      ) : null}

      {view.kind === 'initial' ? (
        <EmptyState
          title="从一个知识点开始"
          description="先看素材、饱和度和空白角度，再决定这条视频要不要做。"
          level="section"
          testId="discover-initial"
        />
      ) : null}

      {view.kind === 'loading' ? (
        <LoadingState
          variant="grid"
          label="正在聚合素材"
          hint="正在等待知识、热点与同行素材返回"
          dimmed={view.session?.materials.length != null && view.session.materials.length > 0}
          testId="discover-loading"
        >
          {view.session != null && view.session.materials.length > 0 ? (
            <MaterialBoard
              session={view.session}
              collectingMaterialId={collectingMaterialId}
              onToggleCollect={onToggleCollect}
            />
          ) : null}
        </LoadingState>
      ) : null}

      {view.kind === 'error' ? (
        <ErrorState
          error={error ?? undefined}
          title="聚合没有完成"
          description={sameResult ? '关键词还保留着，可以直接重试。' : '已输入的关键词仍保留。'}
          level="section"
          actions={[{ key: 'retry', label: '重试聚合', primary: true, onClick: onRetry }]}
          testId="discover-error"
        />
      ) : null}

      {view.kind === 'empty' ? (
        <EmptyState
          title="没有搜到结果"
          description={
            selectedSourceIds.includes('recorded') && selectedSourceIds.length === 1
              ? realSourceConfigured
                ? '当前录制源只包含示例关键词；勾选 Web 搜索或 Obsidian 后重试。'
                : '当前录制源只包含示例关键词；服务端配置 Tavily 或 Obsidian MCP 并重启 API 后可搜索真实内容。'
              : '换一个更具体的词，或放宽领域偏好再试一次。'
          }
          level="section"
          actions={[{ key: 'retry', label: '重新聚合', primary: true, onClick: onRetry }]}
          testId="discover-empty"
        />
      ) : null}

      {view.kind === 'success' ? (
        <>
          {view.partial ? (
            <PartialSuccessState
              items={partialItemsOf(view.session)}
              title="部分来源没有返回"
              summary="已返回的素材可以继续收藏，失败来源可稍后重试。"
              actions={[{ key: 'retry', label: '重新聚合', primary: true, onClick: onRetry }]}
              level="section"
            />
          ) : null}
          <ResultSummary session={view.session} />
          <MaterialBoard
            session={view.session}
            collectingMaterialId={collectingMaterialId}
            onToggleCollect={onToggleCollect}
          />
          <ActionBar session={view.session} workId={workId} />
        </>
      ) : null}

      {view.kind === 'error' && view.session != null && view.session.materials.length > 0 ? (
        <MaterialBoard
          session={view.session}
          collectingMaterialId={collectingMaterialId}
          onToggleCollect={onToggleCollect}
        />
      ) : null}
    </section>
  );
}
