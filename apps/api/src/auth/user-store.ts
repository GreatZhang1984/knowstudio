/**
 * 用户存储端口与实现。
 *
 * 形状对齐 arch §4.4 app_user DDL（arch:420–438）：
 *   id CHAR(36)、name、avatar_url、phone/email（唯一键）、password_hash VARCHAR(255) NULL、
 *   domain_prefs JSON、default_platforms JSON、plan_id、theme、onboarded_at、created_at。
 *
 * 生产实现 KyselyUserStore 消费 DB_CLIENT。WP10 已落地冻结出口
 *   createDbClient(config:{url,connectionLimit?}) → Kysely<Database>（从 @knowstudio/db 导出），
 *   infrastructure.providers.ts 的 DB_CLIENT factory 即调用它，签名分歧已消除。
 * MySQL 现状（2026-11-13 只读核验）：36 表已建、app_user 存在、DDL 与下方 UserRecord 逐列对齐。
 * 生产 boot 已实测启动；GET /api/me 携合法 Bearer 返回真实库用户（200）。
 * 真实库只读集成测试见 apps/api/test/user-store-db.test.ts（findById/findByAccount + MeResponse.parse）。
 * 单元/集成测试用 InMemoryUserStore（真实 argon2id 哈希），不触碰数据库、不建表、不改 fixtures。
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT } from '../shared/tokens.js';

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly passwordHash: string | null;
  readonly domainPrefs: readonly string[];
  readonly defaultPlatforms: readonly string[];
  readonly planId: string;
  readonly theme: 'dark' | 'light';
  readonly onboardedAt: string | null;
  readonly createdAt: string;
}

export interface UserStore {
  /** account 是手机号或邮箱（SPEC §3.13）。匹配 phone 或 email 唯一键。 */
  findByAccount(account: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
}

/** 测试与本地开发用内存实现。绝不用于生产。 */
@Injectable()
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>();

  constructor(users: readonly UserRecord[] = []) {
    for (const u of users) this.byId.set(u.id, u);
  }

  seed(user: UserRecord): void {
    this.byId.set(user.id, user);
  }

  async findByAccount(account: string): Promise<UserRecord | null> {
    for (const u of this.byId.values()) {
      if (u.phone === account || u.email === account) return u;
    }
    return null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }
}

/**
 * Kysely 的最小结构化视图。
 *
 * 为什么不 import type { Kysely } from 'kysely'：kysely 未在 apps/api 依赖里
 * （pnpm 严格隔离，实测不可解析）。本接口只声明 findByAccount/findById 用到的查询子集；
 * WP10 已落地（createDb→DbHandle.db 即 Kysely<Database>），由协调者复核 Kysely<Database>
 * 对本接口的可赋值性（selectFrom/selectAll/where/executeTakeFirst）。
 */
export interface DbLike {
  selectFrom(table: 'app_user'): {
    selectAll(): {
      where(
        column: 'id' | 'phone' | 'email',
        operator: '=',
        value: string,
      ): { executeTakeFirst(): Promise<Record<string, unknown> | undefined> };
    };
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  // mysql2 dateStrings:true 把 DATETIME(3) 返回为 'YYYY-MM-DD HH:MM:SS.mmm'（会话 time_zone=+00:00，即 UTC）。
  // 契约 UtcTimestamp=z.string().datetime() 只收 ISO 8601（'T' 分隔 + 'Z' 后缀），空格串会被拒→MeResponse.parse 抛错。
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(s);
  return m ? `${m[1]}T${m[2]}${m[3] ?? ''}Z` : s;
}

function rowToUser(row: Record<string, unknown>): UserRecord {
  const theme = row['theme'] === 'light' ? 'light' : 'dark';
  return {
    id: String(row['id']),
    name: String(row['name']),
    avatarUrl: row['avatar_url'] === null || row['avatar_url'] === undefined ? null : String(row['avatar_url']),
    phone: row['phone'] === null || row['phone'] === undefined ? null : String(row['phone']),
    email: row['email'] === null || row['email'] === undefined ? null : String(row['email']),
    passwordHash:
      row['password_hash'] === null || row['password_hash'] === undefined ? null : String(row['password_hash']),
    domainPrefs: toStringArray(row['domain_prefs']),
    defaultPlatforms: toStringArray(row['default_platforms']),
    planId: String(row['plan_id'] ?? 'creator_168'),
    theme,
    onboardedAt: toIso(row['onboarded_at']),
    createdAt: toIso(row['created_at']) ?? new Date(0).toISOString(),
  };
}

/** 生产实现：消费 DB_CLIENT（createDbClient → Kysely<Database>）。36 表已建、app_user DDL 对齐；真实库只读集成测试见 test/user-store-db.test.ts。 */
@Injectable()
export class KyselyUserStore implements UserStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbLike) {}

  async findByAccount(account: string): Promise<UserRecord | null> {
    const byPhone = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where('phone', '=', account)
      .executeTakeFirst();
    if (byPhone) return rowToUser(byPhone);
    const byEmail = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where('email', '=', account)
      .executeTakeFirst();
    return byEmail ? rowToUser(byEmail) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.selectFrom('app_user').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? rowToUser(row) : null;
  }
}