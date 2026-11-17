import type { ReactNode } from 'react';
import { skeletonCount } from './skeleton';
import type { SkeletonVariant } from './skeleton';

export interface LoadingStateProps {
  variant?: SkeletonVariant;
  count?: number;
  /** 屏幕阅读器播报文本。 */
  label?: string;
  /** 可见提示，例如「正在聚合 4 类来源…」。 */
  hint?: string;
  /**
   * 已有内容降透明 + 骨架覆盖（SPEC §9 选题脑暴「网格降透明 + 骨架」）。
   * 降透明层会被标记 aria-hidden 且不可交互：它是加载期的装饰，
   * 语义由 aria-busy + label 承载，因此不参与文本对比度判定。
   */
  dimmed?: boolean;
  /** 已有内容。dimmed=false 时渲染在骨架下方（保留已到的部分结果）。 */
  children?: ReactNode;
  className?: string;
  testId?: string;
}

const Bar = ({ w, h }: { w: string; h?: number }) => (
  <span className="ks-skel__bar" style={h == null ? { width: w } : { width: w, height: h }} />
);

function Shape({ variant, index }: { variant: SkeletonVariant; index: number }) {
  // 宽度按 index 错开，避免一列等宽长条看起来像真实内容。
  const tail = ['62%', '48%', '71%'][index % 3] ?? '60%';
  switch (variant) {
    case 'cards':
      return (
        <div className="ks-skel__card">
          <Bar w="45%" h={14} />
          <Bar w="92%" />
          <Bar w={tail} />
          <Bar w="30%" h={10} />
        </div>
      );
    case 'grid':
      return (
        <div className="ks-skel__cell">
          <span className="ks-skel__thumb" />
          <Bar w="80%" />
          <Bar w={tail} h={10} />
        </div>
      );
    case 'list':
      return (
        <div className="ks-skel__row">
          <span className="ks-skel__dot" />
          <span className="ks-skel__lines">
            <Bar w="55%" />
            <Bar w={tail} h={10} />
          </span>
        </div>
      );
    case 'text':
      return (
        <div className="ks-skel__para">
          <Bar w="35%" h={12} />
          <Bar w="96%" />
          <Bar w="88%" />
          <Bar w={tail} />
        </div>
      );
    case 'inline':
      return <Bar w={tail} />;
  }
}

/**
 * 加载态（骨架）。
 *
 * 为什么自建而不用 AntD Skeleton（架构 §11.4 把 Skeleton 列在「用 AntD」一侧）：
 * AntD 的骨架条底色来自 colorFillContent 等派生 token，会造出对比度矩阵外的新表面；
 * 自建后所有底色都落在 PALETTE 的五个容器里（--surface-2 / --overlay），
 * 呼吸动画只改 opacity，不引入任何新色值。详见 ../CONTRAST.md 第四节。
 */
export function LoadingState({
  variant = 'cards',
  count,
  label = '正在加载',
  hint,
  dimmed = false,
  children,
  className,
  testId,
}: LoadingStateProps) {
  const n = skeletonCount(variant, count);
  const overlay = dimmed && children != null;
  return (
    <div
      className={['ks-loading', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-overlay={overlay}
      data-testid={testId}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="ks-sr-only">{label}</span>
      {overlay ? (
        <div className="ks-loading__behind" aria-hidden="true">
          {children}
        </div>
      ) : null}
      <div className="ks-loading__grid">
        {Array.from({ length: n }, (_, i) => (
          <Shape key={i} variant={variant} index={i} />
        ))}
      </div>
      {hint == null || hint === '' ? null : <p className="ks-loading__hint">{hint}</p>}
      {overlay ? null : children}
    </div>
  );
}