import { createHash } from 'node:crypto'
import { NonRetryableError } from '@nova/workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AplusApi, isAplusForbidden, isAplusRejected } from './aplus-api'
import { UpstreamHttpError } from './http-error'

// A+ 内容接口与上传接口的请求形状：路径、查询参数与请求体（不会真的联网）；403 的两种处置；上传图片的三个出口。
const clientOf = (responses: unknown[] = [{}]) => {
  const request = vi.fn(async (_options: Record<string, unknown>) => responses.shift() ?? {})
  return { request, client: { request } as never }
}
const failing = (status: number) => ({
  client: {
    request: vi.fn(async () => {
      throw new UpstreamHttpError(`SP_API_${status}_x`, status, new Headers(), 'api')
    }),
  } as never,
})

afterEach(() => vi.unstubAllGlobals())

describe('请求形状', () => {
  it('列表与详情：固定美国站，翻页带 pageToken，详情要内容与元数据', async () => {
    const { request, client } = clientOf()
    const api = new AplusApi(client)
    await api.listContents()
    await api.listContents('tok-2')
    await api.getContent('K/1')
    expect(request.mock.calls[0][0]).toEqual({ path: '/aplus/2020-11-01/contentDocuments', query: { marketplaceId: 'ATVPDKIKX0DER' } })
    expect(request.mock.calls[1][0].query).toEqual({ marketplaceId: 'ATVPDKIKX0DER', pageToken: 'tok-2' })
    expect(request.mock.calls[2][0]).toEqual({ path: '/aplus/2020-11-01/contentDocuments/K%2F1', query: { marketplaceId: 'ATVPDKIKX0DER', includedDataSet: 'CONTENTS,METADATA' } })
  })

  it('关联 ASIN 与发布记录：读取只带元数据，发布记录按 ASIN 查', async () => {
    const { request, client } = clientOf()
    const api = new AplusApi(client)
    await api.listAsins('K1', 'tok')
    await api.listPublishRecords('B0AAAAAAA1')
    expect(request.mock.calls[0][0]).toEqual({ path: '/aplus/2020-11-01/contentDocuments/K1/asins', query: { marketplaceId: 'ATVPDKIKX0DER', includedDataSet: 'METADATA', pageToken: 'tok' } })
    expect(request.mock.calls[1][0]).toEqual({ path: '/aplus/2020-11-01/contentPublishRecords', query: { marketplaceId: 'ATVPDKIKX0DER', asin: 'B0AAAAAAA1' } })
  })

  it('写入：创建、更新带 contentDocument，关联带 asinSet，提交审核没有请求体', async () => {
    const { request, client } = clientOf()
    const api = new AplusApi(client)
    const document = { name: 'N', contentType: 'EBC', locale: 'en-US', contentModuleList: [{ contentModuleType: 'STANDARD_TEXT' }] }
    await api.createContent(document)
    await api.updateContent('K1', document)
    await api.associateAsins('K1', ['B0AAAAAAA1'])
    await api.submitForApproval('K1')
    const query = { marketplaceId: 'ATVPDKIKX0DER' }
    expect(request.mock.calls.map(call => call[0])).toEqual([
      { method: 'POST', path: '/aplus/2020-11-01/contentDocuments', query, body: { contentDocument: document } },
      { method: 'POST', path: '/aplus/2020-11-01/contentDocuments/K1', query, body: { contentDocument: document } },
      { method: 'POST', path: '/aplus/2020-11-01/contentDocuments/K1/asins', query, body: { asinSet: ['B0AAAAAAA1'] } },
      { method: 'POST', path: '/aplus/2020-11-01/contentDocuments/K1/approvalSubmissions', query },
    ])
  })
})

describe('错误分类', () => {
  const error = (status: number) => new UpstreamHttpError(`SP_API_${status}`, status, new Headers(), 'api')
  it('403 是缺角色，400 与 404 是只影响这一条的拒绝，429 与 500 都不是', () => {
    expect(isAplusForbidden(error(403))).toBe(true)
    expect(isAplusForbidden(error(401))).toBe(false)
    expect([400, 404].every(status => isAplusRejected(error(status)))).toBe(true)
    expect([403, 429, 500].some(status => isAplusRejected(error(status)))).toBe(false)
    expect(isAplusForbidden(new Error('x'))).toBe(false)
  })

  it('读取 403：不可重试的 APL_ROLE_MISSING；其余读取错误（429、500）原样抛出', async () => {
    const api = new AplusApi(failing(403).client)
    for (const call of [() => api.listContents(), () => api.getContent('K'), () => api.listAsins('K'), () => api.listPublishRecords('B0AAAAAAA1')]) {
      const failure = call()
      await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
      await expect(failure).rejects.toMatchObject({ code: 'APL_ROLE_MISSING' })
    }
    await expect(new AplusApi(failing(429).client).listContents()).rejects.toMatchObject({ status: 429 })
    await expect(new AplusApi(failing(500).client).getContent('K')).rejects.toMatchObject({ status: 500 })
  })

  it('写入 403 保持原样（带状态码）：交给写入开关按“授权失效”处理，失败码是 SP_API_403', async () => {
    const api = new AplusApi(failing(403).client)
    for (const call of [
      () => api.createContent({ name: 'N', contentType: 'EBC', locale: 'en-US', contentModuleList: [] }),
      () => api.submitForApproval('K'),
      () => api.associateAsins('K', ['B0AAAAAAA1']),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 403, source: 'api' })
    }
  })
})

describe('上传图片', () => {
  const bytes = Buffer.from('fake image bytes')
  const destination = { payload: { uploadDestinationId: 'sc/x.png', url: 'https://s3.example.invalid/u/1', headers: { 'Content-MD5': 'abc==' } } }

  it('先向上传接口要目的地（带 MD5 与类型），再把字节 PUT 到返回的地址：只带返回的请求头与图片类型，不带授权头', async () => {
    const { request, client } = clientOf([destination])
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await new AplusApi(client).uploadImage(bytes, 'image/png')).toEqual({ uploadDestinationId: 'sc/x.png' })
    expect(request.mock.calls[0][0]).toEqual({
      method: 'POST',
      path: '/uploads/2020-11-01/uploadDestinations/aplus/2020-11-01/contentDocuments',
      query: { marketplaceId: 'ATVPDKIKX0DER', contentMD5: createHash('md5').update(bytes).digest('base64'), contentType: 'image/png' },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: Uint8Array }]
    expect(url).toBe('https://s3.example.invalid/u/1')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'Content-MD5': 'abc==', 'Content-Type': 'image/png' })
    expect(Buffer.from(init.body).equals(bytes)).toBe(true)
  })

  it('接口返回的请求头里已有 Content-Type（大小写不限）就不再加；没有 payload 外层也认', async () => {
    const { client } = clientOf([{ uploadDestinationId: 'u1', url: 'https://x/y', headers: { 'content-type': 'image/jpeg' } }])
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new AplusApi(client).uploadImage(bytes, 'image/jpeg')
    expect((fetchMock.mock.calls[0] as unknown as [string, { headers: unknown }])[1].headers).toEqual({ 'content-type': 'image/jpeg' })
  })

  it('PUT 失败（非 2xx 或网络错误）：不可重试的 APL_UPLOAD_FAILED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    )
    const refused = new AplusApi(clientOf([destination]).client).uploadImage(bytes, 'image/png')
    await expect(refused).rejects.toBeInstanceOf(NonRetryableError)
    await expect(refused).rejects.toMatchObject({ code: 'APL_UPLOAD_FAILED' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(new AplusApi(clientOf([destination]).client).uploadImage(bytes, 'image/png')).rejects.toMatchObject({ code: 'APL_UPLOAD_FAILED' })
  })

  it('目的地认不出（缺编号、缺地址、地址不是 https）：APL_RESPONSE_UNRECOGNIZED，不发 PUT', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const body of [{}, { payload: { url: 'https://x' } }, { uploadDestinationId: 'u', url: 'http://insecure' }]) {
      await expect(new AplusApi(clientOf([body]).client).uploadImage(bytes, 'image/png')).rejects.toMatchObject({ code: 'APL_RESPONSE_UNRECOGNIZED' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
