// 数据库分区维护（P1-27）：每日提前续建分区，并监控默认分区是否有异常数据。
// 只依赖最小的查询接口，便于单元测试；不含任何租户数据，日志只输出表名与行数。

export interface RawQueryRunner {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>
}

export interface MaintenanceLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
}

export const PARTITION_MONTHS_AHEAD = 3
export const PARTITION_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface PartitionMaintenanceResult {
  created: Array<{ table: string; count: number }>
  defaultPartitionRows: Array<{ table: string; rows: number }>
}

export async function maintainPartitions(db: RawQueryRunner, logger: MaintenanceLogger, monthsAhead = PARTITION_MONTHS_AHEAD): Promise<PartitionMaintenanceResult> {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 1 || monthsAhead > 24) throw new Error('monthsAhead must be an integer between 1 and 24')

  const createdRows = await db.$queryRawUnsafe<Array<{ parent_table: string; created_count: number | bigint }>>(
    'SELECT parent_table, created_count FROM nova_ensure_all_partitions($1::int)',
    monthsAhead,
  )
  const created = createdRows.map(row => ({ table: row.parent_table, count: Number(row.created_count) }))
  const totalCreated = created.reduce((sum, row) => sum + row.count, 0)
  if (totalCreated > 0) logger.info({ event: 'partitions_created', total: totalCreated, tables: created.filter(row => row.count > 0) }, 'database partitions created ahead of time')

  const defaultRows = await db.$queryRawUnsafe<Array<{ parent_table: string; row_count: number | bigint }>>('SELECT parent_table, row_count FROM nova_default_partition_rows()')
  const defaultPartitionRows = defaultRows.map(row => ({ table: row.parent_table, rows: Number(row.row_count) })).filter(row => row.rows > 0)
  // 默认分区出现数据说明有记录的时间超出了已建分区范围，需要人工核对来源日期是否异常。
  if (defaultPartitionRows.length > 0) logger.warn({ event: 'default_partition_has_rows', tables: defaultPartitionRows }, 'default partition contains rows, source dates need review')

  return { created, defaultPartitionRows }
}
