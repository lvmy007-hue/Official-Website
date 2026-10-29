import { gunzipSync } from 'node:zlib'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { US_MARKETPLACE } from './sp-api-v2'
import { assertRemoteUrl } from './remote-url'

// 数据文件接口（Feeds API 2021-06-30，批量刊登任务用）。路径依据亚马逊官方文档整理，尚未用真实店铺核对（CR-085 未验证清单）：
//   createFeedDocument  POST /feeds/2021-06-30/documents   { contentType }                              → { feedDocumentId, url }（预签名上传地址，PUT 上传，不带亚马逊签名）
//   createFeed          POST /feeds/2021-06-30/feeds       { feedType, marketplaceIds, inputFeedDocumentId } → { feedId }
//   getFeed             GET  /feeds/2021-06-30/feeds/{feedId}                                           → { processingStatus, resultFeedDocumentId }
//   getFeedDocument     GET  /feeds/2021-06-30/documents/{feedDocumentId}                               → { url, compressionAlgorithm? }（预签名下载地址）
// 刊登文件类型 JSON_LISTINGS_FEED；processingStatus：IN_QUEUE、IN_PROGRESS、DONE、CANCELLED、FATAL。处理结果文件是 JSON：{ header, issues: [{ messageId, code, severity, message, attributeNames }], summary }。
// 限速：创建文档与文件每 2 分钟 1 次（突发 15），查询状态每秒 2 次：批量任务不会很密集，轮询间隔也据此放宽。

export const FEEDS_PATH = '/feeds/2021-06-30'
export const LISTINGS_FEED_TYPE = 'JSON_LISTINGS_FEED'
export const FEED_CONTENT_TYPE = 'application/json; charset=UTF-8'
const RESULT_MAX_BYTES = 5 * 1024 * 1024

export interface FeedStatus {
  processingStatus: string
  resultFeedDocumentId: string | null
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : null)

export class FeedsApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 上传输入文件并创建任务；返回亚马逊的文件编号与任务编号。 */
  async submit(feedType: string, content: string): Promise<{ feedDocumentId: string; feedId: string }> {
    const created = await this.client.request({ method: 'POST', path: `${FEEDS_PATH}/documents`, body: { contentType: FEED_CONTENT_TYPE } })
    const feedDocumentId = str(created.feedDocumentId)
    const url = str(created.url)
    if (!feedDocumentId || !url) throw new Error('FEED_DOCUMENT_NOT_RETURNED')
    const upload = await fetch(assertRemoteUrl(url, '刊登文件上传地址'), { method: 'PUT', headers: { 'content-type': FEED_CONTENT_TYPE }, body: content })
    if (!upload.ok) throw new UpstreamHttpError(`FEED_UPLOAD_${upload.status}`, upload.status, upload.headers, 'download')
    const feed = await this.client.request({ method: 'POST', path: `${FEEDS_PATH}/feeds`, body: { feedType, marketplaceIds: [US_MARKETPLACE], inputFeedDocumentId: feedDocumentId } })
    const feedId = str(feed.feedId)
    if (!feedId) throw new Error('FEED_ID_NOT_RETURNED')
    return { feedDocumentId, feedId }
  }

  async status(feedId: string): Promise<FeedStatus> {
    const response = await this.client.request({ path: `${FEEDS_PATH}/feeds/${encodeURIComponent(feedId)}` })
    return { processingStatus: String(response.processingStatus ?? 'IN_QUEUE').toUpperCase(), resultFeedDocumentId: str(response.resultFeedDocumentId) }
  }

  /** 下载并解析处理结果文件（JSON）；文件过大或不是 JSON 抛错，由调用方按失败处理。 */
  async result(feedDocumentId: string): Promise<unknown> {
    const meta = await this.client.request({ path: `${FEEDS_PATH}/documents/${encodeURIComponent(feedDocumentId)}` })
    const url = str(meta.url)
    if (!url) throw new Error('FEED_RESULT_URL_MISSING')
    const response = await fetch(assertRemoteUrl(url, '刊登处理结果下载地址'))
    if (!response.ok) throw new UpstreamHttpError(`FEED_RESULT_DOWNLOAD_${response.status}`, response.status, response.headers, 'download')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > RESULT_MAX_BYTES) throw new Error('FEED_RESULT_TOO_LARGE')
    const algorithm = String(meta.compressionAlgorithm ?? '').toUpperCase()
    const plain = algorithm === 'GZIP' || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? gunzipSync(bytes) : bytes
    return JSON.parse(plain.toString('utf8'))
  }
}
