/**
 * 验证码发送端口（可替换）+ 本地开发实现。
 *
 * [待确认] SPEC §3.13 只说「验证码或密码」，**未定义短信/邮件供应商与模板**。
 * P0 不得发明外部供应商集成：这里只定义端口接口，本地开发实现把验证码记在内存
 * 并 console.warn（开发便利，绝不用于生产）。真实供应商适配器是后续 Task，
 * 需客户拍板供应商后另行接入。见交付报告 [待确认] 项。
 */
export type CodeChannel = 'sms' | 'email';

export interface CodeSender {
  send(account: string, code: string, channel: CodeChannel): Promise<void>;
}

/** 本地开发实现：记录最近一次验证码，供开发/测试取回。绝不接入真实供应商。 */
export class LocalDevCodeSender implements CodeSender {
  private readonly last = new Map<string, { code: string; channel: CodeChannel }>();

  async send(account: string, code: string, channel: CodeChannel): Promise<void> {
    this.last.set(account, { code, channel });
    // 开发便利：no-console 规则允许 warn。生产绝不打印验证码。
    console.warn(`[dev-code] account=${account} channel=${channel} code=${code}`);
  }

  /** 仅开发/测试用：取回最近发送的验证码。 */
  peek(account: string): { code: string; channel: CodeChannel } | undefined {
    return this.last.get(account);
  }
}