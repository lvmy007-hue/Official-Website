import { EnvMasterKeyProvider, Keyring, MemoryKeyStore } from '@nova/crypto'
import { describe, expect, it, vi } from 'vitest'
import { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import { parseOrder } from '../importers/orders/v2026-parse'
import { writeOrder } from '../importers/orders/v2026-write'
import { WorkerSecrets } from './secrets'

const ROOT = Buffer.from('9'.repeat(64), 'hex')
const secrets = () => new WorkerSecrets(new Keyring({ store: new MemoryKeyStore(), master: new EnvMasterKeyProvider(new Map([['env-1', ROOT]]), 'env-1') }))

describe('后台任务的应用层加密', () => {
  it('买家信息密文：新格式、不含明文，可被密钥环解开；令牌用途的密文不能当作买家信息打开', async () => {
    const box = secrets()
    await box.prepare()
    const sealed = await box.sealBuyerPii(JSON.stringify({ buyerEmail: 'a@b.com' }))
    expect(sealed.startsWith('nk2.')).toBe(true)
    expect(sealed).not.toContain('a@b.com')
    await expect(box.openAmazonToken(sealed)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
  })

  it('同步订单时买家信息写入的是新格式密文，且明文不出现在任何写入参数里', async () => {
    const box = secrets()
    await box.prepare()
    const upsert = vi.fn().mockImplementation(async (args: { create: Record<string, unknown> }) => ({ id: 'order-1', ...args.create }))
    const noop = { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) }
    const prisma = { order: { findUnique: vi.fn().mockResolvedValue(null), upsert }, orderStatusHistory: noop, orderItem: noop, orderCharge: noop, orderPackage: noop, orderCancellation: noop }
    const purchase = new Date(Date.now() - 86_400_000).toISOString()
    const parsed = parseOrder({
      orderId: 'o1',
      createdTime: purchase,
      lastUpdatedTime: purchase,
      fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
      proceeds: { grandTotal: { amount: '10.00', currencyCode: 'USD' } },
      buyer: { buyerEmail: 'buyer@example.com' },
      recipient: { deliveryAddress: { name: 'Zhang', city: 'Austin' } },
    })
    if ('skipped' in parsed) throw new Error('订单不应被跳过')
    await writeOrder({ prisma, logger: console, secrets: box } as never, { tenantId: 't1', sellerAccountId: 's1' }, parsed)
    const stored = upsert.mock.calls[0][0].create.piiCiphertext as string
    expect(stored.startsWith('nk2.')).toBe(true)
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('buyer@example.com')
  })

  it('连接器客户端换取访问令牌时，用注入的解密能力取得刷新令牌（明文只发给亚马逊）', async () => {
    const box = secrets()
    const cipher = await (box as unknown as { keyring: Keyring }).keyring.seal('amazon-token', 'Atzr|plain-refresh')
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body))
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    process.env.AMAZON_ADS_CLIENT_ID = 'cid'
    process.env.AMAZON_ADS_CLIENT_SECRET = 'csecret'
    try {
      const ads = new AmazonAdsApiClient({ encryptedRefreshToken: cipher.ciphertext }, box)
      await (ads as unknown as { lwaToken(): Promise<string> }).lwaToken()
      expect(new URLSearchParams(bodies[0]).get('refresh_token')).toBe('Atzr|plain-refresh')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
