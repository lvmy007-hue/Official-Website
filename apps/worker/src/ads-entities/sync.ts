import type { AdsArchiveSkip } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { ensureAdsAccount } from '../ads-reports/run'
import type { AdsV1Api, AdsV1Resource } from '../connectors/ads-v1-api'
import type { AdsEntityRecord } from '../connectors/ads-v1-parse'
import { readAdsEntities, newEntityStats } from '../importers/ads/entities'
import { BATCH_TX_TIMEOUT_MS, inBatches } from '../streaming/batch'
import type { ImportContext, JsonObject } from '../types'
import { archiveUnseen } from './archive'
import { ENTITY_TABLES, planEntity, planPortfolio, SKIP_LABEL, type EntityTable, type Planned, type SkipReason } from './map'
import { delegateOf, type Scope, type TableName } from './tables'
import { upsertRows, type WriteRow } from './write'

// 广告实体落库同步器（P5-12A，importers.md A-01）：一个广告档案一次同步——先广告组合（旧接口），再统一接口的活动、广告组、广告、投放对象，
// 写进 AdsPortfolio、AdsCampaign、AdsAdGroup、AdsAd、AdsKeyword、AdsTarget、AdsNegativeTarget；读完一类对象后把没出现的归档（archive.ts 的三道保护）。
// 一个部分失败（例如广告组合接口 403）不拖垮其他部分：其余部分照常写完、已完整读完的类别照常归档，最后把第一个错误原样抛出，任务按失败登记并重试。
// 一批最多 500 个对象一个事务；对象编号是幂等键，任务重试不会重复。

export const ENTITY_BATCH = 500
const SYNC_RESOURCES: readonly AdsV1Resource[] = ['campaigns', 'adGroups', 'ads', 'targets']
export const SYNC_TABLES: readonly TableName[] = [...ENTITY_TABLES, 'portfolios']

export type TableResult = { read: number; created: number; updated: number; removed: number; archived: number; archiveSkipped: AdsArchiveSkip | null }
export type EntitySyncResult = {
  /** 本次读到的对象数（同步中心的“行数”）。 */
  imported: number
  /** 其中新建、更新、删除的对象数（没变的不计）。 */
  changed: number
  tables: Record<TableName, TableResult>
  skipped: Partial<Record<SkipReason, number>>
  skippedText: string | null
  /** 翻页没翻完的统一接口资源（这些资源对应的表本次不归档）。 */
  incompleteResources: string[]
}

export type EntitySyncInput = {
  profile: { id: string; tenantId: string; adsAccountId: string; displayName: string | null; currencyCode: string }
  api: Pick<AdsV1Api, 'queryAll'>
  /** 广告组合（旧接口，按档案范围）；失败不影响统一接口部分。 */
  loadPortfolios: () => Promise<JsonObject[]>
  now?: Date
}

const emptyResult = (): TableResult => ({ read: 0, created: 0, updated: 0, removed: 0, archived: 0, archiveSkipped: null })
const tablesOf = (record: AdsEntityRecord): TableName[] =>
  record.entityType === 'CAMPAIGN' ? ['campaigns'] : record.entityType === 'AD_GROUP' ? ['adGroups'] : record.entityType === 'AD' ? ['ads'] : ['keywords', 'targets', 'negatives']

type State = {
  scope: Scope
  tables: Record<TableName, TableResult>
  seen: Record<TableName, Set<string>>
  skipped: Partial<Record<SkipReason, number>>
  /** 广告组 → 活动：关键词与否定投放用它补活动编号。 */
  groupCampaign: Map<string, string>
}

function apply(state: State, table: TableName, rows: WriteRow[], result: { created: number; updated: number; removed: number }) {
  const total = state.tables[table]
  total.created += result.created
  total.updated += result.updated
  total.removed += result.removed
  for (const row of rows) state.seen[table].add(row.key)
  total.read += rows.length
}

/** 关键词与否定投放的活动编号：接口没给就用广告组查（本批里已读到的优先，其余一次批量查库）。 */
async function resolveCampaigns(db: PrismaClient, state: State, planned: Planned[]): Promise<void> {
  const missing = [...new Set(planned.filter(item => item.values.campaignId === undefined && item.groupId).map(item => item.groupId as string))].filter(id => !state.groupCampaign.has(id))
  if (missing.length === 0) return
  const found = await delegateOf(db, 'adGroups').findMany({
    where: { tenantId: state.scope.tenantId, adsAccountId: state.scope.adsAccountId, adGroupId: { in: missing } },
    select: { id: true, adGroupId: true, campaignId: true },
  })
  for (const row of found) state.groupCampaign.set(String(row.adGroupId), String(row.campaignId))
}

async function writeBatch(db: PrismaClient, state: State, records: AdsEntityRecord[]): Promise<void> {
  const planned: Planned[] = []
  for (const record of records) {
    const plan = planEntity(record)
    if ('skipped' in plan) {
      state.skipped[plan.skipped] = (state.skipped[plan.skipped] ?? 0) + 1
      for (const table of tablesOf(record)) state.seen[table].add(record.entityId) // 只登记编号：存在，但没能映射，不能被归档
      continue
    }
    if (plan.table === 'campaigns') plan.values.adsAccountId = state.scope.adsAccountId // 旧接口同步来的活动没有账户编号，这里补上
    if (plan.table === 'adGroups' && typeof plan.values.campaignId === 'string') state.groupCampaign.set(plan.key, plan.values.campaignId)
    planned.push(plan)
  }
  await resolveCampaigns(db, state, planned)
  const byTable = new Map<EntityTable, WriteRow[]>()
  for (const plan of planned) {
    if (plan.values.campaignId === undefined && plan.groupId) plan.values.campaignId = state.groupCampaign.get(plan.groupId)
    if ((plan.table === 'keywords' || plan.table === 'negatives') && plan.values.campaignId === undefined) {
      state.skipped.NO_PARENT = (state.skipped.NO_PARENT ?? 0) + 1
      state.seen[plan.table].add(plan.key)
      continue
    }
    const rows = byTable.get(plan.table) ?? []
    rows.push({ key: plan.key, values: plan.values, remove: plan.remove })
    byTable.set(plan.table, rows)
  }
  for (const table of ENTITY_TABLES) {
    const rows = byTable.get(table)
    if (rows) apply(state, table, rows, await upsertRows(db, table, state.scope, rows))
  }
}

async function syncPortfolios(ctx: ImportContext, state: State, load: () => Promise<JsonObject[]>): Promise<void> {
  const rows = (await load()).flatMap(item => {
    const plan = planPortfolio(item)
    return plan ? [plan] : []
  })
  for (let index = 0; index < rows.length; index += ENTITY_BATCH) {
    const chunk = rows.slice(index, index + ENTITY_BATCH)
    const result = await ctx.prisma.$transaction(tx => upsertRows(tx as unknown as PrismaClient, 'portfolios', state.scope, chunk), { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 })
    apply(state, 'portfolios', chunk, result)
  }
}

export async function syncAdsEntities(ctx: ImportContext, input: EntitySyncInput): Promise<EntitySyncResult> {
  const { prisma, logger } = ctx
  const now = input.now ?? new Date()
  const { profile } = input
  await ensureAdsAccount(prisma, profile, now)
  const scope: Scope = { tenantId: profile.tenantId, adsProfileId: profile.id, adsAccountId: profile.adsAccountId, currency: profile.currencyCode, now }
  const state: State = {
    scope,
    tables: Object.fromEntries(SYNC_TABLES.map(table => [table, emptyResult()])) as Record<TableName, TableResult>,
    seen: Object.fromEntries(SYNC_TABLES.map(table => [table, new Set<string>()])) as Record<TableName, Set<string>>,
    skipped: {},
    groupCampaign: new Map(),
  }
  const stats = newEntityStats()
  const complete: Record<TableName, boolean> = { campaigns: false, adGroups: false, ads: false, keywords: false, targets: false, negatives: false, portfolios: false }
  let failure: unknown = null

  try {
    await syncPortfolios(ctx, state, input.loadPortfolios)
    complete.portfolios = true
  } catch (error) {
    failure ??= error
    logger.warn({ adsProfileId: profile.id, error: error instanceof Error ? error.message : String(error) }, 'ads portfolios sync failed')
  }
  try {
    for await (const batch of inBatches(readAdsEntities(input.api, { resources: SYNC_RESOURCES, stats }), ENTITY_BATCH)) {
      await prisma.$transaction(tx => writeBatch(tx as unknown as PrismaClient, state, batch), { timeout: BATCH_TX_TIMEOUT_MS, maxWait: 10_000 })
    }
  } catch (error) {
    failure ??= error
    logger.warn({ adsProfileId: profile.id, error: error instanceof Error ? error.message : String(error) }, 'ads entities sync failed')
  }
  complete.campaigns = stats.campaigns.complete
  complete.adGroups = stats.adGroups.complete
  complete.ads = stats.ads.complete
  complete.keywords = complete.targets = complete.negatives = stats.targets.complete
  const incompleteResources = SYNC_RESOURCES.filter(resource => !stats[resource].complete)

  for (const table of SYNC_TABLES) {
    try {
      const outcome = await archiveUnseen(prisma, table, scope, state.seen[table], complete[table])
      state.tables[table].archived = outcome.archived
      state.tables[table].archiveSkipped = outcome.skipped
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
  // 归档被保护住（接口返回为空、比例过大）不是静默的：写进任务结果，也在日志里留一条，方便排查是接口出了问题还是真的大批归档
  const guarded = SYNC_TABLES.flatMap(table =>
    state.tables[table].archiveSkipped === 'EMPTY_RESPONSE' || state.tables[table].archiveSkipped === 'TOO_MANY' ? [`${table}:${state.tables[table].archiveSkipped}`] : [],
  )
  if (guarded.length > 0) logger.warn({ adsProfileId: profile.id, guarded }, 'ads entity archive skipped by guard')

  const skippedEntries = Object.entries(state.skipped) as Array<[SkipReason, number]>
  const skippedText = skippedEntries.length === 0 ? null : skippedEntries.map(([reason, count]) => `${SKIP_LABEL[reason]}：${count} 个`).join('；')
  if (skippedText) logger.warn({ adsProfileId: profile.id, skipped: state.skipped }, 'ads entities skipped')
  const values = Object.values(state.tables)
  return {
    imported: values.reduce((sum, item) => sum + item.read, 0),
    changed: values.reduce((sum, item) => sum + item.created + item.updated + item.removed + item.archived, 0),
    tables: state.tables,
    skipped: state.skipped,
    skippedText,
    incompleteResources,
  }
}
