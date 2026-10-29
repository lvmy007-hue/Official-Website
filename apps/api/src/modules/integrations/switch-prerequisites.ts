import type { SwitchSpec } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'

// 开启写入开关前的前置条件检查（权限清单第六节 6.4）：应用凭据已配置、授权范围含所需写权限、连接健康。
// 说明：卖家接口的“授权范围”只能核对本地保存的 grantedScopes（亚马逊授权时授予的范围）；
// 卖家后台里具体角色的写权限无法在开启前确认，若真实调用被亚马逊拒绝（403），开关会按失败规则自动关闭。

export interface PrerequisiteCheck {
  code: 'APP_CREDENTIALS' | 'CONNECTION' | 'SCOPES' | 'HEALTH'
  label: string
  passed: boolean
  /** 未通过时的处理建议 */
  hint?: string
}

export interface ConnectionFact {
  provider: string
  scopes: string[]
  healthy: boolean
}

const BAD_HEALTH = new Set(['FAILED', 'UNHEALTHY', 'EXPIRED', 'REVOKED'])
const CREDENTIAL_ENV: Record<string, readonly string[]> = {
  AMAZON_SP_API: ['AMAZON_SP_LWA_CLIENT_ID', 'AMAZON_SP_LWA_CLIENT_SECRET'],
  AMAZON_ADS_API: ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET'],
}
const PROVIDER_LABEL: Record<string, string> = { AMAZON_SP_API: '亚马逊卖家', AMAZON_ADS_API: '亚马逊广告' }

/** 读取企业已授权的连接（含授权范围与最近一次健康检查结论）。 */
export async function loadConnectionFacts(prisma: PrismaService, tenantId: string): Promise<ConnectionFact[]> {
  const rows = await prisma.platformConnection.findMany({
    where: { tenantId, state: 'AUTHORIZED', encryptedRefreshToken: { not: null } },
    select: { provider: true, grantedScopes: true, healthChecks: { orderBy: { checkedAt: 'desc' }, take: 1, select: { status: true } } },
    take: 200,
  })
  return rows.map(row => ({
    provider: row.provider,
    scopes: Array.isArray(row.grantedScopes) ? row.grantedScopes.map(String) : [],
    healthy: !BAD_HEALTH.has(row.healthChecks[0]?.status ?? ''),
  }))
}

export function checkPrerequisites(spec: SwitchSpec, facts: readonly ConnectionFact[], env: Record<string, string | undefined>): PrerequisiteCheck[] {
  const label = PROVIDER_LABEL[spec.provider] ?? spec.provider
  const own = facts.filter(item => item.provider === spec.provider)
  const withScopes = own.filter(item => spec.scopes.every(scope => item.scopes.includes(scope)))
  const credentials = (CREDENTIAL_ENV[spec.provider] ?? []).every(name => Boolean(env[name]))
  return [
    { code: 'APP_CREDENTIALS', label: `${label}应用凭据已配置`, passed: credentials, hint: credentials ? undefined : '平台尚未配置该应用的登录授权凭据，请联系平台运营' },
    { code: 'CONNECTION', label: `已完成${label}授权`, passed: own.length > 0, hint: own.length > 0 ? undefined : '请先到连接中心完成授权' },
    {
      code: 'SCOPES',
      label: `授权范围包含写权限（${spec.scopes.join('、')}）`,
      passed: withScopes.length > 0,
      hint: withScopes.length > 0 ? undefined : '授权时未授予所需范围，请到连接中心重新授权并勾选写权限',
    },
    {
      code: 'HEALTH',
      label: `${label}连接健康检查通过`,
      passed: withScopes.some(item => item.healthy),
      hint: withScopes.some(item => item.healthy) ? undefined : '连接健康检查未通过，请先到连接中心处理',
    },
  ]
}

export const prerequisitesPassed = (checks: readonly PrerequisiteCheck[]) => checks.every(item => item.passed)
