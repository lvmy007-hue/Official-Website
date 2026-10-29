import { SUPPORT_CONTACTS_PER_CASE_MAX, SUPPORT_ROLE_PENDING, canonicalize } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { Prisma } from '@prisma/client'
import { UpstreamHttpError } from '../../connectors/http-error'
import { SUPPORT_PAGE_SIZE, isRoleMissing, type SupportApi } from '../../connectors/support-api'
import type { ImportContext } from '../../types'
import { parseCases, parseContacts, type ParsedCase } from './parse'

// 支持案件同步器（importers.md I-20，P2b-04）：每 2 小时把亚马逊卖家支持里的案件与沟通记录只读拉下来。
// 规则：
//   - 案件按创建时间从新到旧翻页（每次最多 CASE_PAGES 页、2000 个案件，触到上限标 incomplete，下次继续）；案件没变就不写；
//   - 沟通记录只在“案件更新时间与上次取沟通时不一致”时重取（案件有新沟通会更新它的更新时间），每次最多重取 CONTACT_CASES 个案件（未解决的优先、再按更新时间新到旧），其余留给下一次；
//   - 沟通记录不可变：按（案件，沟通编号）插入、已存在的跳过；
//   - 403（“卖家支持”受限角色未获批）以不可重试的 SUP_ROLE_PENDING 结束，不当作普通同步失败；单个案件的沟通取不到（400、404）跳过该案件，其余错误原样抛出交给任务运行时分类重试；
//   - 不删除案件：亚马逊不再返回的案件保留（历史记录），不当作被删除。

export interface SupportScope {
  tenantId: string
  sellerAccountId: string
}
export interface SupportOptions {
  /** 本次同步的时间（取沟通时间）；测试注入，缺省取当前时间。 */
  now?: Date
  /** 案件翻页上限（页，每页 50 个）。 */
  casePages?: number
  /** 每次重取沟通记录的案件个数上限。 */
  contactCases?: number
}
export interface SupportResult {
  notApplicable: false
  imported: number
  cases: number
  changed: number
  contactCases: number
  contacts: number
  skipped: number
  incomplete: boolean
}

export const CASE_PAGES = 40
export const CONTACT_CASES = 100
const CONTACT_PAGES = Math.ceil(SUPPORT_CONTACTS_PER_CASE_MAX / SUPPORT_PAGE_SIZE)
const ID_CHUNK = 500

/** 403 → SUP_ROLE_PENDING（不可重试）；其余原样抛出。 */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (isRoleMissing(error)) throw new NonRetryableError(SUPPORT_ROLE_PENDING, '亚马逊“卖家支持”受限角色尚未获批，支持案件无法同步')
    throw error
  }
}

const rejectedCase = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && (error.status === 400 || error.status === 404)
const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null)

async function fetchCases(api: SupportApi, pages: number): Promise<{ cases: ParsedCase[]; skipped: number; incomplete: boolean }> {
  const cases: ParsedCase[] = []
  let skipped = 0
  let token: string | undefined
  for (let page = 0; page < pages; page += 1) {
    const parsed = parseCases(await guarded(() => api.listCases(token)))
    cases.push(...parsed.cases)
    skipped += parsed.skipped
    if (!parsed.nextToken) return { cases, skipped, incomplete: false }
    token = parsed.nextToken
  }
  return { cases, skipped, incomplete: true }
}

export async function syncSupportCases(ctx: ImportContext, api: SupportApi, scope: SupportScope, options: SupportOptions = {}): Promise<SupportResult> {
  const { prisma } = ctx
  const now = options.now ?? new Date()
  const fetched = await fetchCases(api, options.casePages ?? CASE_PAGES)
  // 同一个案件编号在翻页期间可能重复出现（案件在两次取页之间更新）：以后出现的为准
  const byId = new Map(fetched.cases.map(item => [item.caseId, item]))
  const parsed = [...byId.values()]

  const existing = new Map<
    string,
    { id: string; status: string; amazonUpdatedAt: Date; amazonResolvedAt: Date | null; lastOutboundAt: Date | null; appointmentsJson: unknown; contactsForUpdatedAt: Date | null; subject: string }
  >()
  for (let start = 0; start < parsed.length; start += ID_CHUNK) {
    const rows = await prisma.supportCase.findMany({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, caseId: { in: parsed.slice(start, start + ID_CHUNK).map(item => item.caseId) } },
      select: { id: true, caseId: true, status: true, subject: true, amazonUpdatedAt: true, amazonResolvedAt: true, lastOutboundAt: true, appointmentsJson: true, contactsForUpdatedAt: true },
    })
    for (const row of rows) existing.set(row.caseId, row)
  }

  let changed = 0
  const stale: Array<{ item: ParsedCase; rowId: string }> = []
  for (const item of parsed) {
    const before = existing.get(item.caseId)
    const data = {
      subject: item.subject,
      status: item.status,
      amazonCreatedAt: item.createdAt,
      amazonUpdatedAt: item.updatedAt,
      amazonResolvedAt: item.resolvedAt,
      lastOutboundAt: item.lastOutboundAt,
      appointmentsJson: item.appointments as unknown as Prisma.InputJsonValue,
      syncedAt: now,
    }
    if (!before) {
      const created = await prisma.supportCase.create({ data: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, caseId: item.caseId, ...data }, select: { id: true } })
      changed += 1
      stale.push({ item, rowId: created.id })
      continue
    }
    const unchanged =
      before.subject === item.subject &&
      before.status === item.status &&
      sameTime(before.amazonUpdatedAt, item.updatedAt) &&
      sameTime(before.amazonResolvedAt, item.resolvedAt) &&
      sameTime(before.lastOutboundAt, item.lastOutboundAt) &&
      canonicalize(before.appointmentsJson) === canonicalize(item.appointments) // jsonb 会重排键，不能直接比较序列化结果
    if (!unchanged) {
      await prisma.supportCase.update({ where: { id: before.id }, data })
      changed += 1
    }
    if (!sameTime(before.contactsForUpdatedAt, item.updatedAt)) stale.push({ item, rowId: before.id })
  }

  // 沟通记录：未解决的案件优先，再按更新时间新到旧；每次只重取一部分
  stale.sort((a, b) => Number(a.item.status === 'RESOLVED') - Number(b.item.status === 'RESOLVED') || b.item.updatedAt.getTime() - a.item.updatedAt.getTime())
  const batch = stale.slice(0, options.contactCases ?? CONTACT_CASES)
  let contacts = 0
  let skipped = fetched.skipped
  let contactCases = 0
  for (const { item, rowId } of batch) {
    const synced = await syncContacts(ctx, api, scope, item, rowId, now)
    if (synced === null) {
      skipped += 1
      continue
    }
    contactCases += 1
    contacts += synced
  }
  const incomplete = fetched.incomplete || stale.length > batch.length
  if (skipped > 0) ctx.logger.warn({ ...scope, skipped }, 'support rows skipped: missing required fields or contacts unavailable')
  if (incomplete) ctx.logger.warn({ ...scope }, 'support sync reached the page or contact limit; remaining rows are picked up by the next sync')
  return { notApplicable: false, imported: parsed.length + contacts, cases: parsed.length, changed, contactCases, contacts, skipped, incomplete }
}

/** 取一个案件的全部沟通记录并写入；返回新写入的条数，取不到（400、404）返回 null。 */
async function syncContacts(ctx: ImportContext, api: SupportApi, scope: SupportScope, item: ParsedCase, rowId: string, now: Date): Promise<number | null> {
  const { prisma } = ctx
  let written = 0
  let token: string | undefined
  try {
    for (let page = 0; page < CONTACT_PAGES; page += 1) {
      const parsed = parseContacts(await guarded(() => api.listContacts(item.caseId, token)))
      if (parsed.contacts.length > 0) {
        const result = await prisma.supportContact.createMany({
          skipDuplicates: true,
          data: parsed.contacts.map(contact => ({
            tenantId: scope.tenantId,
            sellerAccountId: scope.sellerAccountId,
            supportCaseId: rowId,
            contactId: contact.contactId,
            channel: contact.channel,
            direction: contact.direction,
            senderName: contact.senderName,
            body: contact.body,
            attachmentsJson: contact.attachments as unknown as Prisma.InputJsonValue,
            occurredAt: contact.occurredAt,
          })),
        })
        written += result.count
      }
      if (!parsed.nextToken) break
      token = parsed.nextToken
    }
  } catch (error) {
    if (rejectedCase(error)) return null
    throw error
  }
  const total = await prisma.supportContact.count({ where: { tenantId: scope.tenantId, supportCaseId: rowId } })
  await prisma.supportCase.update({ where: { id: rowId }, data: { contactsForUpdatedAt: item.updatedAt, contactCount: total, syncedAt: now } })
  return written
}
