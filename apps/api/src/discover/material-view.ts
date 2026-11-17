/**
 * DB 素材行 → 契约 Material 视图（架构 §4.4 material / SPEC §3.2）。
 *
 * collected 不在仓储算（material-repository 只返回素材真相行）：由 API 层按 work_material 引用叠加
 * （搜索按当前 work、素材库按用户任一 work），本视图只接收已判定的 collected，绝不谎报（D-04 同源精神）。
 * url 取 source_url（种子为 null）；契约 HttpUrl.nullable 在 SearchSessionSchema/pageOf 边界复验，
 * 非 http(s) 的脏 url 会在此后的 parse 抛错，而不是静默下发可执行协议。
 */
import type { Material } from '@knowstudio/contracts';
import type { MaterialRow } from '@knowstudio/db/repositories';

export function toMaterial(row: MaterialRow, collected: boolean): Material {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.body_text ?? '',
    source: row.source,
    url: row.source_url,
    license: row.license,
    collected,
  };
}