import type { ReactNode } from 'react';
import { Button } from 'antd';
import type { PresentationLevel, StateAction, StateTone } from './types';

export interface StateShellProps {
  tone: StateTone;
  level: PresentationLevel;
  title: string;
  description?: string;
  /** 附加提示，例如 SPEC §9 视频预览的「额度已退」。 */
  notice?: string;
  icon?: ReactNode;
  actions?: readonly StateAction[];
  headingLevel?: 2 | 3 | 4;
  className?: string;
  children?: ReactNode;
  /** 覆盖 role/aria-live：加载态等非通知场景用得到。 */
  role?: 'status' | 'alert';
  testId?: string;
}

const cx = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' ');

/**
 * 五个异常态共用的外壳：强调条 + 标题 + 说明 + 动作区。
 * 颜色全部走 tokens.css 变量；tone 只染左侧强调条与图标，
 * 语义同时由文本承载，不靠颜色单独表意（WCAG 1.4.1）。
 */
export function StateShell({
  tone,
  level,
  title,
  description,
  notice,
  icon,
  actions = [],
  headingLevel = 3,
  className,
  children,
  role,
  testId,
}: StateShellProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const live = role ?? (tone === 'danger' ? 'alert' : 'status');
  return (
    <div
      className={cx('ks-state', className)}
      data-tone={tone}
      data-level={level}
      data-testid={testId}
      role={live}
      aria-live={live === 'alert' ? 'assertive' : 'polite'}
    >
      <div className="ks-state__main">
        {icon == null ? null : (
          <span className="ks-state__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div className="ks-state__text">
          <Heading className="ks-state__title">{title}</Heading>
          {description == null || description === '' ? null : (
            <p className="ks-state__desc">{description}</p>
          )}
          {notice == null || notice === '' ? null : (
            <p className="ks-state__notice">{notice}</p>
          )}
          {children}
        </div>
      </div>
      {actions.length === 0 ? null : <StateActions actions={actions} />}
    </div>
  );
}

/** 动作区。主行动只加字重与描边，不引入新底色（避免造出对比度矩阵外的第六个容器）。 */
export function StateActions({ actions }: { actions: readonly StateAction[] }) {
  const ordered = [...actions].sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
  return (
    <div className="ks-state__actions">
      {ordered.map((action) => (
        <Button
          key={action.key}
          className="ks-state__btn"
          data-primary={action.primary === true}
          disabled={action.disabled === true}
          title={action.disabledReason}
          aria-label={
            action.disabledReason == null ? action.label : `${action.label}（${action.disabledReason}）`
          }
          href={action.href}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}