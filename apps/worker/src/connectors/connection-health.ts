import { connectionHealthCodeOf, healthStatusOfCode, type HealthCheckItem, type HealthStatus } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { TokenOpener } from '../crypto/secrets'
import { AmazonAdsApiClient } from './amazon-ads-api'
import { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError, type RequestGuard } from './http-error'

// 连接健康检查（P5-04，09 章 9.6）：令牌只有后台任务能解密，所以“健康检查”按钮与每日定时都落在这个任务里。
// 卖家接口：调一次“参与的站点”（同时验证令牌换取、接口调用、美国站参与）；广告接口：调一次“广告档案列表”。
// 只读、只调一次；结果写入连接的健康记录与“最近检查时间、最近错误码”。失败不改连接状态（状态由授权流程与预警决定），也不写数据新鲜度。

export const US_MARKETPLACE_ID = 'ATVPDKIKX0DER'

export interface ConnectionHealthDeps {
  prisma: PrismaClient
  logger: Logger
  secrets: TokenOpener
  guardFor?: (tenantId: string, connectionId: string) => RequestGuard
}
export interface HealthConnectionRow {
  tenantId: string
  connection: { id: string; provider: string; encryptedRefreshToken: string | null; sellerAccountId: string | null }
}
export interface HealthOutcome {
  status: HealthStatus
  code: string | null
  checks: HealthCheckItem[]
}

/** 亚马逊“参与的站点”响应里有没有美国站（isParticipating 不是 false）。 */
export function usParticipation(response: Record<string, unknown>): 'YES' | 'NO' {
  const payload = (response.payload ?? response) as unknown
  const rows = Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : []
  const found = rows.some(item => {
    const marketplace = (item.marketplace ?? {}) as Record<string, unknown>
    const participation = (item.participation ?? {}) as Record<string, unknown>
    return marketplace.id === US_MARKETPLACE_ID && participation.isParticipating !== false
  })
  return found ? 'YES' : 'NO'
}

const item = (key: HealthCheckItem['key'], label: string, ok: boolean | null, message: string | null = null): HealthCheckItem => ({ key, label, ok, message })
const API_LABEL = { SELLER: '调用卖家接口', ADS: '调用广告接口' } as const

/** 一次调用失败后的三项结果：令牌换取失败＝后面的调用没有进行；接口拒绝＝令牌是好的。 */
function failureChecks(error: unknown, kind: keyof typeof API_LABEL, code: string): HealthCheckItem[] {
  const message = error instanceof Error ? error.message : code
  // 令牌换取：接口层报错说明令牌已换到；换取接口报错或缺少配置与刷新令牌说明没换到；其余（网络中断、签名凭据缺失）无法判断
  const tokenOk: boolean | null = error instanceof UpstreamHttpError ? error.source === 'api' : /REFRESH_TOKEN|LWA_CONFIG|CLIENT_ID_MISSING/.test(message) ? false : null
  const checks = [item('token', '换取访问令牌', tokenOk, tokenOk === false ? code : null), item('api', API_LABEL[kind], tokenOk === false ? null : false, tokenOk === false ? null : code)]
  if (kind === 'SELLER') checks.push(item('marketplace', '参与美国站', null))
  return checks
}

async function checkSeller(client: AmazonSpApiClient): Promise<HealthOutcome> {
  let response: Record<string, unknown>
  try {
    response = await client.getMarketplaceParticipations()
  } catch (error) {
    const code = connectionHealthCodeOf(
      error instanceof UpstreamHttpError ? { source: error.source, status: error.status, message: error.message } : { message: error instanceof Error ? error.message : '' },
    )
    return { status: healthStatusOfCode(code), code, checks: failureChecks(error, 'SELLER', code) }
  }
  const us = usParticipation(response) === 'YES'
  const code = us ? null : 'SLR_NOT_US'
  return {
    status: healthStatusOfCode(code),
    code,
    checks: [item('token', '换取访问令牌', true), item('api', API_LABEL.SELLER, true), item('marketplace', '参与美国站', us, us ? null : code)],
  }
}

async function checkAds(client: AmazonAdsApiClient): Promise<HealthOutcome> {
  try {
    await client.getProfiles()
  } catch (error) {
    const code = connectionHealthCodeOf(
      error instanceof UpstreamHttpError ? { source: error.source, status: error.status, message: error.message } : { message: error instanceof Error ? error.message : '' },
    )
    return { status: healthStatusOfCode(code), code, checks: failureChecks(error, 'ADS', code) }
  }
  return { status: 'HEALTHY', code: null, checks: [item('token', '换取访问令牌', true), item('api', API_LABEL.ADS, true)] }
}

/** 执行一次健康检查并落库；接口调用的失败是检查结果而不是任务失败（返回结果，不抛错）。 */
export async function processConnectionHealth(deps: ConnectionHealthDeps, row: HealthConnectionRow, requestId: string): Promise<HealthOutcome> {
  const { connection } = row
  const guard = deps.guardFor?.(row.tenantId, connection.id)
  let outcome: HealthOutcome
  if (!connection.encryptedRefreshToken) {
    outcome = {
      status: 'UNHEALTHY',
      code: 'REFRESH_TOKEN_NOT_CONFIGURED',
      checks: [item('token', '换取访问令牌', false, 'REFRESH_TOKEN_NOT_CONFIGURED'), item('api', connection.provider === 'AMAZON_ADS_API' ? API_LABEL.ADS : API_LABEL.SELLER, null)],
    }
  } else if (connection.provider === 'AMAZON_ADS_API') {
    outcome = await checkAds(new AmazonAdsApiClient(connection, deps.secrets, guard))
  } else {
    outcome = await checkSeller(new AmazonSpApiClient(connection, deps.secrets, guard))
  }
  const now = new Date()
  await deps.prisma.connectionHealth.create({ data: { connectionId: connection.id, status: outcome.status, checks: outcome.checks as unknown as Prisma.InputJsonValue, requestId, checkedAt: now } })
  await deps.prisma.platformConnection.update({ where: { id: connection.id }, data: { lastHealthCheckedAt: now, lastErrorCode: outcome.code } })
  deps.logger.info({ connectionId: connection.id, status: outcome.status, code: outcome.code, requestId }, 'connection health checked')
  return outcome
}
