import type { AdsChangeEntityType } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 变更识别要读的广告实体（P3-14）：一个广告档案下某一类对象的“用户可改的字段”，按系统编号翻页。
// 只读已经同步入库的实体；追踪哪些字段由契约 `ADS_CHANGE_FIELDS` 决定（这里的 select 要覆盖它列出的全部字段）。

export interface EntityRow {
  /** 对象的系统编号（不是亚马逊外部编号）。 */
  id: string
  label: string
  /** 这一行第一次进入本系统数据库的时间（用来区分“初始同步带来的”与“后来新出现的”）。 */
  createdAt: Date
  values: Record<string, unknown>
}

export interface EntityPage {
  tenantId: string
  adsProfileId: string
  /** 上一页最后一个系统编号；第一页为 null。 */
  after: string | null
  take: number
}

const where = (page: EntityPage) => ({ tenantId: page.tenantId, adsProfileId: page.adsProfileId, ...(page.after ? { id: { gt: page.after } } : {}) })
const order = { id: 'asc' } as const

type Loader = (db: PrismaClient, page: EntityPage) => Promise<EntityRow[]>

export const ENTITY_LOADERS: Record<AdsChangeEntityType, Loader> = {
  CAMPAIGN: async (db, page) =>
    (
      await db.adsCampaign.findMany({
        where: where(page),
        select: { id: true, createdAt: true, name: true, state: true, budget: true, bidStrategy: true, portfolioId: true, startDate: true, endDate: true },
        orderBy: order,
        take: page.take,
      })
    ).map(row => ({ id: row.id, label: row.name, createdAt: row.createdAt, values: row })),
  AD_GROUP: async (db, page) =>
    (await db.adsAdGroup.findMany({ where: where(page), select: { id: true, createdAt: true, name: true, state: true, defaultBid: true }, orderBy: order, take: page.take })).map(row => ({
      id: row.id,
      label: row.name,
      createdAt: row.createdAt,
      values: row,
    })),
  TARGET: async (db, page) =>
    (await db.adsTarget.findMany({ where: where(page), select: { id: true, createdAt: true, expression: true, matchType: true, bid: true, state: true }, orderBy: order, take: page.take })).map(
      row => ({
        id: row.id,
        label: row.expression,
        createdAt: row.createdAt,
        values: row,
      }),
    ),
  KEYWORD: async (db, page) =>
    (await db.adsKeyword.findMany({ where: where(page), select: { id: true, createdAt: true, text: true, matchType: true, bid: true, state: true }, orderBy: order, take: page.take })).map(row => ({
      id: row.id,
      label: row.text,
      createdAt: row.createdAt,
      values: row,
    })),
  PORTFOLIO: async (db, page) =>
    (
      await db.adsPortfolio.findMany({
        where: where(page),
        select: { id: true, createdAt: true, name: true, budgetCap: true, budgetPeriod: true, budgetStart: true, budgetEnd: true, status: true },
        orderBy: order,
        take: page.take,
      })
    ).map(row => ({ id: row.id, label: row.name, createdAt: row.createdAt, values: row })),
}
