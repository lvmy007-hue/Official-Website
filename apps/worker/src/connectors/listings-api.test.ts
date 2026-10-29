import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedsApi } from './feeds-api'
import { UpstreamHttpError } from './http-error'
import { ListingsApi, isListingsForbidden, isListingsRejected } from './listings-api'

// 刊登接口与数据文件接口的请求形状：路径、查询参数与请求体（不会真的联网）。
const clientOf = (responses: unknown[] = [{}]) => {
  const request = vi.fn(async () => responses.shift() ?? {})
  return { request, client: { request } as never }
}

afterEach(() => vi.unstubAllGlobals())

describe('ListingsApi', () => {
  it('搜索：固定美国站，取摘要与问题，翻页带 pageToken', async () => {
    const { request, client } = clientOf()
    const api = new ListingsApi(client, 'A1 SELLER')
    await api.search()
    await api.search('tok-2')
    expect(request).toHaveBeenNthCalledWith(1, {
      path: '/listings/2021-08-01/items/A1%20SELLER',
      query: { marketplaceIds: 'ATVPDKIKX0DER', includedData: 'summaries,issues', pageSize: '20', issuesLocale: 'en_US' },
    })
    expect(request.mock.calls[1][0].query).toMatchObject({ pageToken: 'tok-2' })
  })

  it('校验预览带 mode=VALIDATION_PREVIEW，正式提交不带', async () => {
    const { request, client } = clientOf()
    const api = new ListingsApi(client, 'A1')
    const body = { productType: 'SHIRT', patches: [{ op: 'delete', path: '/attributes/size' }] }
    await api.patch('SKU/1', body, true)
    await api.patch('SKU/1', body, false)
    const [preview, real] = request.mock.calls.map(call => call[0])
    expect(preview).toMatchObject({ method: 'PATCH', path: '/listings/2021-08-01/items/A1/SKU%2F1', body })
    expect(preview.query).toMatchObject({ mode: 'VALIDATION_PREVIEW', issueLocale: 'en_US' })
    expect(real.query).not.toHaveProperty('mode')
  })

  it('刊登限制：按 ASIN 与卖家编号查询', async () => {
    const { request, client } = clientOf()
    await new ListingsApi(client, 'A1').restrictions('B000000001')
    expect(request).toHaveBeenCalledWith({
      path: '/listings/2021-08-01/restrictions',
      query: { asin: 'B000000001', conditionType: 'new_new', sellerId: 'A1', marketplaceIds: 'ATVPDKIKX0DER', reasonLocale: 'en_US' },
    })
  })

  it('错误分类：403 是缺角色，400/404/422 是请求被拒绝，429 与 500 都不是', () => {
    const error = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, new Headers(), 'api')
    expect(isListingsForbidden(error(403))).toBe(true)
    expect(isListingsForbidden(error(401))).toBe(false)
    expect([400, 404, 422].every(status => isListingsRejected(error(status)))).toBe(true)
    expect(isListingsRejected(error(429))).toBe(false)
    expect(isListingsRejected(error(500))).toBe(false)
    expect(isListingsForbidden(new Error('x'))).toBe(false)
  })
})

describe('FeedsApi', () => {
  it('提交：建文档、上传、建任务，返回两个编号', async () => {
    const { request, client } = clientOf([{ feedDocumentId: 'doc-1', url: 'https://upload/x' }, { feedId: 'feed-1' }])
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await new FeedsApi(client).submit('JSON_LISTINGS_FEED', '{"a":1}')).toEqual({ feedDocumentId: 'doc-1', feedId: 'feed-1' })
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/feeds/2021-06-30/documents' })
    expect(fetchMock).toHaveBeenCalledWith('https://upload/x', expect.objectContaining({ method: 'PUT', body: '{"a":1}' }))
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      path: '/feeds/2021-06-30/feeds',
      body: { feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['ATVPDKIKX0DER'], inputFeedDocumentId: 'doc-1' },
    })
  })

  it('没返回文档地址或上传失败：抛错，不会继续建任务', async () => {
    const missing = clientOf([{ feedDocumentId: 'doc-1' }])
    await expect(new FeedsApi(missing.client).submit('T', 'x')).rejects.toThrow('FEED_DOCUMENT_NOT_RETURNED')
    const failing = clientOf([{ feedDocumentId: 'doc-1', url: 'https://upload/x' }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    )
    await expect(new FeedsApi(failing.client).submit('T', 'x')).rejects.toMatchObject({ status: 403 })
    expect(failing.request).toHaveBeenCalledTimes(1)
  })

  it('状态：状态值转大写，没有结果文档为 null', async () => {
    const { client } = clientOf([{ processingStatus: 'done', resultFeedDocumentId: 'res-1' }, {}])
    const api = new FeedsApi(client)
    expect(await api.status('feed-1')).toEqual({ processingStatus: 'DONE', resultFeedDocumentId: 'res-1' })
    expect(await api.status('feed-1')).toEqual({ processingStatus: 'IN_QUEUE', resultFeedDocumentId: null })
  })

  it('结果：能解开压缩与未压缩两种，结果文件过大会拒绝', async () => {
    const body = JSON.stringify({ issues: [], summary: { errors: 0 } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(gzipSync(Buffer.from(body)))),
    )
    expect(await new FeedsApi(clientOf([{ url: 'https://dl/x', compressionAlgorithm: 'GZIP' }]).client).result('res-1')).toEqual({ issues: [], summary: { errors: 0 } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    )
    expect(await new FeedsApi(clientOf([{ url: 'https://dl/x' }]).client).result('res-1')).toEqual({ issues: [], summary: { errors: 0 } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1))),
    )
    await expect(new FeedsApi(clientOf([{ url: 'https://dl/x' }]).client).result('res-1')).rejects.toThrow('FEED_RESULT_TOO_LARGE')
  })
})
