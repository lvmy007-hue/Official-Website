import { Injectable } from '@nestjs/common'
import { logger } from '../observability'
import { renderMail, type MailTemplate, type RenderedMail } from './templates'

// 邮件适配器（P1-19，14.10）：发送通道可替换，模板与调用方不变。
// 邮件服务与发信域名由部署专项配置；在此之前使用 UnconfiguredMailTransport——它如实报告“未发送”，
// 绝不假装成功。邀请链接此时由平台管理员在运营后台复制交付（仍是一次性、72 小时有效）。

export interface MailEnvelope extends RenderedMail {
  to: string
}

export abstract class MailTransport {
  abstract readonly name: string
  /** 发送成功返回；发送失败抛错。 */
  abstract send(message: MailEnvelope): Promise<void>
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('MAIL_NOT_CONFIGURED')
  }
}

@Injectable()
export class UnconfiguredMailTransport extends MailTransport {
  readonly name = 'unconfigured'
  async send(): Promise<void> {
    throw new MailNotConfiguredError()
  }
}

export type MailResult = { delivered: true } | { delivered: false; reason: 'MAIL_NOT_CONFIGURED' | 'SEND_FAILED' }

@Injectable()
export class MailService {
  constructor(private readonly transport: MailTransport) {}

  /** 发送一封模板邮件。从不抛错：调用方根据 delivered 决定是否提示“请手动交付”。邮箱地址不写入日志。 */
  async send(to: string, template: MailTemplate): Promise<MailResult> {
    try {
      await this.transport.send({ to, ...renderMail(template) })
      return { delivered: true }
    } catch (error) {
      if (error instanceof MailNotConfiguredError) return { delivered: false, reason: 'MAIL_NOT_CONFIGURED' }
      logger.error({ event: 'mail_send_failed', template: template.kind, transport: this.transport.name, error: error instanceof Error ? error.message : String(error) }, '邮件发送失败')
      return { delivered: false, reason: 'SEND_FAILED' }
    }
  }
}
