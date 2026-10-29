import type { SalesTaxResponse } from '@nova/api-contracts'
import { freshness } from './fee-fixtures.test-helper'

// 销售税页面测试用的接口返回样例（只在测试里使用）。

const BASIS = '税务文档库报告按报告里的日期、订单接口按下单时间，都以 UTC 日历日分月；订单接口不含收货州，所以只能按月对总额，不能分州。'

export const salesTax = (over: Partial<SalesTaxResponse> = {}): SalesTaxResponse => ({
  state: 'OK',
  note: null,
  range: { from: '2026-09-01', to: '2026-10-15', defaulted: false, clamped: false },
  currency: 'USD',
  stores: [
    { sellerAccountId: 's1', storeName: '美国主店', state: 'AVAILABLE', stateLabel: '已取得', note: '已取得税务文档库报告', lastSuccessAt: '2026-10-22T01:00:00.000Z' },
    { sellerAccountId: 's2', storeName: '美国二店', state: 'ROLE_PENDING', stateLabel: '未授权', note: '未授权：需申请亚马逊受限角色“税务汇缴”，获批并重新授权后才能取得报告', lastSuccessAt: null },
  ],
  sources: [
    { source: 'TAX_LIBRARY', label: '税务文档库报告', state: 'OK', note: '按州、辖区与税种汇总的代收代缴税额；1 家店铺已取得报告', total: 210 },
    { source: 'ORDER_API', label: '订单接口', state: 'OK', note: '订单上的税额，按下单时间汇总', total: 205.02 },
    { source: 'SHIPMENT_REPORT', label: '发货报告', state: 'NOT_CONNECTED', note: '尚未接入：亚马逊物流发货报告里的税额需要另行接入，本页暂不使用', total: null },
  ],
  totals: { taxCollected: 210, taxableSales: 1000, ordersTax: 205.02 },
  states: [
    {
      state: 'WA',
      taxableSales: 1000,
      taxCollected: 150,
      lineCount: 20,
      share: 0.7143,
      jurisdictions: [
        { jurisdictionKey: 'KING COUNTY', taxKind: 'SALES_TAX', taxKindLabel: '销售税', taxableSales: 700, taxCollected: 100, lineCount: 14 },
        { jurisdictionKey: '', taxKind: 'SALES_TAX', taxKindLabel: '销售税', taxableSales: 300, taxCollected: 50, lineCount: 6 },
      ],
    },
    {
      state: 'CA',
      taxableSales: null,
      taxCollected: 60,
      lineCount: 8,
      share: 0.2857,
      jurisdictions: [{ jurisdictionKey: '', taxKind: 'SALES_TAX', taxKindLabel: '销售税', taxableSales: null, taxCollected: 60, lineCount: 8 }],
    },
  ],
  jurisdictionsTruncated: false,
  trend: [
    { month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: 160, ordersTax: 120.02 },
    { month: '2026-10', from: '2026-10-01', to: '2026-10-15', reportTax: 50, ordersTax: 85 },
  ],
  reconciliation: [
    { sellerAccountId: 's1', storeName: '美国主店', month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: 120, ordersTax: 120.02, diff: -0.02, state: 'MATCHED', stateLabel: '一致' },
    {
      sellerAccountId: 's2',
      storeName: '美国二店',
      month: '2026-09',
      from: '2026-09-01',
      to: '2026-09-30',
      reportTax: 40,
      ordersTax: null,
      diff: null,
      state: 'NO_ORDERS',
      stateLabel: '订单里没有税额记录',
    },
    { sellerAccountId: 's1', storeName: '美国主店', month: '2026-10', from: '2026-10-01', to: '2026-10-15', reportTax: 50, ordersTax: 80, diff: -30, state: 'DIFFERENT', stateLabel: '有差异' },
  ],
  basis: BASIS,
  freshness,
  ...over,
})

export const emptySalesTax = (): SalesTaxResponse =>
  salesTax({
    state: 'NO_DATA',
    note: '尚无销售税数据：需要先在卖家后台“税务文档库”生成销售税报告（并获批受限角色“税务汇缴”），同步任务每天检索一次',
    stores: [
      {
        sellerAccountId: 's1',
        storeName: '美国主店',
        state: 'NOT_GENERATED',
        stateLabel: '待生成',
        note: '需在卖家后台“税务文档库”先生成销售税报告，生成后每天检索一次，本系统不能代为生成',
        lastSuccessAt: null,
      },
      { sellerAccountId: 's2', storeName: '美国二店', state: 'NO_RECORD', stateLabel: '尚无记录', note: '这家店还没有检索过税务文档库报告，授权后每天检索一次', lastSuccessAt: null },
    ],
    sources: [
      { source: 'TAX_LIBRARY', label: '税务文档库报告', state: 'NO_DATA', note: '所选日期范围内没有报告数据', total: null },
      { source: 'ORDER_API', label: '订单接口', state: 'NO_DATA', note: '所选日期范围内订单接口没有税额记录', total: null },
      { source: 'SHIPMENT_REPORT', label: '发货报告', state: 'NOT_CONNECTED', note: '尚未接入：亚马逊物流发货报告里的税额需要另行接入，本页暂不使用', total: null },
    ],
    totals: { taxCollected: null, taxableSales: null, ordersTax: null },
    states: [],
    trend: [
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: null, ordersTax: null },
      { month: '2026-10', from: '2026-10-01', to: '2026-10-15', reportTax: null, ordersTax: null },
    ],
    reconciliation: [],
  })
