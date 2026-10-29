import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'

// 亚马逊仓储分销接口（Amazon Warehousing and Distribution API v2024-05-09，importers.md I-08）。路径、参数、枚举于 2026 年 10 月对照亚马逊官方模型文件复核
// （selling-partner-api-models/models/amazon-warehousing-and-distribution-model/awd_2024-05-09.json）：
//   listInventory               GET  /awd/2024-05-09/inventory               details=SHOW 才返回可分配、预留、发往亚马逊物流在途与有效期；maxResults 最大 200；限速 2/秒
//   listInboundShipments        GET  /awd/2024-05-09/inboundShipments        maxResults 最大 200；可按 updatedAfter 增量；限速 1/秒
//   getInboundShipment          GET  /awd/2024-05-09/inboundShipments/{id}   skuQuantities=SHOW 才返回按 SKU 的预期与接收数量
//   getInbound                  GET  /awd/2024-05-09/inboundOrders/{id}      官方没有“列出入库订单”的操作，订单只能按编号读取
//   createInbound               POST /awd/2024-05-09/inboundOrders           创建 DRAFT 订单（每个订单一个货件），返回 { orderId }
//   updateInbound               PUT  /awd/2024-05-09/inboundOrders/{id}      只允许 DRAFT；请求体是完整订单（地址、包装、偏好），成功 204
//   confirmInbound              POST /awd/2024-05-09/inboundOrders/{id}/confirmation   只允许 DRAFT，成功 204
//   cancelInbound               POST /awd/2024-05-09/inboundOrders/{id}/cancellation   连同货件一起取消，成功 204
//   updateInboundShipmentTransportDetails PUT /awd/2024-05-09/inboundShipments/{id}/transport   成功 204
//   getInboundShipmentLabels    GET  /awd/2024-05-09/inboundShipments/{id}/labels  异步：labelStatus 为 GENERATED 时才有下载链接；页面类型目前只有 PLAIN_PAPER
// 写操作限速都是 1/秒、突发 1。固定美国站（AWD 目前只在美国站提供）。预处理方与贴标方固定为卖家（01 章 1.7），请求里不出现“由亚马逊预处理或贴标”的取值。

export const AWD_PATH = '/awd/2024-05-09'
export const AWD_PAGE_SIZE = 200

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** 没有开通上游仓储：官方没有专门错误码，按状态码与错误文字判断；缺少角色等其他错误（尤其 403）原样抛出，不被吞掉。 */
export function isAwdNotEnrolled(error: unknown): boolean {
  if (!(error instanceof UpstreamHttpError) || error.source !== 'api') return false
  if (error.status === 404) return true
  return error.status === 400 && /enrol|onboard|not\s+registered|not\s+eligible|awd\s+(account|program)/i.test(error.message)
}

export class AwdApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  listInventory(nextToken?: string) {
    return this.client.request({ path: `${AWD_PATH}/inventory`, query: { details: 'SHOW', maxResults: String(AWD_PAGE_SIZE), ...(nextToken ? { nextToken } : {}) } })
  }

  /** 按更新时间从旧到新取（增量起点由已入库货件的最新更新时间决定，见 importers/awd/sync.ts）。翻页时必须带与首次相同的参数（官方要求），所以 updatedAfter 每页都传。 */
  listShipments(input: { updatedAfter?: string; nextToken?: string } = {}) {
    return this.client.request({
      path: `${AWD_PATH}/inboundShipments`,
      query: {
        sortBy: 'UPDATED_AT',
        sortOrder: 'ASCENDING',
        maxResults: String(AWD_PAGE_SIZE),
        ...(input.updatedAfter ? { updatedAfter: input.updatedAfter } : {}),
        ...(input.nextToken ? { nextToken: input.nextToken } : {}),
      },
    })
  }

  getShipment(shipmentId: string) {
    return this.client.request({ path: `${AWD_PATH}/inboundShipments/${encodeURIComponent(shipmentId)}`, query: { skuQuantities: 'SHOW' } })
  }

  getOrder(orderId: string) {
    return this.client.request({ path: `${AWD_PATH}/inboundOrders/${encodeURIComponent(orderId)}` })
  }

  async createOrder(body: Record<string, unknown>): Promise<{ orderId?: string }> {
    const response = object(await this.client.request({ method: 'POST', path: `${AWD_PATH}/inboundOrders`, body }))
    return { orderId: typeof response.orderId === 'string' ? response.orderId : undefined }
  }

  async updateOrder(orderId: string, body: Record<string, unknown>): Promise<void> {
    await this.client.request({ method: 'PUT', path: `${AWD_PATH}/inboundOrders/${encodeURIComponent(orderId)}`, body })
  }

  async confirmOrder(orderId: string): Promise<void> {
    await this.client.request({ method: 'POST', path: `${AWD_PATH}/inboundOrders/${encodeURIComponent(orderId)}/confirmation` })
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.request({ method: 'POST', path: `${AWD_PATH}/inboundOrders/${encodeURIComponent(orderId)}/cancellation` })
  }

  async updateTransport(shipmentId: string, transport: { carrierCode?: string; bookingId: string }): Promise<void> {
    const tracking = { bookingId: transport.bookingId, ...(transport.carrierCode ? { carrierCode: { carrierCodeType: 'SCAC', carrierCodeValue: transport.carrierCode } } : {}) }
    await this.client.request({ method: 'PUT', path: `${AWD_PATH}/inboundShipments/${encodeURIComponent(shipmentId)}/transport`, body: { trackingDetails: [tracking] } })
  }

  async getLabels(shipmentId: string): Promise<{ labelStatus: string; url: string | null }> {
    const response = object(await this.client.request({ path: `${AWD_PATH}/inboundShipments/${encodeURIComponent(shipmentId)}/labels`, query: { pageType: 'PLAIN_PAPER', formatType: 'PDF' } }))
    return { labelStatus: typeof response.labelStatus === 'string' ? response.labelStatus : 'NOT_READY', url: typeof response.labelDownloadURL === 'string' ? response.labelDownloadURL : null }
  }
}
