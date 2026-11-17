/**
 * T-10 消费的两个跨 Task 端口。
 *
 * 为什么是端口而不是直接实现：
 *  - 闸门真相快照需聚合 script / video_asset / compliance_report（架构 §5.3），属 T-12 GateGuard；
 *  - 配额必须由 quota_ledger 聚合（架构 §7.1 唯一真相），属 T-42/T-43 packages/quota。
 * 两者都不在 T-10 的写入边界内。若在此自行实现，就会出现「第二份闸门判定」与
 * 「第二份额度算法」——正是 D-04（硬编码 ok:true）与 D-22（三处额度不同源）的根因形状。
 *
 * 故本模块只声明形状并显式注入；未绑定即 Nest 启动失败（fail-closed），
 * 绝不退化成「默认全放行」或「默认 0 点」。
 */
import type { Quota, WorkTruthSnapshot } from '@knowstudio/contracts';
import type { WorkRow } from '@knowstudio/db/repositories';

/**
 * 加载闸门真相快照。入参是**已通过 OwnershipGuard 校验**的 work 行，
 * 故实现无需再做归属判断，也不能借此绕过隔离。
 */
export interface WorkTruthSnapshotLoader {
  load(work: WorkRow): Promise<WorkTruthSnapshot>;
}

/** 读取用户当前配额（架构 §7.1：total/used/reserved/left 同源于一份账本聚合）。 */
export interface WorkQuotaReader {
  readForUser(userId: string): Promise<Quota>;
}