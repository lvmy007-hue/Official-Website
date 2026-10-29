import type { PrismaClient } from '@prisma/client'
import type { EntityTable } from './map'

// 广告实体落库用到的本地表的配置（P5-12A）：写入与归档共用，避免每张表各写一套查询。

export type TableName = EntityTable | 'portfolios'
export type Row = Record<string, unknown> & { id: string }

/** 这些表的 Prisma 访问器（只用到下面几个方法；用结构类型避免给每张表写一套泛型）。 */
export type Delegate = {
  count(args: { where: Record<string, unknown> }): Promise<number>
  findMany(args: { where: Record<string, unknown>; select?: Record<string, true>; orderBy?: Record<string, string>; take?: number }): Promise<Row[]>
  createMany(args: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }): Promise<{ count: number }>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>
}

export type TableConfig = {
  model: 'adsCampaign' | 'adsAdGroup' | 'adsAd' | 'adsKeyword' | 'adsTarget' | 'adsNegativeTarget' | 'adsPortfolio'
  /** 活动按广告档案取（旧接口同步的活动没有账户编号）；其余按广告账户取。 */
  scope: 'profile' | 'account'
  /** 组成行键的列（行键 = 各列值用 | 连接）；第一列是亚马逊给的对象编号。 */
  keyCols: readonly string[]
  /** 状态列；没有状态列的表（否定投放）归档时删除本地行。 */
  stateCol: 'state' | 'status' | null
  label: string
}

export const TABLES: Record<TableName, TableConfig> = {
  campaigns: { model: 'adsCampaign', scope: 'profile', keyCols: ['externalCampaignId', 'adProduct'], stateCol: 'state', label: '广告活动' },
  adGroups: { model: 'adsAdGroup', scope: 'account', keyCols: ['adGroupId'], stateCol: 'state', label: '广告组' },
  ads: { model: 'adsAd', scope: 'account', keyCols: ['adId'], stateCol: 'state', label: '广告' },
  keywords: { model: 'adsKeyword', scope: 'account', keyCols: ['keywordId'], stateCol: 'state', label: '关键词' },
  targets: { model: 'adsTarget', scope: 'account', keyCols: ['targetId'], stateCol: 'state', label: '投放对象' },
  negatives: { model: 'adsNegativeTarget', scope: 'account', keyCols: ['negativeId'], stateCol: null, label: '否定投放' },
  portfolios: { model: 'adsPortfolio', scope: 'account', keyCols: ['portfolioId'], stateCol: 'status', label: '广告组合' },
}

export type Scope = { tenantId: string; adsProfileId: string; adsAccountId: string; currency: string; now: Date }

export const delegateOf = (db: PrismaClient, table: TableName): Delegate => db[TABLES[table].model] as unknown as Delegate
export const keyOf = (table: TableName, row: Record<string, unknown>) => TABLES[table].keyCols.map(column => String(row[column] ?? '')).join('|')
/** 租户与归属条件：所有读写都带它，不依赖调用方记得加。 */
export const scopeWhere = (table: TableName, scope: Scope): Record<string, unknown> =>
  TABLES[table].scope === 'profile' ? { tenantId: scope.tenantId, adsProfileId: scope.adsProfileId } : { tenantId: scope.tenantId, adsAccountId: scope.adsAccountId }
