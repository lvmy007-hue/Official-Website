import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS } from '@nova/api-contracts'
import { planInitialSync } from './initial-sync.service'
import { appPublicUrl, generateInviteToken, hashInviteToken, inviteLink, isWellFormedInviteToken } from './invitation-token'
import { currentStep, initialOnboardingState, isOnboardingComplete, parseOnboardingState } from './onboarding-state'
import { quotaUsage, type QuotaUsageClient } from './quota-usage'
import { supportGrantStatus } from './support-grant.service'

describe('邀请令牌', () => {
  it('随机且足够长，库内只存哈希，格式校验能挡住乱填', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    expect(a).not.toBe(b)
    expect(isWellFormedInviteToken(a)).toBe(true)
    expect(isWellFormedInviteToken('short')).toBe(false)
    expect(isWellFormedInviteToken(`${a}!`)).toBe(false)
    expect(hashInviteToken(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashInviteToken(a)).not.toContain(a)
  })

  it('邀请链接指向站点的邀请页；生产环境缺少站点地址时不生成', () => {
    expect(inviteLink('https://erp.example.com', 'abc')).toBe('https://erp.example.com/invite/abc')
    expect(appPublicUrl({ APP_MODE: 'production' })).toBeNull()
    expect(appPublicUrl({ APP_MODE: 'production', APP_PUBLIC_URL: 'https://erp.example.com/' })).toBe('https://erp.example.com')
    expect(appPublicUrl({ APP_MODE: 'development' })).toBe('http://localhost:5173')
  })
})
describe('初始化向导的状态', () => {
  it('8 步，必填 6 步；选填步骤跳过也算处理完，必填步骤必须完成', () => {
    expect(ONBOARDING_STEPS).toHaveLength(8)
    expect(ONBOARDING_STEPS.filter(step => step.required)).toHaveLength(6)
    const state = initialOnboardingState()
    expect(currentStep(state)).toBe('PROFILE')
    expect(isOnboardingComplete(state)).toBe(false)
    for (const step of ONBOARDING_STEPS) state.steps[step.key] = { state: step.required ? 'COMPLETED' : 'SKIPPED' }
    expect(currentStep(state)).toBe('DONE')
    expect(isOnboardingComplete(state)).toBe(true)
    state.steps.SELLER_AUTH = { state: 'SKIPPED' }
    expect(isOnboardingComplete(state)).toBe(false)
  })

  it('读取保存的状态时补齐缺失的步骤，忽略非法内容', () => {
    const state = parseOnboardingState({ steps: { PROFILE: { state: 'COMPLETED', data: { name: 'x' } }, ENTITIES: { state: 'BROKEN' } } })
    expect(state.steps.PROFILE.state).toBe('COMPLETED')
    expect(state.steps.ENTITIES.state).toBe('PENDING')
    expect(currentStep(state)).toBe('ENTITIES')
    expect(parseOnboardingState(null).steps.WRITE_SWITCHES.state).toBe('PENDING')
  })
})

describe('首次同步计划（历史回补分段）', () => {
  const now = new Date('2026-10-21T00:00:00.000Z')
  const inputs = { spConnectionIds: ['sp-1'], adsConnectionId: 'ads-1', adsProfiles: [{ id: 'profile-1' }] }

  it('财务每段不超过 180 天、订单 90 天、广告 120 天，库存只有一次；730 天按段数展开', () => {
    const plan = planInitialSync(now, { domains: ['ORDERS', 'INVENTORY', 'FINANCE', 'ADS'], backfillDays: 730 }, inputs)
    const count = (type: string) => plan.filter(item => item.type === type).length
    expect(count('FBA_INVENTORY')).toBe(1)
    expect(count('FBA_ORDERS')).toBe(Math.ceil(730 / 90))
    expect(count('FBA_FINANCE')).toBe(Math.ceil(730 / 180))
    expect(count('ADS_REPORT_CREATE')).toBe(Math.ceil(730 / 120) * 2)
    for (const item of plan.filter(entry => entry.segment)) {
      const days = (Date.parse(item.segment!.to) - Date.parse(item.segment!.from)) / 86_400_000
      const limit = item.type === 'FBA_FINANCE' ? 180 : item.type === 'FBA_ORDERS' ? 90 : 120
      expect(days).toBeLessThanOrEqual(limit)
    }
  })

  it('最近的一段排在最前，分段首尾相接、不重叠、总长等于所选天数', () => {
    const plan = planInitialSync(now, { domains: ['FINANCE'], backfillDays: 400 }, inputs).map(item => item.segment!)
    expect(plan[0].to).toBe(now.toISOString())
    for (let index = 1; index < plan.length; index += 1) expect(plan[index].to).toBe(plan[index - 1].from)
    expect((Date.parse(plan[0].to) - Date.parse(plan[plan.length - 1].from)) / 86_400_000).toBe(400)
  })

  it('只回补所选数据域；没有广告连接时不计划广告报表', () => {
    expect(planInitialSync(now, { domains: ['INVENTORY'], backfillDays: 30 }, inputs).map(item => item.type)).toEqual(['FBA_INVENTORY'])
    expect(planInitialSync(now, { domains: ['ADS'], backfillDays: 30 }, { ...inputs, adsConnectionId: null })).toEqual([])
  })
})

describe('配额占用', () => {
  const client = (overrides: { limits?: Array<{ quotaKey: string; limitValue: number }>; stores?: number; members?: number; backfillDays?: number } = {}): QuotaUsageClient => ({
    sellerAccount: { count: async () => overrides.stores ?? 2 },
    membership: { count: async () => overrides.members ?? 3 },
    tenantOnboarding: {
      findUnique: async () => ({ stepStateJson: { steps: { SYNC_SCOPE: { state: 'COMPLETED', data: { domains: ['ORDERS'], backfillDays: overrides.backfillDays ?? 365 } } } } }),
    },
    tenantQuota: { findMany: async () => overrides.limits ?? [] },
  })

  it('没有设置配额即不限；超出只标记，不阻断', async () => {
    const free = await quotaUsage(client(), 't1')
    expect(free.every(item => item.limit === null && !item.exceeded)).toBe(true)
    const limited = await quotaUsage(
      client({
        limits: [
          { quotaKey: 'stores', limitValue: 1 },
          { quotaKey: 'members', limitValue: 10 },
        ],
      }),
      't1',
    )
    expect(limited.find(item => item.key === 'stores')).toMatchObject({ used: 2, limit: 1, exceeded: true })
    expect(limited.find(item => item.key === 'members')).toMatchObject({ used: 3, limit: 10, exceeded: false })
    expect(limited.find(item => item.key === 'backfillDays')?.used).toBe(365)
  })
})

describe('支持访问授权状态', () => {
  const now = new Date('2026-10-21T00:00:00.000Z')
  const row = (overrides: Partial<{ revokedAt: Date | null; expiresAt: Date; claimedAt: Date | null }> = {}) => ({
    revokedAt: null,
    expiresAt: new Date(now.getTime() + 3600_000),
    claimedAt: null,
    ...overrides,
  })
  it('撤销优先于到期，到期优先于已领取', () => {
    expect(supportGrantStatus(row(), now)).toBe('AVAILABLE')
    expect(supportGrantStatus(row({ claimedAt: now }), now)).toBe('IN_USE')
    expect(supportGrantStatus(row({ expiresAt: new Date(now.getTime() - 1) }), now)).toBe('EXPIRED')
    expect(supportGrantStatus(row({ revokedAt: now, expiresAt: new Date(now.getTime() - 1) }), now)).toBe('REVOKED')
  })
})
