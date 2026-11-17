import 'reflect-metadata';
import { Injectable, Inject, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

const TOKEN = Symbol('probe.token');

@Injectable()
class Consumer {
  constructor(@Inject(TOKEN) public readonly value: string) {}
}

@Module({
  providers: [{ provide: TOKEN, useValue: 'injected-ok' }, Consumer],
})
class ProbeModule {}

describe('DI 探针：esbuild 下 @Inject(TOKEN) 参数装饰器', () => {
  it('构造参数显式令牌注入运行时非 undefined', async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false });
    const consumer = app.get(Consumer);
    expect(consumer.value).toBe('injected-ok');
    await app.close();
  });
});