import type { ReactNode } from 'react';
import { StateShell } from './StateShell';
import type { PresentationLevel, StateAction, StateTone } from './types';

export interface EmptyStateProps {
  /** 文案由屏传入：「无作品 → 新建引导」「无结果 → 换词/导入」各自不同（SPEC §9 空列）。 */
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: readonly StateAction[];
  tone?: StateTone;
  level?: PresentationLevel;
  headingLevel?: 2 | 3 | 4;
  className?: string;
  testId?: string;
  children?: ReactNode;
}

/** 空态。通用组件不含任何一屏的业务文案与路由，全部靠 props。 */
export function EmptyState({
  title,
  description,
  icon,
  actions,
  tone = 'neutral',
  level = 'section',
  headingLevel,
  className,
  testId,
  children,
}: EmptyStateProps) {
  return (
    <StateShell
      tone={tone}
      level={level}
      title={title}
      description={description}
      icon={icon}
      actions={actions}
      headingLevel={headingLevel}
      className={['ks-empty', className].filter(Boolean).join(' ')}
      testId={testId}
    >
      {children}
    </StateShell>
  );
}