import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../types'
import { ECONOMICS_DATASET, buildEconomicsQuery, economicsSimulationDataset, readEconomicsRow } from './economics-simulation'
import { clearDataKioskDatasetsForTest, dataKioskDatasetFor } from './registry'
import { registerEconomicsSimulation } from './economics-simulation'

// 数据中心经济模拟（D-06）：查询文本、结果行解析、按行覆盖累加（重试不重复）、范围校验。

const params = { runId: 'run1', sku: 'SKU-A', quantity: '500', startDate: '2026-10-22', endDate: '2026-11-20', sellerAccountId: 'sa1' }
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const amount = (value: number) => ({ amount: value, currencyCode: 'USD' })
const row = (msku: string, sales: number, fees: number[], net: number) => ({
  msku,
  startDate: '2026-10-22',
  endDate: '2026-11-20',
  sales: { netProductSales: amount(sales), netUnitsSold: 100 },
  fees: [{ feeTypeName: 'FBA fulfillment fees', charges: fees.map(value => ({ aggregatedDetail: { totalAmount: amount(value) } })) }],
  netProceeds: { total: amount(net) },
})

describe('查询文本', () => {
  it('按官方 schema 拼装：模拟 AWD、美国站、用 MSKU 标识、带发往上游仓储的数量；压缩后不超过 8000 字符', () => {
    const query = buildEconomicsQuery(params)
    expect(query).toContain('analytics_economics_2024_03_15')
    expect(query).toContain('economicsSimulation(')
    expect(query).toContain('actionTypes: [AWD]')
    expect(query).toContain('marketplaceId: "ATVPDKIKX0DER"')
    expect(query).toContain('startDate: "2026-10-22", endDate: "2026-11-20"')
    expect(query).toContain('identifier: { type: MSKU, value: "SKU-A" }')
    expect(query).toContain('sendToAWDQuantity: 500')
    expect(query.replace(/\s+/g, ' ').length).toBeLessThan(8000)
  })

  it('SKU 里的引号、反斜杠与换行被转义，不能改变查询结构；数量、日期、SKU 不合法时本地拒绝', () => {
    const evil = buildEconomicsQuery({ ...params, sku: 'A"}) { x } #\\\n' })
    expect(evil).toContain('value: "A\\"}) { x } #\\\\\\n"')
    expect(() => buildEconomicsQuery({ ...params, sku: '' })).toThrow('ECONOMICS_SIMULATION_SKU_INVALID')
    expect(() => buildEconomicsQuery({ ...params, quantity: '0' })).toThrow('ECONOMICS_SIMULATION_QUANTITY_INVALID')
    expect(() => buildEconomicsQuery({ ...params, quantity: '1.5' })).toThrow('ECONOMICS_SIMULATION_QUANTITY_INVALID')
    expect(() => buildEconomicsQuery({ ...params, quantity: '1 ) {' })).toThrow('ECONOMICS_SIMULATION_QUANTITY_INVALID')
    expect(() => buildEconomicsQuery({ ...params, startDate: '2026-10-22T00:00' })).toThrow('ECONOMICS_SIMULATION_DATE_INVALID')
  })
})

describe('结果行解析', () => {
  it('销售额取净销售额；费用把各类型下所有收费相加；净收入取总额；币种取第一个有的', () => {
    const parsed = readEconomicsRow(row('SKU-A', 1500, [200.5, 99.5], 900))
    expect(parsed).toEqual({ key: 'SKU-A|2026-10-22|2026-11-20', entry: { sales: 1500, fees: 300, netProceeds: 900, units: 100, currency: 'USD' } })
  })

  it('P2b-11：原包装发货（SIPP）不带数量；可带自定义单价；动作类型、单价不合法时本地拒绝', () => {
    const sipp = buildEconomicsQuery({ ...params, actionType: 'SIPP', quantity: '', price: '19.99' })
    expect(sipp).toContain('actionTypes: [SIPP]')
    expect(sipp).not.toContain('sendToAWDQuantity')
    expect(sipp).toContain('itemPrice: { amount: 19.99, currencyCode: "USD" }')
    expect(buildEconomicsQuery({ ...params, actionType: 'SIPP', quantity: '' })).not.toContain('inputContext')
    expect(() => buildEconomicsQuery({ ...params, actionType: 'FBA' })).toThrow('ECONOMICS_SIMULATION_ACTION_INVALID')
    expect(() => buildEconomicsQuery({ ...params, price: '0' })).toThrow('ECONOMICS_SIMULATION_PRICE_INVALID')
    expect(() => buildEconomicsQuery({ ...params, price: '1e3' })).toThrow('ECONOMICS_SIMULATION_PRICE_INVALID')
    expect(() => buildEconomicsQuery({ ...params, actionType: 'SIPP', quantity: '', price: '-1' })).toThrow('ECONOMICS_SIMULATION_PRICE_INVALID')
  })

  it('既没有销售也没有净收入的行无法使用：返回 null（计入跳过）', () => {
    expect(readEconomicsRow({ msku: 'X' })).toBeNull()
  })
})

describe('结果落库', () => {
  const makeCtx = (initial: unknown) => {
    const state = { resultJson: initial, found: true }
    const update = vi.fn(async (args: { data: { resultJson: unknown } }) => {
      state.resultJson = args.data.resultJson
    })
    const findFirst = vi.fn(async () => (state.found ? { id: 'run1', resultJson: state.resultJson } : null))
    const prisma = { economicsSimulationRun: { findFirst, update } } as unknown as PrismaClient
    const ctx: ImportContext = { prisma, logger: { warn: vi.fn() } as unknown as Logger }
    return { ctx, state, findFirst, update }
  }

  it('逐行累加汇总；同一行（重试）按行键覆盖，不重复累加；查询限定在本企业本店铺', async () => {
    const { ctx, state, findFirst } = makeCtx(null)
    expect(await economicsSimulationDataset.handle(ctx, row('SKU-A', 1000, [100], 600), scope, params)).toBe('imported')
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'run1', tenantId: 't1', sellerAccountId: 'sa1' }, select: { id: true, resultJson: true } })
    await economicsSimulationDataset.handle(ctx, { ...row('SKU-A', 500, [50], 300), startDate: '2026-11-21', endDate: '2026-11-30' }, scope, params)
    expect(state.resultJson).toMatchObject({ currency: 'USD', sales: 1500, fees: 150, netProceeds: 900, rows: 2 })
    await economicsSimulationDataset.handle(ctx, row('SKU-A', 1000, [100], 600), scope, params) // 任务重试：同一行再来一次
    expect(state.resultJson).toMatchObject({ sales: 1500, fees: 150, netProceeds: 900, rows: 2 })
  })

  it('任务编号缺失、模拟记录不属于本企业本店铺、行无法解析：都跳过，不写入', async () => {
    const { ctx, state, update } = makeCtx(null)
    expect(await economicsSimulationDataset.handle(ctx, row('SKU-A', 1, [1], 1), scope, { ...params, runId: '' })).toBe('skipped')
    expect(await economicsSimulationDataset.handle(ctx, { msku: 'X' }, scope, params)).toBe('skipped')
    state.found = false
    expect(await economicsSimulationDataset.handle(ctx, row('SKU-A', 1, [1], 1), scope, params)).toBe('skipped')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('注册', () => {
  it('注册后能按数据集标识取到；重复注册报错（防止被覆盖）', () => {
    clearDataKioskDatasetsForTest()
    registerEconomicsSimulation()
    expect(dataKioskDatasetFor(ECONOMICS_DATASET)?.reportType).toBe('DATA_KIOSK_ECONOMICS_SIMULATION')
    expect(() => registerEconomicsSimulation()).toThrow('DATA_KIOSK_DATASET_DUPLICATE')
    clearDataKioskDatasetsForTest()
  })
})
