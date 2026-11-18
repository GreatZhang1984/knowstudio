/**
 * T-06 配置读取。所有可调参数走环境变量，缺省值仅用于本地开发。
 * 生产必须由部署环境注入 JWT_SECRET；DEV_JWT_SECRET 只是开发兜底，绝不用于生产。
 */
export interface AuthOptions {
  readonly jwtSecret: string;
  /** accessToken 寿命：arch §1.2 第 18 行 / §13 固定 15min。 */
  readonly accessTokenTtlSec: number;
  /** refreshToken / 服务端会话寿命（秒）。默认 7 天。 */
  readonly refreshTtlSec: number;
  /** 登录验证码寿命（秒）。默认 5 分钟。 */
  readonly codeTtlSec: number;
  /** 验证码重发冷却（秒）。arch §13「登录验证码限频」。 */
  readonly codeResendCooldownSec: number;
  /** 生产置 true：refresh cookie 加 Secure。 */
  readonly cookieSecure: boolean;
  readonly cookieDomain: string | undefined;
  /** 仅本地开发：登录验证码随发码响应回显，生产环境强制关闭。 */
  readonly devCodeEcho: boolean;
}

/** 开发兜底密钥。生产必须用环境变量覆盖；本值公开写在代码里，不具备保密性。 */
export const DEV_JWT_SECRET = 'knowstudio-dev-only-jwt-secret-CHANGE-ME';

export const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 900，arch 硬约束
export const DEFAULT_REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 604800
export const DEFAULT_CODE_TTL_SEC = 5 * 60; // 300
export const DEFAULT_CODE_RESEND_COOLDOWN_SEC = 60;

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readAuthOptions(env: Record<string, string | undefined>): AuthOptions {
  const nodeEnv = env['NODE_ENV'];
  const echoSetting = env['AUTH_DEV_CODE_ECHO'];
  const localDevelopment = nodeEnv === undefined || nodeEnv === '' || nodeEnv === 'development';
  const devCodeEcho =
    nodeEnv !== 'production' &&
    (echoSetting === 'true' ||
      ((echoSetting === undefined || echoSetting === '') && localDevelopment));

  return {
    jwtSecret: env['JWT_SECRET'] ?? DEV_JWT_SECRET,
    accessTokenTtlSec: intFrom(env['ACCESS_TOKEN_TTL_SEC'], ACCESS_TOKEN_TTL_SEC),
    refreshTtlSec: intFrom(env['REFRESH_TTL_SEC'], DEFAULT_REFRESH_TTL_SEC),
    codeTtlSec: intFrom(env['CODE_TTL_SEC'], DEFAULT_CODE_TTL_SEC),
    codeResendCooldownSec: intFrom(env['CODE_RESEND_COOLDOWN_SEC'], DEFAULT_CODE_RESEND_COOLDOWN_SEC),
    cookieSecure: env['COOKIE_SECURE'] === 'true',
    cookieDomain: env['COOKIE_DOMAIN'],
    devCodeEcho,
  };
}

export interface InfrastructureEnv {
  readonly databaseUrl: string;
  readonly dbConnectionLimit: number;
  readonly redisUrl: string;
  readonly redisKeyPrefix: string;
  readonly s3Endpoint: string;
  readonly s3Region: string;
  readonly s3Bucket: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly s3ForcePathStyle: boolean;
}

export function readInfrastructureEnv(env: Record<string, string | undefined>): InfrastructureEnv {
  return {
    databaseUrl: env['DATABASE_URL'] ?? 'mysql://knowstudio:knowstudio_app_dev_only@127.0.0.1:3306/knowstudio',
    dbConnectionLimit: intFrom(env['DB_CONNECTION_LIMIT'], 10),
    redisUrl: env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    redisKeyPrefix: env['REDIS_KEY_PREFIX'] ?? 'knowstudio:',
    s3Endpoint: env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    s3Region: env['S3_REGION'] ?? 'us-east-1',
    s3Bucket: env['S3_BUCKET'] ?? 'knowstudio',
    s3AccessKeyId: env['S3_ACCESS_KEY_ID'] ?? '',
    s3SecretAccessKey: env['S3_SECRET_ACCESS_KEY'] ?? '',
    s3ForcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
  };
}
