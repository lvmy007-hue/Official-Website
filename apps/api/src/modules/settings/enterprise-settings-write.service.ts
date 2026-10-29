import { Injectable } from '@nestjs/common'
import {
  REFRESH_SETTING_KEY,
  RETENTION_SETTING_KEY,
  SETTINGS_WRITE,
  SettingsUpdateBodySchema,
  refreshPolicyOf,
  retentionPolicyOf,
  type RefreshOverride,
  type RefreshPolicy,
  type SettingsUpdateBody,
  type SettingsUpdateResult,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { SettingsService } from './settings.service'

type Context = { tenantId: string; userId: string }
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const nothingChanged = () => appError('VALIDATION_FAILED', '和当前设置完全相同，没有需要保存的修改')

/** 把“放慢或暂停”的修改合并进现有刷新策略；DEFAULT 表示删掉这个数据域的记录，恢复系统内置频率。 */
export function mergeRefreshPolicy(current: RefreshPolicy, changes: Record<string, { mode: 'DEFAULT' | 'PAUSED' | 'EVERY'; minutes?: number }>): RefreshPolicy {
  const next: Record<string, RefreshOverride> = { ...current }
  for (const [key, change] of Object.entries(changes)) {
    if (change.mode === 'DEFAULT') delete next[key]
    else next[key] = change.mode === 'PAUSED' ? { mode: 'PAUSED' } : { mode: 'EVERY', minutes: change.minutes ?? 0 }
  }
  return next
}

// 企业设置写入（P5-10，freeze/api.md PATCH /settings）：基本信息、数据保留、刷新策略三个页签各一种修改，都要写原因、带版本号、写审计。
// 企业名称与本地时区写在企业记录上（版本号是企业记录最近更新时间的毫秒数）；数据保留与刷新策略写进企业设置项（带自己的版本号）。
// 数据口径时区与显示币种不在这里改：改了会让已汇总的日数据口径错位。
@Injectable()
export class EnterpriseSettingsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly settings: SettingsService,
    private readonly audit: AuditWriter,
  ) {}

  async update(req: RequestWithContext, rawBody: unknown): Promise<SettingsUpdateResult> {
    const context = await this.context.authorize(req, SETTINGS_WRITE)
    const body = SettingsUpdateBodySchema.parse(rawBody)
    if (body.section === 'basic') return this.updateBasic(req, context, body)
    if (body.section === 'retention') return this.updateRetention(req, context, body)
    return this.updateRefresh(req, context, body)
  }

  private updateBasic(req: RequestWithContext, context: Context, body: Extract<SettingsUpdateBody, { section: 'basic' }>): Promise<SettingsUpdateResult> {
    return this.prisma.$transaction(async tx => {
      const current = await tx.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { name: true, localTimezone: true, updatedAt: true } })
      const before = { name: current.name, localTimezone: current.localTimezone }
      const after = { name: body.name ?? current.name, localTimezone: body.localTimezone ?? current.localTimezone }
      if (sameJson(before, after)) throw nothingChanged()
      const result = await tx.tenant.updateMany({ where: { id: context.tenantId, updatedAt: new Date(body.version) }, data: after })
      if (result.count === 0) throw appError('CONFLICT', '企业资料已被他人修改，请刷新后查看最新内容再决定是否覆盖', { details: { expectedVersion: body.version } })
      await this.audit.record(req, { action: 'TENANT_PROFILE_UPDATED', resourceType: 'Tenant', resourceId: context.tenantId, before, after, reason: body.reason }, { client: tx })
      const fresh = await tx.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { updatedAt: true } })
      return { section: 'basic' as const, version: fresh.updatedAt.getTime() }
    })
  }

  private updateRetention(req: RequestWithContext, context: Context, body: Extract<SettingsUpdateBody, { section: 'retention' }>): Promise<SettingsUpdateResult> {
    return this.prisma.$transaction(async tx => {
      const current = await tx.tenantSetting.findFirst({ where: { tenantId: context.tenantId, sellerAccountId: null, key: RETENTION_SETTING_KEY }, select: { valueJson: true } })
      const before = retentionPolicyOf(current?.valueJson)
      if (sameJson(before, body.values)) throw nothingChanged()
      const saved = await this.settings.set(tx, context.tenantId, context.userId, RETENTION_SETTING_KEY, body.values, body.version)
      await this.record(req, tx, RETENTION_SETTING_KEY, before, saved.value, body.reason)
      return { section: 'retention' as const, version: saved.version }
    })
  }

  private updateRefresh(req: RequestWithContext, context: Context, body: Extract<SettingsUpdateBody, { section: 'refresh' }>): Promise<SettingsUpdateResult> {
    return this.prisma.$transaction(async tx => {
      const current = await tx.tenantSetting.findFirst({ where: { tenantId: context.tenantId, sellerAccountId: null, key: REFRESH_SETTING_KEY }, select: { valueJson: true } })
      const before = refreshPolicyOf(current?.valueJson)
      const next = mergeRefreshPolicy(before, body.changes)
      if (sameJson(before, next)) throw nothingChanged()
      const saved = await this.settings.set(tx, context.tenantId, context.userId, REFRESH_SETTING_KEY, next, body.version)
      await this.record(req, tx, REFRESH_SETTING_KEY, before, saved.value, body.reason)
      return { section: 'refresh' as const, version: saved.version }
    })
  }

  private record(req: RequestWithContext, tx: Prisma.TransactionClient, key: string, before: unknown, after: unknown, reason: string) {
    return this.audit.record(req, { action: 'TENANT_SETTING_UPDATED', resourceType: 'TenantSetting', resourceId: key, before: { value: before }, after: { value: after }, reason }, { client: tx })
  }
}
