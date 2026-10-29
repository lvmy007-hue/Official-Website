import type { Readable } from 'node:stream'
import { responseStream, type RawSink } from '../streaming/download'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'

import { assertRemoteUrl } from './remote-url'

// 数据中心（Data Kiosk API v2023-11-15）连接器。路径与字段于 2026 年 10 月对照官方文档复核：
//   提交查询   POST /dataKiosk/2023-11-15/queries              body { query, paginationToken? } → 202 { queryId }
//   查询状态   GET  /dataKiosk/2023-11-15/queries/{queryId}    → processingStatus：IN_QUEUE、IN_PROGRESS、DONE、FATAL、CANCELLED；
//                                                               DONE 时有 dataDocumentId（无数据则没有）；FATAL 时有 errorDocumentId；多页时有 pagination.nextToken
//   取文档地址 GET  /dataKiosk/2023-11-15/documents/{documentId} → { documentId, documentUrl }，地址 5 分钟内有效
// 约束：查询文本去掉多余空白后不超过 8000 字符；提交限速每分钟约 1 次（突发 15）；结果文档为逐行 JSON（JSONL），错误文档为 JSON；
//       官方要求结果内容任何时候都不得以明文落盘——这里只在内存流里解析，原始字节写进对象存储（加密存储）。

export const DATA_KIOSK_RETENTION_DAYS = 30
export const DATA_KIOSK_MAX_QUERY_CHARS = 8000
export type KioskStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'FATAL' | 'CANCELLED'

export type KioskQueryStatus = { queryId: string; processingStatus: KioskStatus | string; dataDocumentId?: string; errorDocumentId?: string; nextToken?: string }

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined)
export const compactQuery = (query: string) => query.replace(/\s+/g, ' ').trim()

export class DataKiosk {
  constructor(private readonly client: AmazonSpApiClient) {}

  async createQuery(query: string, paginationToken?: string): Promise<string> {
    const compact = compactQuery(query)
    if (compact.length === 0) throw new Error('DATA_KIOSK_QUERY_EMPTY')
    if (compact.length > DATA_KIOSK_MAX_QUERY_CHARS) throw new Error('DATA_KIOSK_QUERY_TOO_LONG')
    const response = await this.client.request({ method: 'POST', path: '/dataKiosk/2023-11-15/queries', body: { query: compact, ...(paginationToken ? { paginationToken } : {}) } })
    const queryId = text(response.queryId)
    if (!queryId) throw new Error('DATA_KIOSK_QUERY_ID_NOT_RETURNED')
    return queryId
  }

  async getQuery(queryId: string): Promise<KioskQueryStatus> {
    const response = await this.client.request({ path: `/dataKiosk/2023-11-15/queries/${encodeURIComponent(queryId)}` })
    const pagination = response.pagination && typeof response.pagination === 'object' ? (response.pagination as Record<string, unknown>) : null
    return {
      queryId,
      processingStatus: text(response.processingStatus) ?? 'IN_QUEUE',
      dataDocumentId: text(response.dataDocumentId),
      errorDocumentId: text(response.errorDocumentId),
      nextToken: text(pagination?.nextToken),
    }
  }

  /**
   * 打开文档内容流（流式，不把文件读入内存）。文档地址只有 5 分钟有效，所以拿到地址立刻下载。
   * 压缩由 Content-Encoding 头声明，运行时会自动解压；没有声明时按文件头自动识别。原始字节同时写入 sink（对象存储）。
   */
  async openDocument(documentId: string, options: { sink?: RawSink } = {}): Promise<Readable> {
    const meta = await this.client.request({ path: `/dataKiosk/2023-11-15/documents/${encodeURIComponent(documentId)}` })
    const url = text(meta.documentUrl)
    if (!url) throw new Error('DATA_KIOSK_DOCUMENT_URL_MISSING')
    const response = await fetch(assertRemoteUrl(url, '数据中心文档下载地址'))
    if (!response.ok) throw new UpstreamHttpError(`DATA_KIOSK_DOCUMENT_DOWNLOAD_${response.status}`, response.status, response.headers, 'download')
    return responseStream(response, { compression: 'auto', sink: options.sink })
  }
}
