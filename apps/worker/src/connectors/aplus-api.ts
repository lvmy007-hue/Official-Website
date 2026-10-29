import { createHash } from 'node:crypto'
import { APLUS_MARKETPLACE_ID, APLUS_ROLE_MISSING } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { parseUploadDestination } from '../importers/aplus/parse'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { assertRemoteUrl } from './remote-url'

// A+ 内容接口（A+ Content API 2020-11-01，importers.md I-18）与上传接口（Uploads API 2020-11-01）。路径与参数依据亚马逊官方文档整理，
// 没有用真实店铺核对（CR-089 未验证清单）：
//   searchContentDocuments            GET  /aplus/2020-11-01/contentDocuments?marketplaceId=&pageToken=
//   getContentDocument                GET  /aplus/2020-11-01/contentDocuments/{key}?marketplaceId=&includedDataSet=CONTENTS,METADATA
//   createContentDocument             POST /aplus/2020-11-01/contentDocuments?marketplaceId=                       请求体 { contentDocument }
//   updateContentDocument             POST /aplus/2020-11-01/contentDocuments/{key}?marketplaceId=                 请求体 { contentDocument }
//   listContentDocumentAsinRelations  GET  /aplus/2020-11-01/contentDocuments/{key}/asins?marketplaceId=&includedDataSet=METADATA&pageToken=
//   postContentDocumentAsinRelations  POST /aplus/2020-11-01/contentDocuments/{key}/asins?marketplaceId=           请求体 { asinSet }
//   postContentDocumentApprovalSubmission POST /aplus/2020-11-01/contentDocuments/{key}/approvalSubmissions?marketplaceId=
//   searchContentPublishRecords       GET  /aplus/2020-11-01/contentPublishRecords?marketplaceId=&asin=&pageToken=
//   createUploadDestinationForResource POST /uploads/2020-11-01/uploadDestinations/aplus/2020-11-01/contentDocuments?marketplaceId=&contentMD5=&contentType=
// 读取类方法把 403 转成不可重试的 APL_ROLE_MISSING（店铺没有品牌备案，或没获批 A+ 内容角色，重试没有意义，新鲜度记“未授权”）；
// 写入类方法保持原样抛出带状态码的错误：写入的 403 要按“授权失效”计入写入开关（失败码 SP_API_403），不能和同步的预期状态混在一起。
// 固定美国站；限速沿用按店铺的令牌桶（接口族 aplus/2020-11-01 与 uploads/2020-11-01 各自限速）。

export const APLUS_PATH = '/aplus/2020-11-01'
export const APLUS_UPLOAD_PATH = '/uploads/2020-11-01/uploadDestinations/aplus/2020-11-01/contentDocuments'

/** 403：缺品牌备案或 A+ 内容角色。 */
export const isAplusForbidden = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403
/** 请求内容被拒或对象不存在（400、404）：只影响这一条，不是暂时性错误。 */
export const isAplusRejected = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && (error.status === 400 || error.status === 404)

async function readGuard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (isAplusForbidden(error)) throw new NonRetryableError(APLUS_ROLE_MISSING, '店铺没有品牌备案或没有获批 A+ 内容角色，A+ 内容无法同步')
    throw error
  }
}

const key = (value: string) => encodeURIComponent(value)
const marketplace = (extra: Record<string, string> = {}) => ({ marketplaceId: APLUS_MARKETPLACE_ID, ...extra })

/** 要提交给亚马逊的内容文档（创建与更新共用）：模块结构原样放进 contentModuleList。 */
export interface AplusDocumentInput {
  name: string
  contentType: string
  locale: string
  contentModuleList: unknown[]
}

export class AplusApi {
  constructor(private readonly client: AmazonSpApiClient) {}

  /** 内容列表，翻页用上一页的 nextPageToken。 */
  listContents(pageToken?: string) {
    return readGuard(() => this.client.request({ path: `${APLUS_PATH}/contentDocuments`, query: marketplace(pageToken ? { pageToken } : {}) }))
  }

  /** 一份内容的详情（模块与元数据）。 */
  getContent(contentKey: string) {
    return readGuard(() => this.client.request({ path: `${APLUS_PATH}/contentDocuments/${key(contentKey)}`, query: marketplace({ includedDataSet: 'CONTENTS,METADATA' }) }))
  }

  /** 一份内容关联的 ASIN。 */
  listAsins(contentKey: string, pageToken?: string) {
    return readGuard(() =>
      this.client.request({ path: `${APLUS_PATH}/contentDocuments/${key(contentKey)}/asins`, query: marketplace({ includedDataSet: 'METADATA', ...(pageToken ? { pageToken } : {}) }) }),
    )
  }

  /** 一个 ASIN 的发布记录（里面可能有多份内容的记录，由调用方按内容引用键匹配）。 */
  listPublishRecords(asin: string, pageToken?: string) {
    return readGuard(() => this.client.request({ path: `${APLUS_PATH}/contentPublishRecords`, query: marketplace({ asin, ...(pageToken ? { pageToken } : {}) }) }))
  }

  /** 创建内容（草稿）。 */
  createContent(document: AplusDocumentInput) {
    return this.client.request({ method: 'POST', path: `${APLUS_PATH}/contentDocuments`, query: marketplace(), body: { contentDocument: document } })
  }

  /** 更新内容：提交完整快照（名称、类型、语言与全部模块）。 */
  updateContent(contentKey: string, document: AplusDocumentInput) {
    return this.client.request({ method: 'POST', path: `${APLUS_PATH}/contentDocuments/${key(contentKey)}`, query: marketplace(), body: { contentDocument: document } })
  }

  /** 把内容关联到一批 ASIN。 */
  associateAsins(contentKey: string, asins: readonly string[]) {
    return this.client.request({ method: 'POST', path: `${APLUS_PATH}/contentDocuments/${key(contentKey)}/asins`, query: marketplace(), body: { asinSet: [...asins] } })
  }

  /** 提交审核。 */
  submitForApproval(contentKey: string) {
    return this.client.request({ method: 'POST', path: `${APLUS_PATH}/contentDocuments/${key(contentKey)}/approvalSubmissions`, query: marketplace() })
  }

  /**
   * 上传一张图片：先向上传接口要目的地（带图片的 MD5 与类型），再把字节 PUT 到返回的地址；返回的 uploadDestinationId 之后用在模块的图片字段里。
   * PUT 只带接口返回的请求头，不带 SP-API 的授权头（那个地址是预签名的对象存储地址，多带授权头会被拒绝，也会把令牌泄露给第三方）。
   * 上传失败（网络错误、非 2xx）一律以不可重试的 APL_UPLOAD_FAILED 结束：文件还留在我们自己的存储里，用户重新提交即可。
   */
  async uploadImage(bytes: Buffer, contentType: string): Promise<{ uploadDestinationId: string }> {
    const md5 = createHash('md5').update(bytes).digest('base64')
    const body = await this.client.request({ method: 'POST', path: APLUS_UPLOAD_PATH, query: marketplace({ contentMD5: md5, contentType }) })
    const destination = parseUploadDestination(body)
    const hasContentType = Object.keys(destination.headers).some(name => name.toLowerCase() === 'content-type')
    const headers = hasContentType ? destination.headers : { ...destination.headers, 'Content-Type': contentType }
    const uploadUrl = assertRemoteUrl(destination.url, '图片上传地址')
    let response: Response
    try {
      response = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(bytes) })
    } catch {
      throw new NonRetryableError('APL_UPLOAD_FAILED', '图片没能传到亚马逊的上传地址（网络错误）')
    }
    if (!response.ok) throw new NonRetryableError('APL_UPLOAD_FAILED', `图片没能传到亚马逊的上传地址（${response.status}）`)
    return { uploadDestinationId: destination.uploadDestinationId }
  }
}
