import type { Client } from 'pg'

// 索引评审工具（P1-27）：新增列表、汇总类查询时，在测试里用它证明查询能走索引。
// 做法：关闭顺序扫描后查看执行计划。数据量很小时优化器本来就会选顺序扫描，所以这里不比较速度，
// 而是确认“存在可用的索引”——关闭顺序扫描后仍出现 Seq Scan，就说明没有任何索引能服务这条查询。

export interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

export interface IndexReview {
  indexes: string[]
  seqScans: string[]
}

function collect(node: PlanNode, review: IndexReview) {
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) review.seqScans.push(node['Relation Name'])
  if (node['Index Name']) review.indexes.push(node['Index Name'])
  for (const child of node.Plans ?? []) collect(child, review)
}

/** 在事务内关闭顺序扫描后取执行计划，返回用到的索引与仍然出现的顺序扫描。只用于 SELECT 语句。 */
export async function reviewQueryIndexes(client: Client, sql: string, params: unknown[] = []): Promise<IndexReview> {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('index review only accepts SELECT statements')
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL enable_seqscan = off')
    const { rows } = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${sql}`, params)
    const review: IndexReview = { indexes: [], seqScans: [] }
    collect(rows[0]['QUERY PLAN'][0].Plan, review)
    review.indexes = [...new Set(review.indexes)]
    return review
  } finally {
    await client.query('ROLLBACK')
  }
}

/** 断言查询只通过索引读取数据；allowSeqScan 里的小表（配置类，行数很少）可以例外。 */
export async function expectIndexedQuery(client: Client, sql: string, params: unknown[] = [], options: { allowSeqScan?: string[] } = {}): Promise<IndexReview> {
  const review = await reviewQueryIndexes(client, sql, params)
  const allowed = new Set(options.allowSeqScan ?? [])
  const unindexed = review.seqScans.filter(table => !allowed.has(table))
  if (unindexed.length > 0) throw new Error(`query has no usable index on: ${[...new Set(unindexed)].join(', ')}`)
  if (review.indexes.length === 0) throw new Error('query plan uses no index at all')
  return review
}
