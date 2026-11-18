import { describe, expect, it } from 'vitest';
import { readAuthOptions } from '../src/config/env.js';

describe('readAuthOptions · 开发验证码回显', () => {
  it('本地开发缺省开启：NODE_ENV 未设置或 development 时无需手动配置', () => {
    expect(readAuthOptions({}).devCodeEcho).toBe(true);
    expect(readAuthOptions({ NODE_ENV: 'development' }).devCodeEcho).toBe(true);
  });

  it('AUTH_DEV_CODE_ECHO=false 可显式关闭本地回显', () => {
    expect(readAuthOptions({ AUTH_DEV_CODE_ECHO: 'false' }).devCodeEcho).toBe(false);
    expect(
      readAuthOptions({ NODE_ENV: 'development', AUTH_DEV_CODE_ECHO: 'false' }).devCodeEcho,
    ).toBe(false);
  });

  it('test/staging 等非本地环境缺省不开启', () => {
    expect(readAuthOptions({ NODE_ENV: 'test' }).devCodeEcho).toBe(false);
    expect(readAuthOptions({ NODE_ENV: 'staging' }).devCodeEcho).toBe(false);
  });

  it('生产环境强制关闭，即使显式配置 true 也不返回验证码', () => {
    expect(readAuthOptions({ NODE_ENV: 'production' }).devCodeEcho).toBe(false);
    expect(
      readAuthOptions({ NODE_ENV: 'production', AUTH_DEV_CODE_ECHO: 'true' }).devCodeEcho,
    ).toBe(false);
  });
});
