import { describe, expect, it, vi } from 'vitest'
import { maintainPartitions, type RawQueryRunner } from './maintenance'

function fakeDb(created: Array<{ parent_table: string; created_count: number | bigint }>, defaults: Array<{ parent_table: string; row_count: number | bigint }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const db: RawQueryRunner = {
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]) {
      calls.push({ sql, values })
      return (sql.includes('nova_ensure_all_partitions') ? created : defaults) as T
    },
  }
  return { db, calls }
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() })

describe('分区维护任务', () => {
  it('提前续建分区，并把 bigint 计数转为数字', async () => {
    const { db, calls } = fakeDb(
      [
        { parent_table: 'Order', created_count: 1n },
        { parent_table: 'AuditEvent', created_count: 0 },
      ],
      [],
    )
    const log = logger()
    const result = await maintainPartitions(db, log)
    expect(result.created).toEqual([
      { table: 'Order', count: 1 },
      { table: 'AuditEvent', count: 0 },
    ])
    expect(calls[0].values).toEqual([3])
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('没有新建分区时不输出日志', async () => {
    const { db } = fakeDb([{ parent_table: 'Order', created_count: 0 }], [])
    const log = logger()
    await maintainPartitions(db, log)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('默认分区出现数据时告警，且只列出有数据的表', async () => {
    const { db } = fakeDb(
      [],
      [
        { parent_table: 'Order', row_count: 0n },
        { parent_table: 'FinanceEvent', row_count: 7n },
      ],
    )
    const log = logger()
    const result = await maintainPartitions(db, log)
    expect(result.defaultPartitionRows).toEqual([{ table: 'FinanceEvent', rows: 7 }])
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'default_partition_has_rows' }), expect.any(String))
  })

  it('提前月数不合法时拒绝执行', async () => {
    const { db, calls } = fakeDb([], [])
    await expect(maintainPartitions(db, logger(), 0)).rejects.toThrow()
    await expect(maintainPartitions(db, logger(), 25)).rejects.toThrow()
    await expect(maintainPartitions(db, logger(), 1.5)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
