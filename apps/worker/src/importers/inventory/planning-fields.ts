// 库存规划报告（GET_FBA_INVENTORY_PLANNING_DATA）的列映射：字段名 → 表头别名（统一成小写短横线后的写法，见 columns.ts）。
// 列名依据亚马逊公开的报告说明整理，报告新增的列不影响导入；上线前需用真实店铺的样例文件逐列核对（见 CR 的“未验证”）。

export const PLANNING_INT_COLUMNS = {
  available: ['available'],
  pendingRemovalQty: ['pending-removal-quantity'],
  unitsShippedT7: ['units-shipped-t7'],
  unitsShippedT30: ['units-shipped-t30'],
  unitsShippedT60: ['units-shipped-t60'],
  unitsShippedT90: ['units-shipped-t90'],
  estimatedExcessQty: ['estimated-excess-quantity'],
  inboundQty: ['inbound-quantity'],
  inboundWorking: ['inbound-working'],
  inboundShipped: ['inbound-shipped'],
  inboundReceived: ['inbound-received'],
  noSaleLast6Months: ['no-sale-last-6-months'],
  reservedQty: ['total-reserved-quantity', 'reserved-quantity'],
  reservedFcTransfer: ['reserved-fc-transfer'],
  reservedFcProcessing: ['reserved-fc-processing'],
  reservedCustomerOrder: ['reserved-customer-order'],
  unfulfillableQty: ['unfulfillable-quantity'],
  fbaMinimumInventoryLevel: ['fba-minimum-inventory-level'],
  recommendedShipInQty: ['recommended-ship-in-quantity'],
  recommendedSaleDurationDays: ['recommended-sale-duration-days'],
  recommendedRemovalQty: ['recommended-removal-quantity'],
  ltsfQty6Mo: ['qty-to-be-charged-ltsf-6-mo'],
  ltsfQty12Mo: ['qty-to-be-charged-ltsf-12-mo'],
} as const

/** 库龄分段：同时写入规划快照与库龄快照。 */
export const AGE_COLUMNS = {
  age0to90: ['inv-age-0-to-90-days'],
  age91to180: ['inv-age-91-to-180-days'],
  age181to270: ['inv-age-181-to-270-days'],
  age271to365: ['inv-age-271-to-365-days'],
  age365plus: ['inv-age-365-plus-days'],
  age0to30: ['inv-age-0-to-30-days'],
  age31to60: ['inv-age-31-to-60-days'],
  age61to90: ['inv-age-61-to-90-days'],
  age366to455: ['inv-age-366-to-455-days'],
  age456plus: ['inv-age-456-plus-days'],
} as const

/** 库龄附加费各分段预估：库龄快照的 ageSurchargeEstimate 取它们之和。 */
export const AIS_COLUMNS = {
  aisEst181To210: ['estimated-ais-181-210-days'],
  aisEst211To240: ['estimated-ais-211-240-days'],
  aisEst241To270: ['estimated-ais-241-270-days'],
  aisEst271To300: ['estimated-ais-271-300-days'],
  aisEst301To330: ['estimated-ais-301-330-days'],
  aisEst331To365: ['estimated-ais-331-365-days'],
  aisEst365Plus: ['estimated-ais-365-plus-days'],
} as const

export const PLANNING_NUM_COLUMNS = {
  ...AIS_COLUMNS,
  yourPrice: ['your-price'],
  salesPrice: ['sales-price'],
  sellThrough: ['sell-through'],
  itemVolume: ['item-volume'],
  daysOfSupply: ['days-of-supply'],
  weeksOfCoverT7: ['weeks-of-cover-t7'],
  weeksOfCoverT30: ['weeks-of-cover-t30'],
  weeksOfCoverT60: ['weeks-of-cover-t60'],
  weeksOfCoverT90: ['weeks-of-cover-t90'],
  estimatedStorageCostNextMonth: ['estimated-storage-cost-next-month'],
  historicalDaysOfSupply: ['historical-days-of-supply'],
  shortTermHistoricalDaysOfSupply: ['short-term-historical-days-of-supply'],
  longTermHistoricalDaysOfSupply: ['long-term-historical-days-of-supply'],
  lowInventoryLevelFee: ['estimated-low-inventory-level-fee', 'low-inventory-level-fee'],
  recommendedSalesPrice: ['recommended-sales-price'],
  estimatedCostSavings: ['estimated-cost-savings-of-recommended-actions'],
  ltsfProjected6Mo: ['projected-ltsf-6-mo'],
  ltsfProjected12Mo: ['projected-ltsf-12-mo'],
} as const

export const PLANNING_TEXT_COLUMNS = {
  productName: ['product-name'],
  condition: ['condition'],
  currency: ['currency'],
  alert: ['alert'],
  recommendedAction: ['recommended-action'],
  volumeUnit: ['volume-unit-measurement', 'volume-unit'],
  storageType: ['storage-type'],
  seasonality: ['seasonality', 'inventory-seasonality'],
  amazonHealthStatus: ['fba-inventory-level-health-status'],
  lowInventoryLevelFeeApplied: ['low-inventory-level-fee-applied-in-current-week'],
} as const

export const SKU_NAMES = ['sku', 'seller-sku', 'merchant-sku', 'msku'] as const
export const FNSKU_NAMES = ['fnsku', 'fulfillment-channel-sku'] as const
