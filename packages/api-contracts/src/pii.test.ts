import { describe, expect, it } from 'vitest'
import { PII_REVEAL_FIELDS, PII_REVEAL_FIELDS_MAX, PII_REASON_MAX, detectPiiKinds, kindsFromText, kindsToText, maskFreeText } from './pii'
import { PiiRevealBodySchema } from './pii-query'

// 个人信息识别与掩码、查看明文的请求校验（P6-14）。

describe('自由文本里的个人信息识别', () => {
  const kinds = (text: string) => detectPiiKinds(text)

  it('电话：中国大陆手机号、北美号码、国际号码', () => {
    expect(kinds('请打 13912345678')).toEqual(['PHONE'])
    expect(kinds('call me 415-555-0132')).toEqual(['PHONE'])
    expect(kinds('call (415) 555-0132 please')).toEqual(['PHONE'])
    expect(kinds('+1 415 555 0132')).toEqual(['PHONE'])
    expect(kinds('+44 20 7946 0958')).toEqual(['PHONE'])
    expect(kinds('+86 139 1234 5678')).toEqual(['PHONE'])
  })

  it('邮箱', () => {
    expect(kinds('mail alice.b+x@example.co.uk now')).toEqual(['EMAIL'])
  })

  it('地址：英文街道、信箱、州加邮编、中文省市区路', () => {
    expect(kinds('ship to 77 Pii Lane')).toEqual(['ADDRESS'])
    expect(kinds('1600 Amphitheatre Pkwy, Unit 4')).toEqual(['ADDRESS'])
    expect(kinds('P.O. Box 1234')).toEqual(['ADDRESS'])
    expect(kinds('Seattle WA 98101')).toEqual(['ADDRESS'])
    expect(kinds('广东省深圳市南山区科技路88号')).toEqual(['ADDRESS'])
  })

  it('不误伤：订单号、ASIN、FBA 货件编号、物流单号、数量和普通句子', () => {
    for (const text of [
      'order 111-2222222-3333333 returned',
      'ASIN B0TESTASIN1 SKU-1',
      'FBA15ABCDE1F shipment',
      'tracking 1Z999AA10123456784',
      'received 2 items for Dr',
      'refund 59.90 USD on 2026-10-18',
      '包装破损，商品有划痕',
      'quantity 12 pcs, 3 boxes',
      '',
    ]) {
      expect(kinds(text), text).toEqual([])
    }
    expect(kinds(null)).toEqual([])
    expect(kinds(undefined)).toEqual([])
  })

  it('掩码：每一类换成固定文字；原文里的其他内容保持不变；多类并存', () => {
    expect(maskFreeText('Please ship to 77 Pii Lane or call 13987654321 / a@b.com')).toEqual({
      text: 'Please ship to [地址已隐藏] or call [电话已隐藏] / [邮箱已隐藏]',
      kinds: ['PHONE', 'EMAIL', 'ADDRESS'],
      masked: true,
    })
    expect(maskFreeText('商品有划痕，订单 111-2222222-3333333')).toEqual({ text: '商品有划痕，订单 111-2222222-3333333', kinds: [], masked: false })
    expect(maskFreeText(null)).toEqual({ text: '', kinds: [], masked: false })
  })

  it('掩码后的文字里再也识别不出个人信息；重复掩码结果不变', () => {
    const once = maskFreeText('a@b.com 13987654321 77 Pii Lane').text
    expect(detectPiiKinds(once)).toEqual([])
    expect(maskFreeText(once).text).toBe(once)
  })

  it('类别与文本互转：只认已知类别，顺序固定', () => {
    expect(kindsToText(['PHONE', 'EMAIL'])).toBe('PHONE,EMAIL')
    expect(kindsFromText('ADDRESS, PHONE,BOGUS')).toEqual(['PHONE', 'ADDRESS'])
    expect(kindsFromText(null)).toEqual([])
  })
})

describe('查看明文的请求校验', () => {
  const valid = { objectType: 'ORDER', objectId: '111-2222222-3333333', fields: ['buyerName', 'city'], reason: '客服处理退款咨询' }

  it('合法请求通过，理由与编号会去掉首尾空白', () => {
    const parsed = PiiRevealBodySchema.parse({ ...valid, objectId: ' o1 ', reason: '  核对地址  ' })
    expect(parsed).toMatchObject({ objectId: 'o1', reason: '核对地址' })
  })

  it('理由必填：缺失、空白、一个字都不行；超长不行', () => {
    for (const reason of [undefined, '', '   ', '好']) expect(PiiRevealBodySchema.safeParse({ ...valid, reason }).success, String(reason)).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, reason: '好'.repeat(PII_REASON_MAX + 1) }).success).toBe(false)
  })

  it('对象类型、编号写法、字段数量与归属都要对', () => {
    expect(PiiRevealBodySchema.safeParse({ ...valid, objectType: 'USER' }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, objectId: 'a/b' }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, fields: [] }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, fields: ['buyerName', 'buyerName'] }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, objectType: 'RETURN', fields: ['buyerName'] }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, fields: Array.from({ length: PII_REVEAL_FIELDS_MAX + 1 }, (_, i) => `f${i}`) }).success).toBe(false)
    expect(PiiRevealBodySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })

  it('每种对象的字段表都能通过自己的校验', () => {
    for (const [objectType, fields] of Object.entries(PII_REVEAL_FIELDS)) {
      expect(PiiRevealBodySchema.safeParse({ objectType, objectId: 'x1', fields, reason: '核对信息' }).success, objectType).toBe(true)
    }
  })
})
