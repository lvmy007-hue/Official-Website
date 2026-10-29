import {
  COUPON_REPORT_TYPE,
  LISTING_FYP_REPORT_TYPE,
  FBA_FEE_ESTIMATE_REPORT_TYPE,
  PROMOTION_REPORT_TYPE,
  REFERRAL_FEE_PREVIEW_REPORT_TYPE,
  REIMBURSEMENT_REPORT_TYPE,
  REPORT_FRESHNESS_SOURCES,
  RETURNS_REPORT_TYPE,
  SALES_TRAFFIC_REPORT_TYPE,
  SELLER_PERFORMANCE_REPORT_TYPE,
  freshnessSourceOfReport,
} from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { BRAND_REPORT_TYPES } from '../brand/registry'
import { reportImporterFor } from '../../connectors/report-import'
import { localDay } from '../shared'
import { FULFILLMENT_REPORT_TYPES } from '../orders/fulfillment-reports'
import { fakeContext, rowsOf, tsv } from './fake-context.test-helper'
import { INVENTORY_REPORT_TYPES, inventoryImporterFor } from './registry'

const scope = { tenantId: 't1', sellerAccountId: 'sa1', snapshotDate: new Date('2026-10-22T00:00:00Z') }

describe('库存类报告注册', () => {
  it('每个库存与费用类报告类型都有导入器；不属于本域的类型返回空', () => {
    for (const type of INVENTORY_REPORT_TYPES) expect(inventoryImporterFor(type, scope, 'ATVPDKIKX0DER'), type).toBeTypeOf('function')
    expect(inventoryImporterFor('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', scope, 'ATVPDKIKX0DER')).toBeNull()
  })

  it('导入器类型与新鲜度来源一一对应：每种报告落到各自的 rpt.* 来源键', () => {
    expect(
      [
        ...INVENTORY_REPORT_TYPES,
        ...FULFILLMENT_REPORT_TYPES,
        RETURNS_REPORT_TYPE,
        REIMBURSEMENT_REPORT_TYPE,
        FBA_FEE_ESTIMATE_REPORT_TYPE,
        REFERRAL_FEE_PREVIEW_REPORT_TYPE,
        SALES_TRAFFIC_REPORT_TYPE,
        ...BRAND_REPORT_TYPES,
        PROMOTION_REPORT_TYPE,
        COUPON_REPORT_TYPE,
        LISTING_FYP_REPORT_TYPE,
        SELLER_PERFORMANCE_REPORT_TYPE,
      ].sort(),
    ).toEqual(REPORT_FRESHNESS_SOURCES.map(item => item.reportType).sort())
    expect(new Set(REPORT_FRESHNESS_SOURCES.map(item => item.key)).size).toBe(REPORT_FRESHNESS_SOURCES.length)
    for (const item of REPORT_FRESHNESS_SOURCES) expect(item.key.startsWith('rpt.')).toBe(true)
    expect(freshnessSourceOfReport('GET_FBA_INVENTORY_PLANNING_DATA')?.key).toBe('rpt.inventory-planning')
    expect(freshnessSourceOfReport('GET_MERCHANT_LISTINGS_ALL_DATA')).toBeUndefined()
  })

  it('分发层：库存类型走库存导入器，并带上报告任务编号与快照日期；原有类型仍按原样分发；未实现的类型抛错', async () => {
    const job = { id: 'rj9', documentId: 'doc', sellerAccountId: 'sa1' }
    const { ctx, of } = fakeContext()
    const importer = reportImporterFor({ ...job, reportType: 'GET_AFN_INVENTORY_DATA' }, { ...scope, marketplaceId: 'ATVPDKIKX0DER' })
    await importer(ctx, rowsOf(tsv(['sku', 'fnsku', 'quantity-available'], ['A', 'F1', '5'])))
    expect(of('inventoryDailySnapshot')[0].args.create).toMatchObject({ sku: 'A', source: 'AFN', sourceReportJobId: 'rj9' })
    expect(of('inventoryDailySnapshot')[0].args.create.snapshotDate.toISOString().slice(0, 10)).toBe('2026-10-22')
    expect(reportImporterFor({ ...job, reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' }, { ...scope, marketplaceId: 'ATVPDKIKX0DER' })).toBeTypeOf('function')
    expect(() => reportImporterFor({ ...job, reportType: 'GET_SOMETHING_ELSE' }, { ...scope, marketplaceId: 'ATVPDKIKX0DER' })).toThrow('不在报表中心目录里')
  })

  it('月度仓储费报告：同一遍扫描里既写财务用的费用事件，又写库存域的仓储费明细', async () => {
    const { ctx, of } = fakeContext()
    const importer = reportImporterFor({ id: 'rj1', documentId: 'd', sellerAccountId: 'sa1', reportType: 'GET_FBA_STORAGE_FEE_CHARGES_DATA' }, { ...scope, marketplaceId: 'ATVPDKIKX0DER' })
    const result = await importer(
      ctx,
      rowsOf(
        tsv(['asin', 'fnsku', 'sku', 'month-of-charge', 'estimated-monthly-storage-fee', 'base-monthly-storage-fee', 'currency'], ['B000000001', 'X001', 'SKU-1', '2026-09', '12.5', '12.5', 'USD']),
      ),
    )
    expect(result.imported).toBe(1)
    expect(of('fbaFeeEvent')).toHaveLength(1)
    expect(of('storageFeeRecord')).toHaveLength(1)
  })
})

describe('企业时区的“今天”', () => {
  it('同一时刻在不同时区落在不同的日期', () => {
    const instant = new Date('2026-10-22T03:00:00Z')
    expect(localDay('America/Los_Angeles', instant).toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(localDay('Asia/Shanghai', instant).toISOString()).toBe('2026-10-22T00:00:00.000Z')
    expect(localDay('UTC', instant).toISOString()).toBe('2026-10-22T00:00:00.000Z')
  })
})
