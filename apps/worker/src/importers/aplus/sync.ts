import { APLUS_LIMITS, APLUS_MARKETPLACE_ID, aplusStatusOf, type AplusStatus } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { isAplusRejected, type AplusApi } from '../../connectors/aplus-api'
import type { ImportContext } from '../../types'
import { parseAsinList, parseContentDetail, parseContentList, parsePublishRecords, type ParsedDetail, type ParsedListItem } from './parse'

// A+ 内容同步器（importers.md I-18，P4-14）：每个店铺每天一次，只读拉取内容、关联 ASIN 与发布记录并写库。规则：
//   - 内容列表分页读取，最多 syncContentsMax（100）份，超过的记日志不报错；每份再取一次详情；
//   - 按（店铺、站点、内容引用键）更新或新建；状态用 aplusStatusOf 映射，亚马逊给了不认识的状态：已有内容保持原状态，新内容不写（不拿“草稿”顶替）；
//     模块结构原样存进 draftJson；接口没返回模块时不覆盖已有的；不改 version（version 只在接口受理写入时加 1）；亚马逊侧已经没有的内容保持原样，不删除；
//   - 这个内容有排队中或处理中的写入记录时，本轮整份跳过（别冲掉用户刚提交的修改）；店铺有创建任务在途时，本轮不新建本地行（避免和创建回写撞唯一键，下一次同步再补）；
//   - 关联 ASIN：看到的更新 lastSeenAt、没有的新建；本轮没看到的行既不删除也不更新时间；保留已有的上线时间；asinCount 按该内容的行数重算；
//   - 发布记录：已批准的内容，从它的关联 ASIN 里挑最多 syncPublishAsinsMax（30）个（上线时间为空的优先）查发布记录，匹配到本内容引用键且有上线时间的写进关联行，
//     内容的上线时间取各 ASIN 里最早的；有上线时间的已批准内容状态记为已发布；
//   - 状态变化写审核事件（新内容写当前状态、已有内容状态变了写新的，同一状态不重复）；
//   - 单份内容详情 400 / 404 只跳过并计数；403 在连接器里已转成不可重试的 APL_ROLE_MISSING；429、5xx 与网络错误原样抛出，由任务重试。
// 新鲜度的成功、失败与“未授权”由同步监听器按任务类型统一登记（来源 aplus.api），这里不重复写。

export interface AplusScope {
  tenantId: string
  sellerAccountId: string
}
export interface AplusSyncOptions {
  /** 本次同步的时间；测试注入，缺省取当前时间。 */
  now?: Date
  contentsMax?: number
  publishAsinsMax?: number
}
export interface AplusSyncResult {
  imported: number
  created: number
  updated: number
  /** 因为有写入在途而本轮没有覆盖的内容数。 */
  skippedBusy: number
  /** 详情取不到、没有名称或状态不认识而没有写入的内容数。 */
  skippedInvalid: number
  asinRows: number
  publishAsinsChecked: number
  published: number
  events: number
  truncated: boolean
}

const LIST_PAGES_MAX = 30
const ASIN_PAGES_MAX = 40
const PUBLISH_PAGES_MAX = 5
const KEY_CHUNK = 500
const READ_MAX = 20_000

interface ExistingRow {
  id: string
  contentReferenceKey: string | null
  name: string
  status: string
  publishedAt: Date | null
}
/** 本轮处理完的一份内容：状态与事件在最后统一核对。 */
interface Item {
  id: string
  key: string
  prev: string | null
  status: AplusStatus
  /** 亚马逊侧是“已批准”（还没算上线时间）：只有这些内容才查发布记录。 */
  approved: boolean
  updatedAt: Date | null
  reason: string | null
}
type Outcome = { kind: 'done'; item: Item; created: boolean; asinRows: number } | { kind: 'busy' } | { kind: 'invalid' }

async function fetchList(api: AplusApi, limit: number): Promise<{ items: ParsedListItem[]; truncated: boolean }> {
  const byKey = new Map<string, ParsedListItem>()
  let token: string | undefined
  let more = false
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    const parsed = parseContentList(await api.listContents(token))
    for (const item of parsed.items) byKey.set(item.key, item)
    more = Boolean(parsed.nextToken) && parsed.nextToken !== token
    if (!more || byKey.size > limit) break
    token = parsed.nextToken ?? undefined
  }
  const all = [...byKey.values()]
  return { items: all.slice(0, limit), truncated: all.length > limit || more }
}

/** 取一份内容的全部关联 ASIN；这份内容在亚马逊侧取不到（400、404）返回 null，调用方保持本地关联不动。 */
async function fetchAsins(api: AplusApi, key: string): Promise<string[] | null> {
  const found = new Set<string>()
  let token: string | undefined
  try {
    for (let page = 0; page < ASIN_PAGES_MAX; page += 1) {
      const parsed = parseAsinList(await api.listAsins(key, token))
      for (const asin of parsed.asins) found.add(asin)
      if (!parsed.nextToken || parsed.nextToken === token) break
      token = parsed.nextToken
    }
  } catch (error) {
    if (isAplusRejected(error)) return null
    throw error
  }
  return [...found]
}

async function fetchDetail(api: AplusApi, key: string): Promise<ParsedDetail | null> {
  try {
    return parseContentDetail(await api.getContent(key))
  } catch (error) {
    if (isAplusRejected(error)) return null
    throw error
  }
}

interface Context {
  ctx: ImportContext
  api: AplusApi
  scope: AplusScope
  now: Date
  /** 店铺有创建任务在途。 */
  creating: boolean
}

/** 同步一份内容：先联网取详情与关联 ASIN，再在一个事务里写内容、关联与 asinCount。 */
async function syncOne(env: Context, listed: ParsedListItem, existing: ExistingRow | undefined): Promise<Outcome> {
  const { ctx, api, scope, now } = env
  const detail = await fetchDetail(api, listed.key)
  if (!detail) return { kind: 'invalid' }
  const rawStatus = detail.status ?? listed.status
  const mapped = aplusStatusOf(rawStatus, existing?.publishedAt != null)
  const status = (mapped ?? existing?.status ?? null) as AplusStatus | null
  const name = detail.name ?? listed.name ?? existing?.name ?? null
  if (!status || !name) return { kind: 'invalid' }
  if (!existing && env.creating) return { kind: 'busy' }
  const asins = await fetchAsins(api, listed.key)
  const updatedAt = detail.updatedAt ?? listed.updatedAt
  // 被拒时取接口给的原文（没有就是空）；状态不认识时不动已有的原文
  const reason = mapped === null ? undefined : mapped === 'REJECTED' ? detail.rejectionReason : null
  const common = {
    name,
    ...(detail.contentType ? { contentType: detail.contentType } : {}),
    ...(detail.locale ? { locale: detail.locale } : {}),
    status,
    ...(reason !== undefined ? { rejectionReason: reason } : {}),
    ...(detail.modules ? { draftJson: { contentModuleList: detail.modules } as unknown as Prisma.InputJsonValue } : {}),
    ...(updatedAt ? { amazonUpdatedAt: updatedAt } : {}),
    lastSyncedAt: now,
  }
  return ctx.prisma.$transaction(async (tx): Promise<Outcome> => {
    // 在事务里再核对一次写入在途，缩小“检查之后用户才提交”的空档
    if (existing && (await tx.aplusWriteRun.count({ where: { tenantId: scope.tenantId, contentId: existing.id, status: { in: ['QUEUED', 'RUNNING'] } } })) > 0) return { kind: 'busy' }
    const id = existing
      ? existing.id
      : (
          await tx.aplusContent.create({
            data: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: APLUS_MARKETPLACE_ID, contentReferenceKey: listed.key, ...common },
            select: { id: true },
          })
        ).id
    if (existing) await tx.aplusContent.update({ where: { id }, data: common })
    if (asins && asins.length > 0) {
      await tx.aplusAsinRelation.updateMany({ where: { tenantId: scope.tenantId, contentId: id, asin: { in: asins } }, data: { lastSeenAt: now } })
      await tx.aplusAsinRelation.createMany({
        data: asins.map(asin => ({ tenantId: scope.tenantId, contentId: id, sellerAccountId: scope.sellerAccountId, asin, lastSeenAt: now })),
        skipDuplicates: true,
      })
    }
    const asinRows = await tx.aplusAsinRelation.count({ where: { tenantId: scope.tenantId, contentId: id } })
    await tx.aplusContent.update({ where: { id }, data: { asinCount: asinRows } })
    const item: Item = {
      id,
      key: listed.key,
      prev: existing?.status ?? null,
      status,
      approved: aplusStatusOf(rawStatus, false) === 'APPROVED',
      updatedAt,
      reason: status === 'REJECTED' ? (detail.rejectionReason ?? null) : null,
    }
    return { kind: 'done', item, created: !existing, asinRows }
  })
}

/** 一个 ASIN 的发布记录里，各内容引用键对应的最早上线时间（没有上线时间的记录不算）。 */
async function publishTimes(api: AplusApi, asin: string): Promise<Map<string, Date> | null> {
  const times = new Map<string, Date>()
  let token: string | undefined
  try {
    for (let page = 0; page < PUBLISH_PAGES_MAX; page += 1) {
      const parsed = parsePublishRecords(await api.listPublishRecords(asin, token))
      for (const record of parsed.records) {
        const before = times.get(record.key)
        if (record.publishedAt && (!before || record.publishedAt < before)) times.set(record.key, record.publishedAt)
      }
      if (!parsed.nextToken || parsed.nextToken === token) break
      token = parsed.nextToken
    }
  } catch (error) {
    if (isAplusRejected(error)) return null
    throw error
  }
  return times
}

/** 已批准内容的上线时间：写进关联行，内容取最早的，并把状态记为已发布；返回实际检查的 ASIN 数与变为已发布的内容数。 */
async function syncPublishing(env: Context, items: Item[], max: number): Promise<{ checked: number; published: number }> {
  const { ctx, api, scope } = env
  const approved = items.filter(item => item.approved)
  if (approved.length === 0) return { checked: 0, published: 0 }
  const relations = await ctx.prisma.aplusAsinRelation.findMany({
    where: { tenantId: scope.tenantId, contentId: { in: approved.map(item => item.id) } },
    select: { contentId: true, asin: true, publishedAt: true },
    take: READ_MAX,
  })
  // 上线时间还没有的优先；每次最多查 max 个不同的 ASIN，剩下的下一次同步继续
  const ordered = [...relations].sort((a, b) => Number(a.publishedAt !== null) - Number(b.publishedAt !== null) || (a.asin < b.asin ? -1 : a.asin > b.asin ? 1 : 0))
  const chosen = [...new Set(ordered.map(row => row.asin))].slice(0, max)
  const keyOf = new Map(approved.map(item => [item.id, item.key]))
  const touched = new Set<string>()
  let checked = 0
  for (const asin of chosen) {
    const times = await publishTimes(api, asin)
    if (!times) continue
    checked += 1
    for (const row of ordered.filter(item => item.asin === asin)) {
      const time = times.get(keyOf.get(row.contentId) ?? '')
      if (!time) continue
      touched.add(row.contentId)
      if (row.publishedAt?.getTime() === time.getTime()) continue
      await ctx.prisma.aplusAsinRelation.updateMany({ where: { tenantId: scope.tenantId, contentId: row.contentId, asin }, data: { publishedAt: time } })
    }
  }
  if (touched.size === 0) return { checked, published: 0 }
  const rows = await ctx.prisma.aplusAsinRelation.findMany({
    where: { tenantId: scope.tenantId, contentId: { in: [...touched] }, publishedAt: { not: null } },
    select: { contentId: true, publishedAt: true },
    take: READ_MAX,
  })
  let published = 0
  for (const item of approved.filter(entry => touched.has(entry.id))) {
    const times = rows.flatMap(row => (row.contentId === item.id && row.publishedAt ? [row.publishedAt] : []))
    if (times.length === 0) continue
    const earliest = new Date(Math.min(...times.map(time => time.getTime())))
    await ctx.prisma.aplusContent.update({ where: { id: item.id }, data: { publishedAt: earliest, status: 'PUBLISHED' } })
    if (item.status !== 'PUBLISHED') published += 1
    item.status = 'PUBLISHED'
  }
  return { checked, published }
}

export async function syncAplus(ctx: ImportContext, api: AplusApi, scope: AplusScope, options: AplusSyncOptions = {}): Promise<AplusSyncResult> {
  const { prisma } = ctx
  const now = options.now ?? new Date()
  const listed = await fetchList(api, options.contentsMax ?? APLUS_LIMITS.syncContentsMax)
  const existing = new Map<string, ExistingRow>()
  for (let start = 0; start < listed.items.length; start += KEY_CHUNK) {
    const rows = await prisma.aplusContent.findMany({
      where: {
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        marketplaceId: APLUS_MARKETPLACE_ID,
        contentReferenceKey: { in: listed.items.slice(start, start + KEY_CHUNK).map(item => item.key) },
      },
      select: { id: true, contentReferenceKey: true, name: true, status: true, publishedAt: true },
    })
    for (const row of rows) if (row.contentReferenceKey) existing.set(row.contentReferenceKey, row)
  }
  const creating = (await prisma.aplusWriteRun.count({ where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, kind: 'CREATE', status: { in: ['QUEUED', 'RUNNING'] } } })) > 0
  const env: Context = { ctx, api, scope, now, creating }

  const result: AplusSyncResult = { imported: 0, created: 0, updated: 0, skippedBusy: 0, skippedInvalid: 0, asinRows: 0, publishAsinsChecked: 0, published: 0, events: 0, truncated: listed.truncated }
  const items: Item[] = []
  for (const entry of listed.items) {
    const outcome = await syncOne(env, entry, existing.get(entry.key))
    if (outcome.kind === 'busy') result.skippedBusy += 1
    else if (outcome.kind === 'invalid') result.skippedInvalid += 1
    else {
      items.push(outcome.item)
      result.asinRows += outcome.asinRows
      if (outcome.created) result.created += 1
      else result.updated += 1
    }
  }
  result.imported = items.length

  const publishing = await syncPublishing(env, items, options.publishAsinsMax ?? APLUS_LIMITS.syncPublishAsinsMax)
  result.publishAsinsChecked = publishing.checked
  result.published = publishing.published

  // 状态变化写审核事件：新内容写当前状态，已有内容状态变了才写；唯一键（内容、状态、时间）冲突的忽略
  const events = items
    .filter(item => item.prev !== item.status)
    .map(item => ({ tenantId: scope.tenantId, contentId: item.id, status: item.status, message: item.status === 'REJECTED' ? item.reason : null, source: 'SYNC', occurredAt: item.updatedAt ?? now }))
  if (events.length > 0) result.events = (await prisma.aplusReviewEvent.createMany({ data: events, skipDuplicates: true })).count

  if (result.truncated) ctx.logger.warn({ ...scope, max: options.contentsMax ?? APLUS_LIMITS.syncContentsMax }, 'aplus contents exceed the sync limit; the rest are not synced')
  if (result.skippedBusy + result.skippedInvalid > 0)
    ctx.logger.warn({ ...scope, busy: result.skippedBusy, invalid: result.skippedInvalid }, 'aplus contents skipped: write in flight, or detail/name/status unusable')
  return result
}
