import type { AmazonSpApiClient } from './amazon-sp-api'

// Fulfillment Inbound API v2024-03-20 与相关接口（P2a-12，importers.md I-06、I-07）。路径、方法与请求体按官方模型文件书写（见 CR-035 的“未验证”）：
//   createInboundPlan              POST /inboundPlans                                     → { inboundPlanId, operationId }
//   getInboundPlan / listInboundPlans
//   generatePackingOptions         POST /inboundPlans/{id}/packingOptions                 → { operationId }
//   listPackingOptions             GET  /inboundPlans/{id}/packingOptions                 packingOptions[]（packingGroups 只有编号）
//   listPackingGroupItems          GET  /inboundPlans/{id}/packingGroups/{groupId}/items
//   confirmPackingOption           POST /inboundPlans/{id}/packingOptions/{optionId}/confirmation
//   setPackingInformation          POST /inboundPlans/{id}/packingInformation            { packageGroupings: [{ packingGroupId, boxes }] }
//   generatePlacementOptions       POST /inboundPlans/{id}/placementOptions               { customPlacement? }
//   listPlacementOptions / confirmPlacementOption (POST .../placementOptions/{id}/confirmation)
//   getShipment / listShipmentItems（v2024 的货件明细没有接收数量）
//   generateTransportationOptions  POST /inboundPlans/{id}/transportationOptions          { placementOptionId, shipmentTransportationConfigurations }
//   listTransportationOptions      GET  /inboundPlans/{id}/transportationOptions?placementOptionId=&shipmentId=
//   confirmTransportationOptions   POST /inboundPlans/{id}/transportationOptions/confirmation  { transportationSelections }
//   generate/list/confirmDeliveryWindowOptions  /inboundPlans/{id}/shipments/{shipmentId}/deliveryWindowOptions
//   updateShipmentTrackingDetails  PUT  /inboundPlans/{id}/shipments/{shipmentId}/trackingDetails
//   cancelInboundPlan              PUT  /inboundPlans/{id}/cancellation
//   getInboundOperationStatus      GET  /operations/{operationId}                          operationStatus: SUCCESS | FAILED | IN_PROGRESS
// 接收数量与箱标签只在 v0 接口里有：getShipmentItemsByShipmentId（QuantityReceived）、getLabels（DownloadURL）；资格预检是 v1 itemPreview。
// 所有写操作都是异步的：返回 operationId，用 getInboundOperationStatus 轮询。

const BASE = '/inbound/fba/2024-03-20'
const enc = encodeURIComponent
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const unwrap = (value: unknown) => object(object(value).payload ?? value)

export interface InboundOperationStatus {
  operationId: string
  status: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS'
  problems: Array<{ code: string | null; message: string; severity: string | null }>
}

export class InboundApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  private planPath(planId: string, suffix = '') {
    return `${BASE}/inboundPlans/${enc(planId)}${suffix}`
  }

  private async operation(request: Parameters<AmazonSpApiClient['request']>[0]): Promise<{ operationId: string; body: Record<string, unknown> }> {
    const body = unwrap(await this.client.request(request))
    const operationId = typeof body.operationId === 'string' ? body.operationId : ''
    if (!operationId) throw new Error('INBOUND_OPERATION_ID_MISSING')
    return { operationId, body }
  }

  async createPlan(input: { name: string; sourceAddress: Record<string, unknown>; items: Array<{ msku: string; quantity: number; expiration?: string }>; marketplaceIds: string[] }) {
    const { operationId, body } = await this.operation({
      method: 'POST',
      path: `${BASE}/inboundPlans`,
      body: {
        name: input.name,
        sourceAddress: input.sourceAddress,
        destinationMarketplaces: input.marketplaceIds,
        // 预处理方与贴标方固定为卖家（01 章 1.7 第 1 条）
        items: input.items.map(item => ({ msku: item.msku, quantity: item.quantity, prepOwner: 'SELLER', labelOwner: 'SELLER', ...(item.expiration ? { expiration: item.expiration } : {}) })),
      },
    })
    return { operationId, inboundPlanId: typeof body.inboundPlanId === 'string' ? body.inboundPlanId : '' }
  }
  async getPlan(planId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId) }))
  }
  /** 按最近更新时间倒序列出计划：创建请求超时后用它对账。 */
  async listPlans() {
    return unwrap(await this.client.request({ path: `${BASE}/inboundPlans`, query: { pageSize: '30', sortBy: 'LAST_UPDATED_TIME', sortOrder: 'DESC' } }))
  }

  async generatePacking(planId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, '/packingOptions') })
  }
  async listPackingOptions(planId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, '/packingOptions') }))
  }
  async listPackingGroupItems(planId: string, groupId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, `/packingGroups/${enc(groupId)}/items`) }))
  }
  async confirmPacking(planId: string, optionId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, `/packingOptions/${enc(optionId)}/confirmation`) })
  }
  async setPackingInformation(planId: string, packageGroupings: unknown[]) {
    return this.operation({ method: 'POST', path: this.planPath(planId, '/packingInformation'), body: { packageGroupings } })
  }

  async generatePlacement(planId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, '/placementOptions'), body: {} })
  }
  async listPlacementOptions(planId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, '/placementOptions') }))
  }
  async confirmPlacement(planId: string, optionId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, `/placementOptions/${enc(optionId)}/confirmation`) })
  }

  async getShipment(planId: string, shipmentId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, `/shipments/${enc(shipmentId)}`) }))
  }
  async listShipmentItems(planId: string, shipmentId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, `/shipments/${enc(shipmentId)}/items`) }))
  }

  /** 货件里的箱子（亚马逊在分仓方案确认后分配箱号；回填追踪号按这些箱号对应）。 */
  async listShipmentBoxes(planId: string, shipmentId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, `/shipments/${enc(shipmentId)}/boxes`) }))
  }

  async generateTransport(planId: string, body: { placementOptionId: string; shipmentTransportationConfigurations: unknown[] }) {
    return this.operation({ method: 'POST', path: this.planPath(planId, '/transportationOptions'), body })
  }
  async listTransportOptions(planId: string, query: { placementOptionId: string; shipmentId?: string }) {
    return unwrap(
      await this.client.request({
        path: this.planPath(planId, '/transportationOptions'),
        query: { placementOptionId: query.placementOptionId, ...(query.shipmentId ? { shipmentId: query.shipmentId } : {}) },
      }),
    )
  }
  async confirmTransport(planId: string, transportationSelections: unknown[]) {
    return this.operation({ method: 'POST', path: this.planPath(planId, '/transportationOptions/confirmation'), body: { transportationSelections } })
  }

  async generateWindows(planId: string, shipmentId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, `/shipments/${enc(shipmentId)}/deliveryWindowOptions`) })
  }
  async listWindows(planId: string, shipmentId: string) {
    return unwrap(await this.client.request({ path: this.planPath(planId, `/shipments/${enc(shipmentId)}/deliveryWindowOptions`) }))
  }
  async confirmWindow(planId: string, shipmentId: string, optionId: string) {
    return this.operation({ method: 'POST', path: this.planPath(planId, `/shipments/${enc(shipmentId)}/deliveryWindowOptions/${enc(optionId)}/confirmation`) })
  }

  async updateTracking(planId: string, shipmentId: string, trackingDetails: unknown) {
    return this.operation({ method: 'PUT', path: this.planPath(planId, `/shipments/${enc(shipmentId)}/trackingDetails`), body: { trackingDetails } })
  }
  async cancelPlan(planId: string) {
    return this.operation({ method: 'PUT', path: this.planPath(planId, '/cancellation') })
  }

  async operationStatus(operationId: string): Promise<InboundOperationStatus> {
    const body = unwrap(await this.client.request({ path: `${BASE}/operations/${enc(operationId)}` }))
    const raw = String(body.operationStatus ?? '').toUpperCase()
    const problems = (Array.isArray(body.operationProblems) ? body.operationProblems : []).map(item => {
      const problem = object(item)
      return {
        code: typeof problem.code === 'string' ? problem.code : null,
        message: String(problem.message ?? problem.details ?? '亚马逊没有给出原因'),
        severity: typeof problem.severity === 'string' ? problem.severity : null,
      }
    })
    return { operationId, status: raw === 'SUCCESS' || raw === 'FAILED' ? raw : 'IN_PROGRESS', problems }
  }

  /** v0：按货件确认号（FBA 开头）取接收数量。 */
  async receivedItems(shipmentConfirmationId: string, marketplaceId: string) {
    return unwrap(await this.client.request({ path: `/fba/inbound/v0/shipments/${enc(shipmentConfirmationId)}/items`, query: { MarketplaceId: marketplaceId } }))
  }
  /** v0：箱标签（同步返回下载链接）。 */
  async boxLabels(shipmentConfirmationId: string, input: { pageType: string; boxCount: number }) {
    return unwrap(
      await this.client.request({
        path: `/fba/inbound/v0/shipments/${enc(shipmentConfirmationId)}/labels`,
        query: { PageType: input.pageType, LabelType: 'UNIQUE', NumberOfPackages: String(input.boxCount) },
      }),
    )
  }
  /** v1：单个 ASIN 的入仓资格。 */
  async eligibility(asin: string, marketplaceId: string) {
    return unwrap(await this.client.request({ path: '/fba/inbound/v1/eligibility/itemPreview', query: { marketplaceIds: marketplaceId, program: 'INBOUND', asin } }))
  }
}
