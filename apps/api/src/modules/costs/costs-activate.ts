import { COST_STATUS_LABEL, planActivation, type CostActivateResult } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { RequestWithContext } from '../../platform/http'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { closedMessage, closedPeriodOf, COST_SELECT, liteOf, stateConflict, statusOf, type ClosedPeriod } from './costs-common'

// 草稿确认生效（P2b-14）：新建时顺带生效、批量生效共用同一套规则，都在调用方的事务里执行。
// 规则：只有草稿能生效；生效日不能落在已关账或关账中的期间；同一生效日已有同类价格版本的，旧版本被替换（见 planActivation）。
// 同一个事务里出任何一个错误，整批都不生效。

export interface ActivateInput {
  req: RequestWithContext
  audit: AuditWriter
  tx: Prisma.TransactionClient
  tenantId: string
  userId: string
  closed: readonly ClosedPeriod[]
  now: Date
}

const LABEL = '成本版本'

export async function activateOne(input: ActivateInput, id: string, expectedVersion: number): Promise<CostActivateResult['versions'][number]> {
  const { tx, tenantId } = input
  const row = await tx.costVersion.findFirst({ where: { id, tenantId }, select: COST_SELECT })
  if (!row) throw stateConflict('版本不存在，可能已被丢弃，请刷新后重试')
  const name = `${row.sku} 第 ${row.versionNo} 版`
  if (row.status !== 'DRAFT') throw stateConflict(`${name} 已是“${COST_STATUS_LABEL[statusOf(row.status)]}”，不能再确认生效`)
  const lite = liteOf(row)
  const period = closedPeriodOf(input.closed, lite.effectiveFrom)
  if (period) throw stateConflict(`${name}：${closedMessage(lite.effectiveFrom, period)}`)
  const actives = await tx.costVersion.findMany({ where: { tenantId, sku: row.sku, status: 'ACTIVE' }, select: COST_SELECT, orderBy: { versionNo: 'desc' }, take: 500 })
  const plan = planActivation(
    lite,
    actives.map(item => liteOf(item)),
  )
  if (!plan.ok) throw stateConflict(`${name}：${plan.reason}`)
  const replaced: number[] = []
  for (const old of plan.replaces) {
    const stored = actives.find(item => item.id === old.id)
    if (!stored) continue
    await updateWithVersion(tx.costVersion, { id: old.id, tenantId }, stored.version, { status: 'REPLACED', replacedById: id, replacedAt: input.now }, { label: LABEL })
    replaced.push(old.versionNo)
    await input.audit.record(
      input.req,
      {
        action: 'COST_VERSION_REPLACED',
        resourceType: 'CostVersion',
        resourceId: old.id,
        before: { status: 'ACTIVE' },
        after: { status: 'REPLACED', replacedByVersionNo: row.versionNo },
        detail: { sku: row.sku, versionNo: old.versionNo },
      },
      { client: tx },
    )
  }
  await updateWithVersion(tx.costVersion, { id, tenantId }, expectedVersion, { status: 'ACTIVE', activatedBy: input.userId, activatedAt: input.now }, { label: LABEL })
  await input.audit.record(
    input.req,
    {
      action: 'COST_VERSION_ACTIVATED',
      resourceType: 'CostVersion',
      resourceId: id,
      before: { status: 'DRAFT' },
      after: { status: 'ACTIVE' },
      detail: { sku: row.sku, versionNo: row.versionNo, effectiveFrom: lite.effectiveFrom, source: row.source, replacedVersionNos: replaced },
    },
    { client: tx },
  )
  return { id, sku: row.sku, versionNo: row.versionNo, replacedVersionNos: replaced }
}
