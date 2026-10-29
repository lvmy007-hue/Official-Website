import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADS_REPORT_TEMPLATE_KEYS, REPORT_CATALOG } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { parseReportRow } from '../ads-reports/rows'
import { writeReportRow } from '../ads-reports/writers'
import { reportImporterFor } from '../connectors/report-import'
import { clearDataKioskDatasetsForTest, dataKioskDatasetFor } from '../datakiosk/registry'
import { registerDataKioskDatasets } from '../datakiosk/register'

// P5-03 验收：报表中心里能创建（或登记）的每种报告与数据集，都有导入器；代码里不存在“导入器未实现”的分支。
// 目录在 packages/api-contracts 的 report-center.ts；这里逐项核对它与三处真实注册表（报告导入器、广告模板写库、数据中心数据集注册表）一致。

describe('报表中心目录与导入器', () => {
  it('亚马逊报告：目录里每一种报告类型都能找到导入器', () => {
    const entries = REPORT_CATALOG.filter(item => item.source === 'SP_API')
    expect(entries.length).toBeGreaterThan(30)
    for (const entry of entries) {
      const importer = reportImporterFor({ id: 'rj', reportType: entry.key, documentId: null, sellerAccountId: 'sa1' }, { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: 'ATVPDKIKX0DER' })
      expect(typeof importer, entry.key).toBe('function')
    }
  })

  it('不在目录里的报告类型：明确拒绝，错误码是“未登记”而不是“未实现”', () => {
    const scope = { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: 'ATVPDKIKX0DER' }
    const codeOf = (reportType: string) => {
      try {
        reportImporterFor({ reportType, documentId: null, sellerAccountId: 'sa1' }, scope)
      } catch (error) {
        return (error as { code?: string }).code
      }
      return undefined
    }
    expect(codeOf('GET_SOME_NEW_REPORT')).toBe('REPORT_TYPE_NOT_REGISTERED')
    // 以前订单类型是“名字里带 ORDERS 就算”，现在只认两种订单报告
    expect(codeOf('GET_FLAT_FILE_OPEN_LISTINGS_ORDERS')).toBe('REPORT_TYPE_NOT_REGISTERED')
  })

  it('数据中心：目录里每个数据集都已在注册表登记', () => {
    clearDataKioskDatasetsForTest()
    registerDataKioskDatasets()
    const entries = REPORT_CATALOG.filter(item => item.source === 'DATA_KIOSK')
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(dataKioskDatasetFor(entry.key), entry.key).toBeDefined()
  })

  it('广告：目录里每个模板都能解析一行并写库，没有落空的分支', async () => {
    const entries = REPORT_CATALOG.filter(item => item.source === 'ADS')
    expect(entries.map(item => item.key).sort()).toEqual([...ADS_REPORT_TEMPLATE_KEYS].sort())
    const sample = {
      date: '2026-10-01',
      hour: '2026-10-01T05:00:00Z',
      campaignId: 'C1',
      adGroupId: 'G1',
      targetId: 'T1',
      keyword: 'kw',
      matchType: 'EXACT',
      searchTerm: 'term',
      placement: 'Top of Search on-Amazon',
      advertisedAsin: 'B0ADVERTISE',
      purchasedAsin: 'B0PURCHASED',
      impressions: 100,
      clicks: 10,
      cost: 12.5,
      sales: 40,
      purchases: 2,
      units: 3,
    }
    for (const key of ADS_REPORT_TEMPLATE_KEYS) {
      const calls: string[] = []
      const prisma = recordingPrisma(calls)
      const parsed = parseReportRow(key, sample)
      expect('skipped' in parsed ? parsed.skipped : null, key).toBeNull()
      if ('skipped' in parsed) continue
      await writeReportRow(
        prisma,
        { tenantId: 't1', adsProfileId: 'p1', adsAccountId: 'a1', jobId: 'j1', adProduct: 'SPONSORED_PRODUCTS', currency: 'USD', now: new Date('2026-10-02T00:00:00Z') },
        key,
        parsed,
      )
      expect(calls.length, key).toBeGreaterThan(0)
    }
  })

  it('代码里不存在“导入器未实现”的分支', () => {
    const roots = [fileURLToPath(new URL('..', import.meta.url)), fileURLToPath(new URL('../../../api/src', import.meta.url))]
    const hits = roots.flatMap(root => sourceFiles(root)).filter(file => /IMPORTER_NOT_IMPLEMENTED|导入器未实现/.test(readFileSync(file, 'utf8')))
    expect(hits).toEqual([])
  })
})

/** 记录所有写库调用的假客户端：任何表、任何方法都接受，返回空结果。 */
function recordingPrisma(calls: string[]): PrismaClient {
  const method = (name: string) =>
    new Proxy(function () {}, {
      apply: () => {
        calls.push(name)
        return Promise.resolve({})
      },
    })
  return new Proxy(
    {},
    {
      get: (_target, table: string) => {
        if (table === 'then') return undefined
        if (table.startsWith('$')) return method(table)
        return new Proxy({}, { get: (_t, op: string) => (op === 'then' ? undefined : method(`${table}.${op}`)) })
      },
    },
  ) as PrismaClient
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
