import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SourceConfigCipher {
  encrypt(plain: string): string;
  decrypt(input: string): string;
}

function encryptWith(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const value = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    value.toString('base64url'),
  ].join('.');
}

function decryptWith(key: Buffer, input: string): string {
  const [version, ivText, tagText, valueText] = input.split('.');
  if (version !== 'v1') throw new Error('SOURCE_CONFIG_CIPHER_VERSION_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText ?? '', 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText ?? '', 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(valueText ?? '', 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function createSourceConfigCipher(key: Buffer): SourceConfigCipher {
  if (key.length !== 32) throw new Error('SOURCE_CONFIG_KEY_LENGTH_INVALID');
  return {
    encrypt: (plain) => encryptWith(key, plain),
    decrypt: (input) => decryptWith(key, input),
  };
}

/**
 * 本地/自托管部署使用服务端密钥文件加密用户凭据。文件随部署卷持久化；
 * 不进入 Git，也不要求用户配置系统环境变量。
 */
export function createFileSourceConfigCipher(
  keyPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../..',
    'infra/.source-config.key',
  ),
): SourceConfigCipher {
  const readKey = (): Buffer => {
    const text = readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(text, 'hex');
    if (key.length !== 32) throw new Error('SOURCE_CONFIG_KEY_LENGTH_INVALID');
    return key;
  };

  if (!existsSync(keyPath)) {
    const key = randomBytes(32).toString('hex');
    try {
      writeFileSync(keyPath, `${key}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
  chmodSync(keyPath, 0o600);
  const key = readKey();
  return createSourceConfigCipher(key);
}
