import { ADS_WRITE_JOB, ADS_WRITE_KIND_INFO, adsMoneyText, adsWriteAfterText, adsWriteOpIssue, adsWriteSwitches, type AdsWriteEntity, type AdsWriteOp, type AdsWriteSource } from '@nova/api-contracts'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { QueueRegistry } from '../runtime/queues'

// 自动规则与分时策略的写入提交（P3-17）：和手动写入走同一条流水线（AdsWriteRun + 同步任务 + 工作流），区别只是来源与提交人。
// 提交前的检查与手动一致：内容合法、对象存在、与当前值不同、动作开关与来源开关都打开、有可用的广告授权与广告账户编号。
// 任何一项不满足都不提交，返回原因（调用方把原因记进执行记录，不当成失败重试）。
// 本文件只处理活动、广告组、投放对象三种“修改”类写入；新增类（否定、加词）需要所属广告组，不在这里。

export type AutoWriteResult = { status: 'QUEUED'; runId: string } | { status: 'SKIPPED'; reason: string } | { status: 'FAILED'; reason: string; runId: string }

export interface AutoWriteDeps {
  db: PrismaClient
  queues: Pick<QueueRegistry, 'addSync'>
}

interface Target {
  adsProfileId: string
  entityType: AdsWriteEntity
  entityId: string
  externalId: string
  campaignExternalId: string | null
  label: string
  before: string | null
  table: 'AdsTarget' | 'AdsKeyword' | null
  hasAccount: boolean
}

const MESSAGE_MAX = 500

/** 按修改类型找到对象：系统编号 → 亚马逊编号、当前值、所属广告档案。找不到返回 null。 */
async function resolveTarget(db: PrismaClient, tenantId: string, op: AdsWriteOp): Promise<Target | null> {
  const profile = { select: { adsAccountId: true } }
  if (op.kind === 'CAMPAIGN_STATE' || op.kind === 'CAMPAIGN_BUDGET') {
    const row = await db.adsCampaign.findFirst({
      where: { id: op.entityId, tenantId },
      select: { id: true, adsProfileId: true, externalCampaignId: true, name: true, state: true, budget: true, adsProfile: profile },
    })
    if (!row) return null
    const before = op.kind === 'CAMPAIGN_STATE' ? row.state : adsMoneyText(row.budget?.toString())
    return {
      adsProfileId: row.adsProfileId,
      entityType: 'CAMPAIGN',
      entityId: row.id,
      externalId: row.externalCampaignId,
      campaignExternalId: row.externalCampaignId,
      label: row.name,
      before,
      table: null,
      hasAccount: !!row.adsProfile.adsAccountId,
    }
  }
  if (op.kind === 'AD_GROUP_STATE' || op.kind === 'AD_GROUP_BID') {
    const row = await db.adsAdGroup.findFirst({
      where: { id: op.entityId, tenantId },
      select: { id: true, adsProfileId: true, adGroupId: true, campaignId: true, name: true, state: true, defaultBid: true, adsProfile: profile },
    })
    if (!row) return null
    const before = op.kind === 'AD_GROUP_STATE' ? row.state : adsMoneyText(row.defaultBid?.toString())
    return {
      adsProfileId: row.adsProfileId,
      entityType: 'AD_GROUP',
      entityId: row.id,
      externalId: row.adGroupId,
      campaignExternalId: row.campaignId,
      label: row.name,
      before,
      table: null,
      hasAccount: !!row.adsProfile.adsAccountId,
    }
  }
  if (op.kind === 'TARGET_STATE' || op.kind === 'TARGET_BID') {
    const target = await db.adsTarget.findFirst({
      where: { id: op.entityId, tenantId },
      select: { id: true, adsProfileId: true, targetId: true, expression: true, bid: true, state: true, adsProfile: profile },
    })
    const keyword = target
      ? null
      : await db.adsKeyword.findFirst({ where: { id: op.entityId, tenantId }, select: { id: true, adsProfileId: true, keywordId: true, text: true, bid: true, state: true, adsProfile: profile } })
    const row = target ?? keyword
    if (!row) return null
    const before = op.kind === 'TARGET_STATE' ? row.state : adsMoneyText(row.bid?.toString())
    return {
      adsProfileId: row.adsProfileId,
      entityType: 'TARGET',
      entityId: row.id,
      externalId: target ? target.targetId : keyword!.keywordId,
      campaignExternalId: null,
      label: target ? target.expression : keyword!.text,
      before,
      table: target ? 'AdsTarget' : 'AdsKeyword',
      hasAccount: !!row.adsProfile.adsAccountId,
    }
  }
  return null
}

/** 数字按数值比较（20 与 20.00 相同），其余按文字比较。 */
const sameValue = (before: string | null, after: string): boolean => {
  if (before === null) return false
  const a = Number(before)
  const b = Number(after)
  return Number.isFinite(a) && Number.isFinite(b) && before.trim() !== '' && after.trim() !== '' ? a === b : before === after
}

export async function submitAutoWrite(deps: AutoWriteDeps, input: { tenantId: string; source: Exclude<AdsWriteSource, 'MANUAL'>; op: AdsWriteOp; requestId: string }): Promise<AutoWriteResult> {
  const { db, queues } = deps
  const { tenantId, source, op } = input
  const issue = adsWriteOpIssue(op)
  if (issue) return { status: 'SKIPPED', reason: issue }
  const target = await resolveTarget(db, tenantId, op)
  if (!target) return { status: 'SKIPPED', reason: '对象已不存在，没有提交' }
  const after = adsWriteAfterText(op)
  if (sameValue(target.before, after)) return { status: 'SKIPPED', reason: `当前值已经是 ${after}，没有提交` }
  if (!target.hasAccount) return { status: 'SKIPPED', reason: '广告档案还没有统一接口的广告账户编号，没有提交' }

  const keys = adsWriteSwitches(op.kind, source)
  const on = await db.integrationSwitch.findMany({ where: { tenantId, switchKey: { in: keys }, sellerAccountId: null, enabled: true }, select: { switchKey: true }, take: keys.length })
  const off = keys.filter(key => !on.some(row => row.switchKey === key))
  if (off.length > 0) return { status: 'SKIPPED', reason: `写入开关未打开（${off.join('、')}），没有提交` }
  const connection = await db.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } }, select: { id: true } })
  if (!connection) return { status: 'SKIPPED', reason: '没有可用的广告授权，没有提交' }

  const { kind, entityId: _entityId, ...rest } = op
  const made = await db.$transaction(async tx => {
    const run = await tx.adsWriteRun.create({
      data: {
        tenantId,
        adsProfileId: target.adsProfileId,
        kind,
        source,
        entityType: target.entityType,
        entityId: target.entityId,
        externalId: target.externalId,
        entityLabel: target.label.slice(0, 200),
        requestJson: { ...rest, campaignExternalId: target.campaignExternalId, table: target.table } as Prisma.InputJsonValue,
        beforeValue: target.before === null ? null : target.before.slice(0, MESSAGE_MAX),
        afterValue: after.slice(0, MESSAGE_MAX),
        status: 'PENDING',
        requestId: input.requestId,
      },
      select: { id: true },
    })
    const job = await tx.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: ADS_WRITE_JOB,
        status: 'PENDING',
        requestId: input.requestId,
        context: { adsWriteRunId: run.id },
        domain: syncDomainOf(ADS_WRITE_JOB),
        sourceKey: syncSourceKey(connection.id, ADS_WRITE_JOB, run.id),
        priority: PRIORITY.SCHEDULED,
      },
      select: { id: true },
    })
    await tx.adsWriteRun.update({ where: { id: run.id }, data: { syncJobId: job.id } })
    return { runId: run.id, jobId: job.id }
  })
  try {
    await queues.addSync(ADS_WRITE_JOB, { tenantId, syncJobId: made.jobId, requestId: input.requestId, adsWriteRunId: made.runId }, { jobId: made.jobId, priority: PRIORITY.SCHEDULED })
  } catch {
    const now = new Date()
    await db.adsWriteRun.updateMany({ where: { id: made.runId, tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
    await db.syncJob.updateMany({ where: { id: made.jobId, tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
    return { status: 'FAILED', reason: '任务队列暂时不可用，本次写入已记为失败', runId: made.runId }
  }
  return { status: 'QUEUED', runId: made.runId }
}

/** 这种写入由哪类提交人发起时，开关与权限说明用（给调用方拼记录文字）。 */
export const autoWriteLabel = (op: AdsWriteOp): string => ADS_WRITE_KIND_INFO[op.kind].label
