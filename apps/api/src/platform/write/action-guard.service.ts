import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import { permissionDeniedMessage, type ApiErrorBody, type ErrorCode } from '@nova/api-contracts'
import { ApiContext, appError } from '../http'
import { PrismaService } from '../prisma.service'

// 动作守卫（03 章 3.2）：每个动作依次判断 权限 → 连接 → 写入开关 → 数据条件，任一不满足即停止并说明原因。
// 页面据此禁用按钮并显示原因（有权限者显示“前往开启 / 前往处理”）；服务端执行前用同一套规则再判断一次，页面状态不作为依据。

export type GuardStep = 'PERMISSION' | 'CONNECTION' | 'SWITCH' | 'DATA'
export type ConnectionProviderKey = 'AMAZON_SP_API' | 'AMAZON_ADS_API'

export interface DataCondition {
  code: string
  message: string
  check: () => boolean | Promise<boolean>
  /** 有权限处理的人，点击后前往处理的页面路径 */
  remedyPath?: string
}

export interface ActionSpec {
  permission: string
  /** 动作需要的亚马逊连接；指定店铺时要求该店铺的连接可用 */
  connection?: { provider: ConnectionProviderKey; sellerAccountId?: string }
  /** 写入开关键（freeze/permissions.md 第六节）；仅亚马逊写入类动作需要 */
  switchKey?: string
  conditions?: DataCondition[]
}

export interface GuardRemedy {
  kind: 'GO_ENABLE' | 'GO_CONNECT' | 'GO_HANDLE'
  label: string
  path: string
}

export interface GuardBlock {
  step: GuardStep
  code: ErrorCode
  message: string
  /** 仅当前成员有权限处理时才有 */
  remedy?: GuardRemedy
}

export interface GuardDecision {
  allowed: boolean
  passed: GuardStep[]
  blockedBy?: GuardBlock
}

/**
 * 写入开关的读取接口。写入开关的数据模型与管理页在 P1-28 落地，此处先固定接口：
 * 默认实现（ReadOnlySwitches）表示“全部只读”，与 12 章“写入开关默认全部只读”一致；
 * P1-28 用读取 IntegrationSwitch 表的实现替换。
 */
export abstract class IntegrationSwitchPort {
  abstract status(tenantId: string, switchKey: string, sellerAccountId?: string): Promise<{ enabled: boolean; reason?: string }>
}

@Injectable()
export class ReadOnlySwitches extends IntegrationSwitchPort {
  async status() {
    return { enabled: false, reason: '写入开关尚未开启（默认全部只读）' }
  }
}

const BAD_HEALTH = new Set(['FAILED', 'UNHEALTHY', 'EXPIRED', 'REVOKED'])
const SWITCH_ADMIN_PERMISSION = 'settings.integration.write'
const CONNECTION_ADMIN_PERMISSION = 'connection.manage'

@Injectable()
export class ActionGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly switches: IntegrationSwitchPort,
  ) {}

  async evaluate(context: ApiContext, spec: ActionSpec): Promise<GuardDecision> {
    const passed: GuardStep[] = []
    const fail = (block: GuardBlock): GuardDecision => ({ allowed: false, passed, blockedBy: block })

    if (!hasPermission(context.permissions, spec.permission)) {
      return fail({ step: 'PERMISSION', code: 'TENANT_ACCESS_DENIED', message: permissionDeniedMessage(spec.permission) })
    }
    passed.push('PERMISSION')

    if (spec.connection) {
      const problem = await this.connectionProblem(context.tenantId, spec.connection)
      if (problem) {
        const canFix = hasPermission(context.permissions, CONNECTION_ADMIN_PERMISSION)
        return fail({ step: 'CONNECTION', code: 'CONNECTION_UNAVAILABLE', message: problem, ...(canFix ? { remedy: { kind: 'GO_CONNECT', label: '前往连接中心', path: '/app/connections' } } : {}) })
      }
      passed.push('CONNECTION')
    }

    if (spec.switchKey) {
      const status = await this.switches.status(context.tenantId, spec.switchKey, spec.connection?.sellerAccountId)
      if (!status.enabled) {
        const canFix = hasPermission(context.permissions, SWITCH_ADMIN_PERMISSION)
        return fail({
          step: 'SWITCH',
          code: 'WRITE_SWITCH_OFF',
          message: status.reason ?? '该类亚马逊写入的开关未开启',
          ...(canFix ? { remedy: { kind: 'GO_ENABLE', label: '前往开启', path: '/app/settings/integrations' } } : {}),
        })
      }
      passed.push('SWITCH')
    }

    for (const condition of spec.conditions ?? []) {
      if (!(await condition.check())) {
        return fail({
          step: 'DATA',
          code: 'DATA_CONDITION_FAILED',
          message: condition.message,
          ...(condition.remedyPath ? { remedy: { kind: 'GO_HANDLE', label: '前往处理', path: condition.remedyPath } } : {}),
        })
      }
    }
    if ((spec.conditions ?? []).length > 0) passed.push('DATA')

    return { allowed: true, passed }
  }

  /** 服务端执行前的最终判断：不满足即抛出统一错误（权限不足为 403，其余为 409），并带上失败环节。 */
  async assert(context: ApiContext, spec: ActionSpec): Promise<void> {
    const decision = await this.evaluate(context, spec)
    if (decision.allowed || !decision.blockedBy) return
    const block = decision.blockedBy
    const details: ApiErrorBody['details'] = { step: block.step, ...(block.remedy ? { remedyPath: block.remedy.path } : {}) }
    throw appError(block.code, block.message, { details })
  }

  private async connectionProblem(tenantId: string, requirement: NonNullable<ActionSpec['connection']>): Promise<string | null> {
    const connection = await this.prisma.platformConnection.findFirst({
      where: {
        tenantId,
        provider: requirement.provider,
        state: 'AUTHORIZED',
        encryptedRefreshToken: { not: null },
        ...(requirement.sellerAccountId ? { sellerAccountId: requirement.sellerAccountId } : {}),
      },
      select: { lastErrorCode: true, healthChecks: { orderBy: { checkedAt: 'desc' }, take: 1, select: { status: true } } },
    })
    const label = requirement.provider === 'AMAZON_ADS_API' ? '亚马逊广告' : '亚马逊卖家'
    if (!connection) return `尚未完成${label}授权，或授权已失效`
    const health = connection.healthChecks[0]?.status
    if (health && BAD_HEALTH.has(health)) return `${label}连接健康检查未通过，请先到连接中心处理`
    return null
  }
}
