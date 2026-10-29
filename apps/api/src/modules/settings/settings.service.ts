import { Injectable } from '@nestjs/common'
import { PREFERENCE_KEYS, PreferenceUpdateBodySchema, TENANT_SETTING_DEFAULTS, TENANT_SETTING_LABELS, TENANT_SETTING_SCHEMAS, isTenantSettingKey, type TenantSettingKey } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'

type SettingsClient = Pick<Prisma.TransactionClient, 'tenantSetting'>

// 企业设置项（键值）：读取时缺失的键返回默认值；写入前按键的固定格式校验；带版本号防止多人同时修改互相覆盖。
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 读取一个设置项的当前值与版本（没有记录返回默认值，版本为 0）。 */
  async get<K extends TenantSettingKey>(tenantId: string, key: K, client: SettingsClient = this.prisma): Promise<{ value: (typeof TENANT_SETTING_DEFAULTS)[K]; version: number }> {
    const row = await client.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key } })
    if (!row) return { value: TENANT_SETTING_DEFAULTS[key], version: 0 }
    const parsed = TENANT_SETTING_SCHEMAS[key].safeParse(row.valueJson)
    // 库里的值不合格式（被人为改过）时按默认值处理，避免把坏数据带进业务计算
    return { value: (parsed.success ? parsed.data : TENANT_SETTING_DEFAULTS[key]) as (typeof TENANT_SETTING_DEFAULTS)[K], version: row.version }
  }

  /** 写入一个设置项（调用方负责权限与审计）。版本为 0 表示“按没有记录创建”，否则必须与当前版本一致。 */
  async set<K extends TenantSettingKey>(tx: SettingsClient, tenantId: string, userId: string, key: K, rawValue: unknown, expectedVersion: number): Promise<{ value: unknown; version: number }> {
    const value = TENANT_SETTING_SCHEMAS[key].parse(rawValue)
    const current = await tx.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key }, select: { id: true, version: true } })
    if (!current) {
      if (expectedVersion !== 0) throw appError('CONFLICT', '设置项已被他人修改，请刷新后重试')
      const created = await tx.tenantSetting.create({ data: { tenantId, key, valueJson: value as Prisma.InputJsonValue, scope: 'TENANT', updatedBy: userId } })
      return { value, version: created.version }
    }
    const result = await tx.tenantSetting.updateMany({
      where: { id: current.id, version: expectedVersion },
      data: { valueJson: value as Prisma.InputJsonValue, updatedBy: userId, version: { increment: 1 } },
    })
    if (result.count === 0) throw appError('CONFLICT', '设置项已被他人修改，请刷新后查看最新内容再决定是否覆盖', { details: { currentVersion: current.version, expectedVersion } })
    return { value, version: expectedVersion + 1 }
  }

  async list(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'settings.read')
    const items = await Promise.all(
      PREFERENCE_KEYS.map(async key => {
        const current = await this.get(context.tenantId, key)
        return { key, label: TENANT_SETTING_LABELS[key], value: current.value, version: current.version, defaultValue: TENANT_SETTING_DEFAULTS[key] }
      }),
    )
    return { items }
  }

  async update(req: RequestWithContext, key: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'settings.write')
    if (!isTenantSettingKey(key) || !PREFERENCE_KEYS.includes(key)) throw appError('RESOURCE_NOT_FOUND', '设置项不存在，或需要在专门的页面修改')
    const body = PreferenceUpdateBodySchema.parse(rawBody)
    return this.prisma.$transaction(async tx => {
      const before = await this.get(context.tenantId, key, tx)
      const saved = await this.set(tx, context.tenantId, context.userId, key, body.value, body.version)
      await this.audit.record(
        req,
        { action: 'TENANT_SETTING_UPDATED', resourceType: 'TenantSetting', resourceId: key, before: { value: before.value }, after: { value: saved.value }, reason: body.reason },
        { client: tx },
      )
      return { key, value: saved.value, version: saved.version }
    })
  }
}
