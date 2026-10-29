import { Injectable } from '@nestjs/common'
import { ReasonBodySchema, SWITCH_CATALOG, SwitchBatchBodySchema, SwitchEnableBodySchema, emergencyDisableReason, switchSpecOf } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { NotifyService } from '../notifications'
import { checkPrerequisites, loadConnectionFacts } from './switch-prerequisites'

const MANAGE = 'settings.integration.write'
type Tx = Prisma.TransactionClient
type Row = { id: string; enabled: boolean; reason: string | null; version: number }

const snapshot = (row: Row | null | undefined) => ({ enabled: Boolean(row?.enabled), reason: row?.reason ?? null, version: row?.version ?? 0 })

// 写入开关的变更（P1-28-1）：开启要权限、再次验证、前置条件、原因与二次确认；关闭只需权限与原因。
// 每次变更：开关行、变更记录、审计、管理员通知在同一个事务里提交。
@Injectable()
export class SwitchActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly notify: NotifyService,
  ) {}

  async enable(req: RequestWithContext, key: string, rawBody: unknown) {
    const context = await this.context.authorize(req, MANAGE)
    const spec = switchSpecOf(key)
    if (!spec) throw appError('RESOURCE_NOT_FOUND', '写入开关不存在')
    const body = SwitchEnableBodySchema.parse(rawBody)
    const forced = emergencyDisableReason(key, process.env)
    if (forced) throw appError('WRITE_SWITCH_OFF', forced)
    const failed = checkPrerequisites(spec, await loadConnectionFacts(this.prisma, context.tenantId), process.env).filter(item => !item.passed)
    if (failed.length > 0) {
      throw appError('DATA_CONDITION_FAILED', `前置条件未满足：${failed.map(item => item.label).join('；')}`, { details: { step: 'DATA', remedyPath: '/app/connections' } })
    }
    return this.prisma.$transaction(async tx => {
      const before = await tx.integrationSwitch.findFirst({ where: { tenantId: context.tenantId, switchKey: key, sellerAccountId: null } })
      if (before?.enabled) throw appError('CONFLICT', '该开关已经是开启状态，请刷新页面')
      const now = new Date()
      const data = { enabled: true, enabledAt: now, enabledBy: context.userId, reason: body.reason, autoDisabledReason: null, consecutiveFailures: 0 }
      const row = before
        ? await tx.integrationSwitch.update({ where: { id: before.id }, data: { ...data, version: { increment: 1 } } })
        : await tx.integrationSwitch.create({ data: { tenantId: context.tenantId, switchKey: key, ...data } })
      await this.log(tx, context.tenantId, key, 'ENABLED', body.reason, context.userId, before, row)
      await this.audit.record(
        req,
        { action: 'WRITE_SWITCH_ENABLED', resourceType: 'IntegrationSwitch', resourceId: row.id, before: snapshot(before), after: snapshot(row), reason: body.reason, detail: { switchKey: key } },
        { client: tx },
      )
      await this.notify.toHolders(
        context.tenantId,
        MANAGE,
        { kind: 'WRITE_SWITCH_CHANGED', title: `已开启写入：${spec.label}`, body: `开启原因：${body.reason}`, link: '/app/settings/integrations', severity: 'WARNING' },
        { client: tx },
      )
      return { key, enabled: true, version: row.version }
    })
  }

  async disable(req: RequestWithContext, key: string, rawBody: unknown) {
    const context = await this.context.authorize(req, MANAGE)
    const spec = switchSpecOf(key)
    if (!spec) throw appError('RESOURCE_NOT_FOUND', '写入开关不存在')
    const { reason } = ReasonBodySchema.parse(rawBody)
    return this.prisma.$transaction(async tx => {
      const before = await tx.integrationSwitch.findFirst({ where: { tenantId: context.tenantId, switchKey: key, sellerAccountId: null } })
      if (!before?.enabled) throw appError('CONFLICT', '该开关已经是关闭状态，请刷新页面')
      const row = await this.turnOff(tx, before.id, null)
      await this.log(tx, context.tenantId, key, 'DISABLED', reason, context.userId, before, row)
      await this.audit.record(
        req,
        { action: 'WRITE_SWITCH_DISABLED', resourceType: 'IntegrationSwitch', resourceId: row.id, before: snapshot(before), after: snapshot(row), reason, detail: { switchKey: key } },
        { client: tx },
      )
      await this.notify.toHolders(
        context.tenantId,
        MANAGE,
        { kind: 'WRITE_SWITCH_CHANGED', title: `已关闭写入：${spec.label}`, body: `关闭原因：${reason}`, link: '/app/settings/integrations' },
        { client: tx },
      )
      return { key, enabled: false, version: row.version }
    })
  }

  /** PATCH：批量关闭（开启必须逐项走开启流程，契约已限制 enabled 只能为 false）。 */
  async batchDisable(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, MANAGE)
    const body = SwitchBatchBodySchema.parse(rawBody)
    return this.closeMany(req, context, { keys: body.keys, reason: body.reason, action: 'DISABLED', auditAction: 'WRITE_SWITCH_BATCH_DISABLED', title: '已批量关闭写入开关' })
  }

  /** 一键全部只读（紧急）：关闭企业全部已开启的写入开关。 */
  async readonlyAll(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, MANAGE)
    const { reason } = ReasonBodySchema.parse(rawBody)
    return this.closeMany(req, context, { keys: SWITCH_CATALOG.map(item => item.key), reason, action: 'READONLY_ALL', auditAction: 'WRITE_SWITCH_READONLY_ALL', title: '企业已切换为全部只读' })
  }

  private async closeMany(
    req: RequestWithContext,
    context: { tenantId: string; userId: string },
    input: { keys: readonly string[]; reason: string; action: string; auditAction: string; title: string },
  ) {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.integrationSwitch.findMany({ where: { tenantId: context.tenantId, sellerAccountId: null, enabled: true, switchKey: { in: [...input.keys] } }, take: 100 })
      for (const before of rows) {
        const row = await this.turnOff(tx, before.id, null)
        await this.log(tx, context.tenantId, before.switchKey, input.action, input.reason, context.userId, before, row)
      }
      const keys = rows.map(row => row.switchKey)
      await this.audit.record(
        req,
        { action: input.auditAction, resourceType: 'IntegrationSwitch', resourceId: null, reason: input.reason, detail: { switchKeys: keys, count: keys.length } },
        { client: tx },
      )
      if (keys.length > 0) {
        await this.notify.toHolders(
          context.tenantId,
          MANAGE,
          { kind: 'WRITE_SWITCH_CHANGED', title: input.title, body: `共关闭 ${keys.length} 项。原因：${input.reason}`, link: '/app/settings/integrations', severity: 'WARNING' },
          { client: tx },
        )
      }
      return { changed: keys.length, keys }
    })
  }

  private turnOff(tx: Tx, id: string, autoReason: string | null) {
    return tx.integrationSwitch.update({ where: { id }, data: { enabled: false, autoDisabledReason: autoReason, version: { increment: 1 } } })
  }

  private async log(tx: Tx, tenantId: string, key: string, action: string, reason: string, actorId: string, before: Row | null | undefined, after: Row) {
    await tx.integrationSwitchLog.create({ data: { tenantId, switchKey: key, action, reason, actorId, beforeJson: snapshot(before), afterJson: snapshot(after) } })
  }
}
