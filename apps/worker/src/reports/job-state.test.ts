import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { amazonStageOf, capturingColumns, eventsOf, failedData, importWarnings, statsData, withEvent } from './job-state'

const NOW = new Date('2026-10-25T08:00:00Z')

async function* rowsOf(...rows: Array<Record<string, unknown>>) {
  for (const row of rows) yield row
}

describe('报告任务的时间线', () => {
  it('追加事件；同一阶段同一文字不重复记，格式不对的旧数据丢弃', () => {
    const first = withEvent(null, 'SUBMITTED', '亚马逊报告编号 1', NOW)
    expect(eventsOf(first)).toEqual([{ at: NOW.toISOString(), stage: 'SUBMITTED', text: '亚马逊报告编号 1' }])
    const again = withEvent(first, 'SUBMITTED', '亚马逊报告编号 1', NOW)
    expect(eventsOf(again)).toHaveLength(1)
    const next = withEvent(first, 'AMAZON_PROCESSING', undefined, NOW)
    expect(eventsOf(next).map(item => item.stage)).toEqual(['SUBMITTED', 'AMAZON_PROCESSING'])
    expect(eventsOf([{ at: 1 }, null, 'x', { at: 'a', stage: 'NOPE' }])).toEqual([])
  })

  it('只保留最近 40 条', () => {
    let value: unknown = null
    for (let index = 0; index < 60; index += 1) value = withEvent(value, index % 2 ? 'AMAZON_QUEUED' : 'AMAZON_PROCESSING', `第 ${index} 次`, NOW)
    expect(eventsOf(value)).toHaveLength(40)
    expect(eventsOf(value)[39]?.text).toBe('第 59 次')
  })

  it('亚马逊处理状态映射；失败类状态不映射', () => {
    expect(amazonStageOf('in_queue')).toBe('AMAZON_QUEUED')
    expect(amazonStageOf('IN_PROGRESS')).toBe('AMAZON_PROCESSING')
    expect(amazonStageOf('DONE')).toBe('AMAZON_DONE')
    expect(amazonStageOf('FATAL')).toBeNull()
  })
})

describe('导入统计与失败字段', () => {
  it('没有给出跳过行数的导入器写空，不写 0', () => {
    expect(statsData({ read: 10, imported: 9 })).toEqual({ readRows: 10, importedRows: 9, skippedRows: null, columnsJson: [] })
    expect(statsData({ read: 10, imported: 9, skipped: 1, columns: ['a', 'b'] })).toMatchObject({ skippedRows: 1, columnsJson: ['a', 'b'] })
  })

  it('失败字段：状态、失败码、结束时间；没给说明时不覆盖原有说明', () => {
    const data = failedData('REPORT_FATAL', undefined, NOW)
    expect(data).toMatchObject({ status: 'FAILED', failureCode: 'REPORT_FATAL', finishedAt: NOW })
    expect('failureMessage' in data).toBe(false)
    expect(failedData('X', '说明', NOW)).toMatchObject({ failureMessage: '说明' })
  })

  it('读到第一行时交出字段名，行本身原样往下传', async () => {
    let columns: string[] = []
    const out: unknown[] = []
    for await (const row of capturingColumns(rowsOf({ a: 1, b: 2 }, { c: 3 }), found => (columns = found))) out.push(row)
    expect(columns).toEqual(['a', 'b'])
    expect(out).toHaveLength(2)
  })
})

describe('字段变化警告', () => {
  const job = { id: 'rj2', tenantId: 't1', sellerAccountId: 'sa1', reportType: 'GET_X' }
  const prismaWith = (previous: Array<{ columnsJson: unknown }>) => ({ fbaReportJob: { findMany: vi.fn(async () => previous) } }) as unknown as PrismaClient

  it('与上一份成功的同类报告对比：新出现与消失的字段', async () => {
    const warnings = await importWarnings(prismaWith([{ columnsJson: ['a', 'b'] }]), job, ['a', 'c'])
    expect(warnings.map(item => item.code).sort()).toEqual(['MISSING_COLUMN', 'NEW_COLUMN'])
    expect(warnings.find(item => item.code === 'NEW_COLUMN')?.message).toContain('c')
    expect(warnings.find(item => item.code === 'MISSING_COLUMN')?.message).toContain('b')
  })

  it('上一份没有留存字段名（旧任务）或这份没读到字段：不产生警告', async () => {
    expect(await importWarnings(prismaWith([{ columnsJson: null }]), job, ['a'])).toEqual([])
    const prisma = prismaWith([{ columnsJson: ['a'] }])
    expect(await importWarnings(prisma, job, [])).toEqual([])
    expect(prisma.fbaReportJob.findMany).not.toHaveBeenCalled()
  })
})
