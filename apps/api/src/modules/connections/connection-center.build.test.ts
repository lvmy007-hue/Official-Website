import type { EvidenceRow } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { BLOCKED_NO_PERMISSION, buildConnectionCenter, checksOf, toneOf, type CenterInput, type ConnectionInput } from './connection-center.build'

const NOW = new Date('2026-10-20T00:00:00.000Z')
const store = (id: string, name = `店铺${id}`) => ({ id, displayName: name, sellerId: `SELLER-${id}`, legalEntityName: '星河贸易有限公司' })

function seller(id: string, over: Partial<ConnectionInput> = {}): ConnectionInput {
  const s = store(id)
  return {
    id: `conn-${id}`,
    provider: 'AMAZON_SP_API',
    state: 'AUTHORIZED',
    externalAccountId: s.sellerId,
    refreshTokenUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
    grantedScopes: ['seller', 'fba'],
    lastSuccessfulSyncAt: new Date('2026-10-19T00:00:00.000Z'),
    lastErrorCode: null,
    sellerAccountId: id,
    sellerAccount: s,
    adsProfile: null,
    health: { status: 'HEALTHY', checks: [{ key: 'token', label: '换取访问令牌', ok: true, message: null }], checkedAt: new Date('2026-10-19T12:00:00.000Z') },
    hasToken: true,
    ...over,
  }
}
const ads = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  ...seller('x'),
  id: 'conn-ads',
  provider: 'AMAZON_ADS_API',
  externalAccountId: null,
  sellerAccountId: null,
  sellerAccount: null,
  grantedScopes: ['advertising::campaign_management'],
  ...over,
})
const evidence = (storeId: string, sourceKey: string, over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  sellerAccountId: storeId,
  sourceKey,
  status: 'NORMAL',
  lastSuccessAt: NOW,
  lastErrorCode: null,
  ...over,
})

function input(over: Partial<CenterInput> = {}): CenterInput {
  return {
    now: NOW,
    connections: [],
    truncated: false,
    stores: [store('a'), store('b')],
    adsProfiles: [],
    authorizers: new Map(),
    evidence: [],
    tokenAge: { maxAgeDays: null, warnDays: 30 },
    scope: { unrestricted: true, sellerAccountIds: [] },
    canManage: true,
    legalEntities: [{ id: 'le1', name: '星河贸易有限公司' }],
    ...over,
  }
}
const itemOf = (result: ReturnType<typeof buildConnectionCenter>, id: string) => result.items.find(item => item.id === id)!

describe('连接中心组装：授权连接', () => {
  it('卖家连接：授权主体、卖家编号、授权范围、健康检查、最近成功同步、令牌更新时间都带上；没有令牌密文', () => {
    const result = buildConnectionCenter(input({ connections: [seller('a')], authorizers: new Map([['conn-a', { authorizedBy: '王经理', legalEntityName: '星河贸易有限公司' }]]) }))
    const row = itemOf(result, 'conn-a')
    expect(row).toMatchObject({
      kind: 'SELLER',
      kindLabel: '卖家接口',
      state: 'AUTHORIZED',
      stateLabel: '已授权',
      tone: 'success',
      subject: '星河贸易有限公司',
      authorizedBy: '王经理',
      accountLabel: '店铺a（SELLER-a）',
      accountId: 'SELLER-a',
      storeId: 'a',
      scopes: ['seller', 'fba'],
      hasToken: true,
      lastSuccessAt: '2026-10-19T00:00:00.000Z',
      tokenUpdatedAt: '2026-09-01T00:00:00.000Z',
      failureCode: null,
    })
    expect(row.health).toMatchObject({ status: 'HEALTHY', statusLabel: '正常', checkedAt: '2026-10-19T12:00:00.000Z' })
    expect(row.health?.checks).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(/encryptedRefreshToken|ciphertext/i)
  })

  it('令牌预计失效：没设置年龄不推算；设置后按授权时间推算', () => {
    const plain = itemOf(buildConnectionCenter(input({ connections: [seller('a')] })), 'conn-a')
    expect(plain.tokenExpiry).toMatchObject({ state: 'NOT_ESTIMATED', expiresAt: null })
    const aged = itemOf(
      buildConnectionCenter(input({ connections: [seller('a', { refreshTokenUpdatedAt: new Date('2026-01-01T00:00:00.000Z') })], tokenAge: { maxAgeDays: 300, warnDays: 60 } })),
      'conn-a',
    )
    expect(aged.tokenExpiry).toMatchObject({ state: 'SOON', daysLeft: 8 })
  })

  it('失败码与颜色：授权失效是红，限流或受限是黄，健康异常是红，已授权却没有令牌按失败处理', () => {
    const expired = itemOf(buildConnectionCenter(input({ connections: [seller('a', { lastErrorCode: 'AUTH_EXPIRED' })] })), 'conn-a')
    expect(expired).toMatchObject({ tone: 'error', failureCode: 'AUTH_EXPIRED' })
    expect(expired.failureText).toContain('重新授权')
    expect(itemOf(buildConnectionCenter(input({ connections: [seller('a', { lastErrorCode: 'THROTTLE_EXHAUSTED' })] })), 'conn-a').tone).toBe('warning')
    const unhealthy = seller('a', { health: { status: 'UNHEALTHY', checks: [], checkedAt: NOW } })
    expect(itemOf(buildConnectionCenter(input({ connections: [unhealthy] })), 'conn-a').tone).toBe('error')
    const noToken = itemOf(buildConnectionCenter(input({ connections: [seller('a', { hasToken: false })] })), 'conn-a')
    expect(noToken).toMatchObject({ tone: 'error', failureCode: 'REFRESH_TOKEN_NOT_CONFIGURED', tokenUpdatedAt: null, tokenExpiry: { state: 'NO_TOKEN' } })
    expect(noToken.actions?.healthCheck.allowed).toBe(false)
  })

  it('状态颜色：授权未完成黄、已失效红、已断开灰；授权未完成的授权主体取发起授权时选的法律主体', () => {
    expect(toneOf('AUTHORIZING', null, null)).toBe('warning')
    expect(toneOf('EXPIRED', null, null)).toBe('error')
    expect(toneOf('REVOKED', null, 'AUTH_EXPIRED')).toBe('default')
    const pending = seller('p', { state: 'AUTHORIZING', sellerAccountId: null, sellerAccount: null, externalAccountId: null, hasToken: false, health: null })
    const row = itemOf(buildConnectionCenter(input({ connections: [pending], authorizers: new Map([['conn-p', { authorizedBy: null, legalEntityName: '星河贸易有限公司' }]]) })), 'conn-p')
    expect(row).toMatchObject({ subject: '星河贸易有限公司', accountLabel: '尚未取得卖家编号', stateLabel: '授权未完成', health: null })
    expect(row.detail).toContain('10 分钟')
    expect(row.actions?.healthCheck.allowed).toBe(false)
    expect(row.actions?.reauthorize.allowed).toBe(true)
  })

  it('广告连接：账户数与未绑定数、授权主体取已绑定店铺的法律主体、没有归属店铺', () => {
    const result = buildConnectionCenter(
      input({
        connections: [ads()],
        adsProfiles: [
          { bindingStatus: 'AUTO_MATCHED', legalEntityName: '星河贸易有限公司' },
          { bindingStatus: 'UNBOUND', legalEntityName: null },
        ],
      }),
    )
    const row = itemOf(result, 'conn-ads')
    expect(row).toMatchObject({ kind: 'ADS', kindLabel: '广告接口', subject: '星河贸易有限公司', accountLabel: '2 个广告账户', storeId: null })
    expect(row.detail).toContain('未绑定店铺 1 个')
  })

  it('已断开：没有令牌、不推算失效、只能重新授权', () => {
    const row = itemOf(buildConnectionCenter(input({ connections: [seller('a', { state: 'REVOKED', hasToken: false })] })), 'conn-a')
    expect(row).toMatchObject({ stateLabel: '已断开', tone: 'default', tokenUpdatedAt: null })
    expect(row.actions).toMatchObject({ healthCheck: { allowed: false }, disconnect: { allowed: false }, reauthorize: { allowed: true } })
  })
})

describe('连接中心组装：动作权限与数据范围', () => {
  it('没有管理权限：所有动作不可用并说明原因，授权主体清单不下发', () => {
    const result = buildConnectionCenter(input({ connections: [seller('a')], canManage: false }))
    expect(result.canManage).toBe(false)
    expect(result.manageBlockedReason).toBe(BLOCKED_NO_PERMISSION)
    expect(result.legalEntities).toEqual([])
    expect(itemOf(result, 'conn-a').actions).toMatchObject({ healthCheck: { allowed: false, reason: BLOCKED_NO_PERMISSION }, disconnect: { allowed: false }, reauthorize: { allowed: false } })
  })
  it('按店铺授权的成员：自己店铺的连接可以操作，没有归属店铺的连接不能', () => {
    const scoped = { unrestricted: false, sellerAccountIds: ['a'] }
    const result = buildConnectionCenter(input({ connections: [seller('a'), seller('b'), ads({ adsProfile: { displayName: '账户', profileId: 'P1', sellerAccountId: 'a' } })], scope: scoped }))
    expect(itemOf(result, 'conn-a').actions?.disconnect.allowed).toBe(true)
    expect(itemOf(result, 'conn-b').actions?.disconnect).toMatchObject({ allowed: false, reason: expect.stringContaining('不在你的数据范围') })
    expect(itemOf(result, 'conn-ads').actions?.disconnect.allowed).toBe(true) // 广告账户绑定到了自己的店铺
    const tenantLevel = buildConnectionCenter(input({ connections: [ads()], scope: scoped }))
    expect(itemOf(tenantLevel, 'conn-ads').actions?.reauthorize).toMatchObject({ allowed: false, reason: expect.stringContaining('全部店铺') })
  })
})

describe('连接中心组装：报告权限、品牌分析资格与角色对照', () => {
  it('每个已授权店铺各一条报告权限与品牌分析资格；未授权的店铺不出现', () => {
    const result = buildConnectionCenter(input({ connections: [seller('a'), seller('b', { state: 'REVOKED', hasToken: false })] }))
    expect(result.items.filter(item => item.kind === 'REPORT_ROLE').map(item => item.storeId)).toEqual(['a'])
    expect(result.items.filter(item => item.kind === 'BRAND_ANALYTICS').map(item => item.storeId)).toEqual(['a'])
    expect(result.summary.byKind).toEqual({ SELLER: 2, ADS: 0, REPORT_ROLE: 1, BRAND_ANALYTICS: 1 })
    expect(result.roles.storeCount).toBe(1)
  })

  it('品牌分析资格：没有品牌备案是不适用，缺角色是缺少，能取到是已具备；失败码给中文说明', () => {
    const base = { connections: [seller('a')] }
    const na = itemOf(
      buildConnectionCenter(input({ ...base, evidence: [evidence('a', 'rpt.ba.search-query', { status: 'FAILED', lastErrorCode: 'BA_NO_BRAND', lastSuccessAt: null })] })),
      'BRAND_ANALYTICS:a',
    )
    expect(na).toMatchObject({ state: 'NOT_APPLICABLE', tone: 'default' }) // 没有成功也没有缺角色，只有“不适用”的证据：按不适用，其余来源尚未验证
    expect(na.detail).toContain('没有品牌备案')
    const all = [
      'rpt.ba.search-query',
      'rpt.ba.search-catalog',
      'rpt.ba.search-terms',
      'rpt.ba.market-basket',
      'rpt.ba.repeat-purchase',
      'dk.sales-traffic.date',
      'dk.sales-traffic.asin',
      'dk.sales-traffic.trends',
      'feedback.api',
    ]
    const noBrand = itemOf(
      buildConnectionCenter(input({ ...base, evidence: all.map(key => evidence('a', key, { status: 'UNAUTHORIZED', lastErrorCode: 'DK_NO_BRAND', lastSuccessAt: null })) })),
      'BRAND_ANALYTICS:a',
    )
    expect(noBrand).toMatchObject({ state: 'MISSING', stateLabel: '缺少角色', tone: 'warning', failureCode: 'DK_NO_BRAND' })
    expect(noBrand.failureText).toBeTruthy()
    const granted = itemOf(buildConnectionCenter(input({ ...base, evidence: all.map(key => evidence('a', key)) })), 'BRAND_ANALYTICS:a')
    expect(granted).toMatchObject({ state: 'AVAILABLE', stateLabel: '已具备', tone: 'success', failureCode: null })
    expect(granted.lastSuccessAt).toBe(NOW.toISOString())
  })

  it('报告权限：只看 rpt 来源（不含品牌分析报告）；统计写在说明里', () => {
    const result = buildConnectionCenter(
      input({
        connections: [seller('a')],
        evidence: [
          evidence('a', 'rpt.settlement'),
          evidence('a', 'rpt.sales-tax', { status: 'UNAUTHORIZED', lastErrorCode: 'TAX_ROLE_PENDING', lastSuccessAt: null }),
          evidence('a', 'rpt.ba.search-query'),
        ],
      }),
    )
    const row = itemOf(result, 'REPORT_ROLE:a')
    expect(row.state).toBe('PARTIAL')
    expect(row.detail).toContain('1 类能取到')
    expect(row.detail).toContain('1 类缺少权限')
    expect(row.failureCode).toBe('TAX_ROLE_PENDING')
  })

  it('角色对照：缺少角色时点名影响的页面；证据只用已授权店铺自己的记录', () => {
    const result = buildConnectionCenter(
      input({
        connections: [seller('a')],
        evidence: [evidence('a', 'support.api', { status: 'UNAUTHORIZED', lastErrorCode: 'SUP_ROLE_PENDING', lastSuccessAt: null }), evidence('zzz', 'support.api')],
      }),
    )
    const support = result.roles.modules.find(item => item.key === 'support')!
    expect(support).toMatchObject({ state: 'MISSING', stateLabel: '缺少角色' })
    expect(support.impact).toContain('“支持案件”')
    expect(result.roles.roles.find(item => item.name === 'Selling Partner Support (Restricted)')?.state).toBe('MISSING')
    expect(result.roles.basis).toContain('没有提供列出应用已获得角色的接口')
  })

  it('汇总：需要处理的数量只数红色与黄色', () => {
    const result = buildConnectionCenter(input({ connections: [seller('a'), seller('b', { lastErrorCode: 'AUTH_EXPIRED' }), ads({ state: 'REVOKED', hasToken: false })] }))
    expect(result.summary).toMatchObject({ total: result.items.length, authorized: 2, attention: 1 })
  })
})

describe('健康记录解析', () => {
  it('只认结构正确的检查项，被改坏的记录不报错', () => {
    expect(checksOf(null)).toEqual([])
    expect(checksOf('x')).toEqual([])
    expect(checksOf([{ key: 'token', label: '换取访问令牌', ok: true }, { key: 'bad', label: 'x' }, null, { key: 'api', label: '调用卖家接口', ok: 'yes', message: 3 }])).toEqual([
      { key: 'token', label: '换取访问令牌', ok: true, message: null },
      { key: 'api', label: '调用卖家接口', ok: null, message: null },
    ])
  })
})
