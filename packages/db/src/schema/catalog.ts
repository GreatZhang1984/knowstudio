/** 音色与模板目录（架构 §4.4 1043–1067 行）。R4：无商用凭证的音色不得上架。 */
import type { Bool, Defaulted, JsonCol, JsonColDefaulted, Nullable } from './column-types.js';

export interface VoiceCatalogTable {
  id: string;
  provider: string;
  name: string;
  gender: Nullable<string>;
  timbre: Nullable<string>;
  /** 真实试听样本（D-16），不是 toast。 */
  sample_layer_key: string;
  /** NOT NULL：无凭证不得上架。 */
  license_evidence: JsonCol;
  is_active: Defaulted<Bool>;
  ord: Nullable<number>;
}

export interface TemplateCatalogTable {
  id: string;
  name: string;
  version: number;
  palette: JsonCol;
  /** 字体来源；合规白名单判定读它（架构 §8 OFL 白名单）。 */
  font_family: string;
  /** 6 种页型。 */
  page_types: JsonCol;
  orients: JsonColDefaulted;
  /** 指向声明式版式包。 */
  manifest_key: string;
  is_active: Defaulted<Bool>;
}