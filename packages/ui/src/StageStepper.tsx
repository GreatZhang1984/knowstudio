import type { CSSProperties } from 'react';
import type { Phase } from '@knowstudio/contracts';
import { STAGES, stageOfPhase } from './tokens';
import type { Stage } from './tokens';

export interface StageStepperProps {
  phase: Phase;
  /**
   * 不传即只读。是否「已解锁」不由本组件判断：点击后照常导航，
   * 由服务端信封决定目标页是正常态还是 GateLocked（架构 §5.5）。
   */
  onSelect?: (stage: Stage) => void;
  compact?: boolean;
}

/** 架构 §11.4 自建模式 1：AntD Steps 无法表达四段签名色与 dim 变体。 */
export function StageStepper({ phase, onSelect, compact = false }: StageStepperProps) {
  const current = stageOfPhase(phase).phase;
  const finished = phase === 4;

  return (
    <ol className="ks-stepper" data-compact={compact ? 'true' : 'false'}>
      {STAGES.map((stage) => {
        const state = finished || stage.phase < current ? 'done' : stage.phase === current ? 'current' : 'todo';
        const style = {
          '--seg-c': `var(--${stage.token})`,
          '--seg-dim': `var(--${stage.token}-dim)`,
        } as CSSProperties;
        return (
          <li key={stage.key} className="ks-stepper__item" data-state={state} style={style}>
            <button
              type="button"
              className="ks-stepper__btn"
              aria-current={state === 'current' ? 'step' : undefined}
              aria-label={`第 ${stage.phase + 1} 段 ${stage.label}${state === 'done' ? '（已完成）' : state === 'current' ? '（进行中）' : ''}`}
              disabled={onSelect == null}
              onClick={() => onSelect?.(stage)}
            >
              <span className="ks-stepper__dot" aria-hidden="true">
                {stage.phase + 1}
              </span>
              <span className="ks-stepper__label">{compact ? stage.short : stage.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}