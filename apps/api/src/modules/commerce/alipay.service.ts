import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createSign, createVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AppError } from '../../platform/http'

type AlipayParams = Record<string, string>

@Injectable()
export class AlipayService {
  constructor(private readonly config: ConfigService) {}

  configured() {
    return Boolean(
      this.config.get<string>('ALIPAY_APP_ID')?.trim() &&
      this.config.get<string>('ALIPAY_PRIVATE_KEY_PATH')?.trim() &&
      this.config.get<string>('ALIPAY_PUBLIC_KEY_PATH')?.trim() &&
      this.config.get<string>('ALIPAY_NOTIFY_URL')?.trim() &&
      this.config.get<string>('ALIPAY_RETURN_URL')?.trim(),
    )
  }

  configurationState() {
    return {
      provider: 'ALIPAY' as const,
      configured: this.configured(),
      appIdConfigured: Boolean(this.config.get<string>('ALIPAY_APP_ID')?.trim()),
      notifyUrlConfigured: Boolean(this.config.get<string>('ALIPAY_NOTIFY_URL')?.trim()),
      returnUrlConfigured: Boolean(this.config.get<string>('ALIPAY_RETURN_URL')?.trim()),
    }
  }

  createPagePayUrl(input: { orderNo: string; amount: string; subject: string }) {
    this.assertConfigured()
    const params = this.signedParams(
      'alipay.trade.page.pay',
      {
        out_trade_no: input.orderNo,
        total_amount: input.amount,
        subject: input.subject,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        timeout_express: '30m',
      },
      {
        notify_url: this.config.getOrThrow<string>('ALIPAY_NOTIFY_URL'),
        return_url: this.config.getOrThrow<string>('ALIPAY_RETURN_URL'),
      },
    )
    const target = new URL(this.gateway())
    Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value))
    return target.toString()
  }

  verifyNotification(payload: AlipayParams) {
    if (!this.configured()) return false
    const signature = payload.sign
    if (!signature) return false
    const signContent = Object.entries(payload)
      .filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== '')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    const verifier = createVerify('RSA-SHA256')
    verifier.update(signContent, 'utf8')
    verifier.end()
    const signatureValid = verifier.verify(this.publicKey(), signature, 'base64')
    if (!signatureValid) return false
    if (payload.app_id !== this.config.get<string>('ALIPAY_APP_ID')) return false
    const expectedSeller = this.config.get<string>('ALIPAY_SELLER_ID')?.trim()
    if (expectedSeller && payload.seller_id !== expectedSeller) return false
    return true
  }

  async refund(input: { orderNo: string; refundNo: string; amount: string; reason: string }) {
    this.assertConfigured()
    const params = this.signedParams('alipay.trade.refund', {
      out_trade_no: input.orderNo,
      refund_amount: input.amount,
      refund_reason: input.reason.slice(0, 200),
      out_request_no: input.refundNo,
    })
    const response = await fetch(this.gateway(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(params).toString(),
    })
    const text = await response.text()
    if (!response.ok) throw new AppError(502, 'ALIPAY_REFUND_HTTP_FAILED', `支付宝退款请求失败（${response.status}）`, true)
    const result = JSON.parse(text) as { alipay_trade_refund_response?: { code?: string; msg?: string; sub_msg?: string; trade_no?: string; fund_change?: string; refund_fee?: string }; sign?: string }
    const body = result.alipay_trade_refund_response
    if (!body || body.code !== '10000' || body.fund_change !== 'Y') throw new AppError(502, 'ALIPAY_REFUND_FAILED', body?.sub_msg ?? body?.msg ?? '支付宝未确认退款成功', true)
    return { tradeNo: body.trade_no, refundFee: body.refund_fee }
  }

  private signedParams(method: string, bizContent: Record<string, unknown>, extra: AlipayParams = {}) {
    const params: AlipayParams = {
      app_id: this.config.getOrThrow<string>('ALIPAY_APP_ID'),
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: this.timestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
      ...extra,
    }
    const signContent = Object.entries(params)
      .filter(([, value]) => value !== '')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    const signer = createSign('RSA-SHA256')
    signer.update(signContent, 'utf8')
    signer.end()
    params.sign = signer.sign(this.privateKey(), 'base64')
    return params
  }

  private assertConfigured() {
    if (!this.configured()) throw new AppError(503, 'ALIPAY_NOT_CONFIGURED', '支付宝电脑网站支付尚未完成生产配置', false)
  }

  private privateKey() {
    try {
      return readFileSync(this.config.getOrThrow<string>('ALIPAY_PRIVATE_KEY_PATH'), 'utf8')
    } catch {
      throw new AppError(503, 'ALIPAY_PRIVATE_KEY_UNAVAILABLE', '支付宝应用私钥文件不可读取', false)
    }
  }

  private publicKey() {
    try {
      return readFileSync(this.config.getOrThrow<string>('ALIPAY_PUBLIC_KEY_PATH'), 'utf8')
    } catch {
      throw new AppError(503, 'ALIPAY_PUBLIC_KEY_UNAVAILABLE', '支付宝公钥文件不可读取', false)
    }
  }

  private gateway() {
    return this.config.get<string>('ALIPAY_GATEWAY')?.trim() || 'https://openapi.alipay.com/gateway.do'
  }
  private timestamp() {
    const date = new Date(Date.now() + 8 * 3600000)
    return date.toISOString().slice(0, 19).replace('T', ' ')
  }
}
