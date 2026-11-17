import { Button, Result, Tag } from 'antd';
import type { GateDetail, GateId, GateReason } from '@knowstudio/contracts';

/** G5 固定文案，导出成功态与发布清单共用（SPEC §2.3 / 架构 §5.5 静态防线④）。 */
export const G5_EXPORT_NOTICE = '知影不会替你自动发出去';

const GATE_LABEL: Record<GateId, string> = {
  G1: '选题门 G1',
  G2: '文案确认门 G2',
  G3: '高清渲染门 G3',
  G4: '合规门 G4',
};

/** 按 reason 选文案，不解析 message（架构 §10.1）。 */
const REASON_TEXT: Record<GateReason, { title: string; hint: string }> = {
  TOPIC_NOT_SELECTED: {
    title: '还没有选定角度',
    hint: '先在选题脑暴里选一个角度。知影不会替你跳过这一步。',
  },
  SCRIPT_NOT_CONFIRMED: {
    title: '文案还没有确认',
    hint: '在文案编辑器里二次确认后，文案将锁定并解锁视频生成。知影不会替你跳过。',
  },
  HD_RENDER_NOT_SUCCEEDED: {
    title: '高清渲染还没完成',
    hint: '渲染成功后才能拿母版去生成平台成片。渲染时你可以先去写平台标题。',
  },
  HD_ASSET_STALE: {
    title: '成片已过期',
    hint: '文案或素材改过，现有高清成片不再对应当前内容，需要重新渲染。',
  },
  HD_ASSET_SCRIPT_VERSION_MISMATCH: {
    title: '成片与文案版本不一致',
    hint: '当前文案版本比成片更新，请重新渲染高清后再派生。',
  },
  COMPLIANCE_REPORT_MISSING: {
    title: '还没有合规报告',
    hint: '先在导出页跑一次合规检查，报告通过后才能打包。',
  },
  COMPLIANCE_BLOCKING: {
    title: '合规检查有阻断项',
    hint: '有需授权或搬运命中的内容，移除或替换后才能导出。',
  },
  COMPLIANCE_FINGERPRINT_STALE: {
    title: '合规报告已过期',
    hint: '引用素材或授权状态变过，请重新跑一次合规检查。',
  },
};

export interface GateLockedProps {
  requiredGate: GateId;
  redirectTo: string;
  /** 服务端信封里的 gateDetails[requiredGate]，前端不做本地布尔判断（架构 §5.5）。 */
  detail?: GateDetail;
  onNavigate?: (path: string) => void;
}

/** 深链落到未解锁页面时的占位态。原因与 CTA 全部来自服务端下发的 detail。 */
export function GateLocked({ requiredGate, redirectTo, detail, onNavigate }: GateLockedProps) {
  const reason = detail?.reason;
  const text = reason == null ? undefined : REASON_TEXT[reason];
  const target = detail?.redirectTo ?? redirectTo;

  return (
    <div role="status" aria-live="polite" className="ks-gate-locked">
      <Result
        status="warning"
        title={`${GATE_LABEL[requiredGate]}未解锁`}
        subTitle={text?.title ?? '这一步的前置条件还没有满足。'}
        extra={
          <Button
            type="primary"
            onClick={onNavigate == null ? undefined : () => onNavigate(target)}
            href={onNavigate == null ? target : undefined}
          >
            回到上一门
          </Button>
        }
      >
        <p className="ks-gate-locked__hint">{text?.hint ?? '回到上一步完成后，这里会自动解锁。'}</p>
        <div className="ks-gate-locked__meta">
          {reason == null ? null : <Tag color="warning">{reason}</Tag>}
          {detail?.activeJobId == null ? null : <Tag>渲染任务 {detail.activeJobId}</Tag>}
        </div>
      </Result>
    </div>
  );
}