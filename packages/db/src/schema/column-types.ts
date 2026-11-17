/**
 * 列类型映射约定（架构 §4.3.2）。
 *
 * 与驱动口径一一对应，改这里必须同步改 client.ts 的 mysql2 选项：
 *   CHAR(36) ascii_bin  → string
 *   DATETIME(3)         → string（UTC 字面量，dateStrings:true，杜绝时区隐式转换）
 *   TINYINT(1)          → 0 | 1（不是 boolean：mysql2 返回数字）
 *   BIGINT              → string（bigNumberStrings:true，>2^53 不丢精度）
 *   DECIMAL(p,s)        → string（精确小数，**禁止浮点参与计费**）
 *   JSON                → 读：已解析值；写：**序列化字符串**
 *
 * 为什么 JSON 写入是 string 而不是对象：
 *   mysql2 的 SqlString 会把普通对象转成 `k = 'v'` 形式（为 UPDATE SET 设计），
 *   直接传对象进 JSON 列会写坏数据。故在类型层就强制调用方先 JSON.stringify，
 *   用 `toJsonParam()` 统一入口，把这条坑变成编译期约束而不是运行期事故。
 */
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** CHAR(36) CHARACTER SET ascii COLLATE ascii_bin（前缀_ + ULID）。 */
export type Id = string;

/** DATETIME(3) 的 UTC 字面量：`YYYY-MM-DD HH:mm:ss.SSS`。 */
export type UtcDateTime = string;

/** TINYINT(1) / BOOLEAN。 */
export type Bool = 0 | 1;

/** BIGINT / BIGINT UNSIGNED，以 string 进出。 */
export type BigIntStr = string;

/** DECIMAL(p,s)，以 string 进出。 */
export type DecimalStr = string;

/** 带 DEFAULT 的列：插入时可省略，由服务端填默认值。 */
export type Defaulted<T> = Generated<T>;

/**
 * STORED 生成列与 AUTO_INCREMENT：不可插入、不可更新。
 * 对应 active_render_flag / current_flag / char_count / keyword_hash 与各流水表 id。
 */
export type DbGenerated<T> = GeneratedAlways<T>;

/**
 * JSON 列（NOT NULL，无 DEFAULT）。
 *
 * 刻意**不**给 T 加 `extends JsonValue` 约束：已知形状（Saturation / ComplianceItem 等）
 * 带可选属性，其值含 undefined，不满足严格的 JsonValue 递归约束；
 * 而 DB 侧本来就只保证「是合法 JSON」，内部结构由 contracts 的 zod 负责。
 */
export type JsonCol<T = JsonValue> = ColumnType<T, string, string>;

/**
 * JSON 列（NOT NULL + DEFAULT 表达式默认值）。
 *
 * 必须**平铺**成单层 ColumnType，不能写 `Defaulted<JsonCol<T>>`：
 * Generated 的定义是 ColumnType<S, S|undefined, S>，把 ColumnType 再塞进 S 会让
 * Kysely 的插入类型退化成「内层 ColumnType 对象」而不是 string（已实测报 TS2322）。
 */
export type JsonColDefaulted<T = JsonValue> = ColumnType<T, string | undefined, string>;

/** JSON 列（NULL 允许，无显式 DEFAULT → 插入可省略）。 */
export type JsonColNullable<T = JsonValue> = ColumnType<T | null, string | null | undefined, string | null>;

/**
 * NULL 列且无显式 DEFAULT：MySQL 隐式默认为 NULL，故插入时可省略。
 * 与 `T | null`（必须显式传 null）区分开，避免调用方被迫写一堆无意义的 null。
 */
export type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

/** JSON 写入统一入口。接受 unknown：调用方的形状由各自的 interface 约束。 */
export function toJsonParam(value: unknown): string {
  return JSON.stringify(value);
}