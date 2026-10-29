import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SUPPORT_ROLE_PENDING } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { SupportApi } from '../../connectors/support-api'
import type { ImportContext } from '../../types'
import { parseCases, parseContacts } from './parse'
import { syncSupportCases } from './sync'

// 支持案件同步器（I-20，P2b-04）：官方格式样例（apps/worker/fixtures/support）→ 解析、写入、幂等、沟通记录只在案件更新后重取、受限角色没批与各种上限。

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../fixtures/support', name), 'utf8')) as Record<string, unknown>
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const NOW = new Date('2026-10-25T08:00:00Z')
const http = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, undefined, 'api')

type CaseRow = Record<string, unknown> & { id: string; caseId: string }

/** 内存里的两张表：只实现同步器用到的几个方法。 */
function memory() {
  const cases: CaseRow[] = []
  const contacts: Array<Record<string, unknown>> = []
  const writes = { created: 0, updated: 0 }
  const supportCase = {
    findMany: vi.fn(async (args: { where: { caseId: { in: string[] } } }) => cases.filter(row => args.where.caseId.in.includes(row.caseId))),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      writes.created += 1
      const row = { id: `row-${cases.length + 1}`, contactsForUpdatedAt: null, contactCount: 0, ...args.data } as CaseRow
      cases.push(row)
      return { id: row.id }
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      writes.updated += 1
      Object.assign(
        cases.find(row => row.id === args.where.id)!,
        args.data,
      )
      return {}
    }),
  }
  const supportContact = {
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      let count = 0
      for (const item of args.data) {
        if (contacts.some(row => row.supportCaseId === item.supportCaseId && row.contactId === item.contactId)) continue
        contacts.push(item)
        count += 1
      }
      return { count }
    }),
    count: vi.fn(async (args: { where: { supportCaseId: string } }) => contacts.filter(row => row.supportCaseId === args.where.supportCaseId).length),
  }
  const warn = vi.fn()
  const ctx: ImportContext = { prisma: { supportCase, supportContact } as unknown as PrismaClient, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  return { ctx, cases, contacts, writes, supportContact, warn }
}

const apiOf = (listCases: () => Promise<unknown>, listContacts: (caseId: string) => Promise<unknown>) =>
  ({ listCases: vi.fn(listCases), listContacts: vi.fn(listContacts) }) as unknown as SupportApi & { listCases: ReturnType<typeof vi.fn>; listContacts: ReturnType<typeof vi.fn> }

const firstPage = () => ({ ...fixture('cases.json'), nextToken: undefined })

describe('响应解析', () => {
  it('案件：必填字段缺失的行跳过计数；状态转大写；没有主题写默认；不带邮箱与电话号码；预约只留时间窗', () => {
    const { cases, skipped, nextToken } = parseCases(fixture('cases.json'))
    expect(skipped).toBe(1)
    expect(nextToken).toBe('NEXT-PAGE-TOKEN')
    expect(cases.map(item => item.caseId)).toEqual(['9876543210', '9876543211'])
    expect(cases[1]).toMatchObject({ status: 'RESOLVED', subject: '（无主题）' })
    expect(cases[0].appointments).toEqual([{ appointmentId: 'apt-1', status: 'SCHEDULED', earliestAt: '2026-10-25T01:00:00.000Z', latestAt: '2026-10-25T02:00:00.000Z', answeringParty: 'AMAZON' }])
    expect(JSON.stringify(cases)).not.toMatch(/example\.com|555 0100/)
  })

  it('沟通：邮件按发送方判断方向；电话取备注；聊天拼接事件；附件只留名称；缺创建时间的跳过', () => {
    const { contacts, skipped } = parseContacts(fixture('contacts.json'))
    expect(skipped).toBe(1)
    expect(contacts.map(item => [item.contactId, item.direction])).toEqual([
      ['ct-1', 'FROM_AMAZON'],
      ['ct-2', 'FROM_SELLER'],
      ['ct-3', 'UNKNOWN'],
      ['ct-4', 'UNKNOWN'],
    ])
    expect(contacts[0]).toMatchObject({ body: '请提供入库证据。', attachments: ['照片.png'] })
    expect(contacts[3].body).toBe('客服：您好\n我方：你好')
    expect(JSON.stringify(contacts)).not.toContain('expires-in-15-min')
  })

  it('亚马逊新增的渠道：保留这条沟通，正文为空，不丢', () => {
    const { contacts } = parseContacts({ contacts: [{ contactId: 'x', channel: 'SMS', createdDate: '2026-10-21T07:00:00Z' }] })
    expect(contacts).toEqual([expect.objectContaining({ contactId: 'x', channel: 'SMS', body: '', direction: 'UNKNOWN' })])
  })
})

describe('同步', () => {
  it('第一次：写入案件与沟通；沟通条数、取沟通时对应的案件更新时间都记下来', async () => {
    const db = memory()
    const api = apiOf(
      async () => firstPage(),
      async () => fixture('contacts.json'),
    )
    const result = await syncSupportCases(db.ctx, api, scope, { now: NOW })
    expect(result).toMatchObject({ cases: 2, changed: 2, contactCases: 2, contacts: 8, skipped: 1, incomplete: false })
    expect(db.cases.map(row => row.contactCount)).toEqual([4, 4])
    expect(db.cases[0].contactsForUpdatedAt).toEqual(new Date('2026-10-22T05:00:00Z'))
    expect(db.cases[0].subject).toBe('货件 FBA15ABCDE 少收 12 件')
  })

  it('第二次、亚马逊没有变化：不写案件、不再取沟通（jsonb 键序不同也算没变）', async () => {
    const db = memory()
    const api = apiOf(
      async () => firstPage(),
      async () => fixture('contacts.json'),
    )
    await syncSupportCases(db.ctx, api, scope, { now: NOW })
    // 模拟数据库里 jsonb 把键重排
    db.cases[0].appointmentsJson = (db.cases[0].appointmentsJson as Array<Record<string, unknown>>).map(item => Object.fromEntries(Object.entries(item).reverse()))
    api.listContacts.mockClear()
    const updatedBefore = db.writes.updated
    const again = await syncSupportCases(db.ctx, api, scope, { now: NOW })
    expect(again).toMatchObject({ changed: 0, contactCases: 0, contacts: 0 })
    expect(api.listContacts).not.toHaveBeenCalled()
    expect(db.writes.updated).toBe(updatedBefore)
    expect(db.writes.created).toBe(2)
  })

  it('案件有更新：更新案件并重取沟通，已有的沟通不重复写', async () => {
    const db = memory()
    const api = apiOf(
      async () => firstPage(),
      async () => fixture('contacts.json'),
    )
    await syncSupportCases(db.ctx, api, scope, { now: NOW })
    const changed = firstPage() as { cases: Array<Record<string, unknown>> }
    changed.cases[0] = { ...changed.cases[0], lastUpdatedDate: '2026-10-24T05:00:00Z', status: 'PENDING_MERCHANT_ACTION' }
    api.listCases.mockResolvedValue(changed)
    api.listContacts.mockClear()
    const again = await syncSupportCases(db.ctx, api, scope, { now: NOW })
    expect(again).toMatchObject({ changed: 1, contactCases: 1, contacts: 0 })
    expect(api.listContacts).toHaveBeenCalledTimes(1)
    expect(db.cases[0]).toMatchObject({ status: 'PENDING_MERCHANT_ACTION', contactsForUpdatedAt: new Date('2026-10-24T05:00:00Z'), contactCount: 4 })
    expect(db.contacts).toHaveLength(8)
  })

  it('受限角色没批（403）：以不可重试的 SUP_ROLE_PENDING 结束，一行都不写', async () => {
    const db = memory()
    const api = apiOf(
      async () => {
        throw http(403)
      },
      async () => ({}),
    )
    await expect(syncSupportCases(db.ctx, api, scope, { now: NOW })).rejects.toMatchObject({ code: SUPPORT_ROLE_PENDING })
    expect(db.cases).toEqual([])
  })

  it('某个案件的沟通取不到（404）：跳过并计数，案件本身保留且不记已同步；其他错误原样抛出', async () => {
    const db = memory()
    const api = apiOf(
      async () => firstPage(),
      async (caseId: string) => {
        if (caseId === '9876543210') throw http(404)
        return fixture('contacts.json')
      },
    )
    const result = await syncSupportCases(db.ctx, api, scope, { now: NOW })
    expect(result).toMatchObject({ cases: 2, contactCases: 1, skipped: 2 })
    expect(db.cases[0].contactsForUpdatedAt).toBeNull()
    const broken = apiOf(
      async () => firstPage(),
      async () => {
        throw http(500)
      },
    )
    await expect(syncSupportCases(memory().ctx, broken, scope, { now: NOW })).rejects.toMatchObject({ status: 500 })
  })

  it('每次最多重取指定个数的案件沟通：未解决的优先，剩下的标 incomplete 留给下一次', async () => {
    const db = memory()
    const api = apiOf(
      async () => firstPage(),
      async () => fixture('contacts.json'),
    )
    const result = await syncSupportCases(db.ctx, api, scope, { now: NOW, contactCases: 1 })
    expect(result).toMatchObject({ contactCases: 1, incomplete: true })
    expect(api.listContacts).toHaveBeenCalledWith('9876543210', undefined) // 未解决的先取，已解决的后取
    expect(db.warn).toHaveBeenCalled()
  })

  it('案件翻页触到上限：标 incomplete，不无限翻页', async () => {
    const db = memory()
    const api = apiOf(
      async () => fixture('cases.json'),
      async () => ({ contacts: [] }),
    )
    const result = await syncSupportCases(db.ctx, api, scope, { now: NOW, casePages: 2 })
    expect(api.listCases).toHaveBeenCalledTimes(2)
    expect(result.incomplete).toBe(true)
    expect(result.cases).toBe(2) // 两页里同一个案件编号只算一个
  })
})
