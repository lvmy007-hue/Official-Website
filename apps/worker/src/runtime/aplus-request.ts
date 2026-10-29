import { APLUS_ASIN_PATTERN, APLUS_CONTENT_TYPES, APLUS_UPLOAD_TYPES, type AplusContentType } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'

// A+ 写入记录（AplusWriteRun.requestJson）的读取（P4-14）。接口服务受理时已经校验过，这里按约定的形状再兜底解析一遍：
// 缺字段、类型不对一律以不可重试的 APL_REQUEST_INVALID 结束，不向亚马逊发任何请求。约定的形状：
//   CREATE     { name, contentType: 'EBC' | 'EMC', locale, contentModuleList }
//   UPDATE     { name, contentModuleList }（完整快照）
//   ASSOCIATE  { asins: string[] }
//   SUBMIT     {}
//   UPLOAD     { storeId, objectKey, fileName, contentType, sizeBytes, width, height }（没有 contentId；这里只用 objectKey、contentType 与 fileName）

export const APLUS_REQUEST_INVALID = 'APL_REQUEST_INVALID'

export type AplusRequest =
  | { kind: 'CREATE'; name: string; contentType: AplusContentType; locale: string; contentModuleList: unknown[] }
  | { kind: 'UPDATE'; name: string; contentModuleList: unknown[] }
  | { kind: 'ASSOCIATE'; asins: string[] }
  | { kind: 'SUBMIT' }
  | { kind: 'UPLOAD'; objectKey: string; contentType: string; fileName: string | null }

const invalid = (why: string) => new NonRetryableError(APLUS_REQUEST_INVALID, `A+ 写入请求不完整：${why}`)
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** 按写入记录的类型读取请求内容；类型不认识也算不完整。 */
export function parseAplusRequest(kind: string, json: unknown): AplusRequest {
  const body = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const modules = () => {
    if (!Array.isArray(body.contentModuleList)) throw invalid('缺少模块列表')
    return body.contentModuleList as unknown[]
  }
  switch (kind) {
    case 'CREATE': {
      const name = text(body.name)
      const locale = text(body.locale)
      const contentType = APLUS_CONTENT_TYPES.find(type => type === body.contentType)
      if (!name || !locale || !contentType) throw invalid('创建需要名称、类型与语言')
      return { kind, name, contentType, locale, contentModuleList: modules() }
    }
    case 'UPDATE': {
      const name = text(body.name)
      if (!name) throw invalid('保存需要名称')
      return { kind, name, contentModuleList: modules() }
    }
    case 'ASSOCIATE': {
      const raw = Array.isArray(body.asins) ? body.asins : []
      const asins = [...new Set(raw.map(item => (typeof item === 'string' ? item.trim().toUpperCase() : '')))]
      if (asins.length === 0 || asins.some(asin => !APLUS_ASIN_PATTERN.test(asin))) throw invalid('关联需要至少一个格式正确的 ASIN')
      return { kind, asins }
    }
    case 'SUBMIT':
      return { kind }
    case 'UPLOAD': {
      const objectKey = text(body.objectKey)
      const contentType = APLUS_UPLOAD_TYPES.find(type => type === body.contentType)
      if (!objectKey || !contentType) throw invalid('上传需要文件路径与图片类型（JPEG 或 PNG）')
      return { kind, objectKey, contentType, fileName: text(body.fileName) }
    }
    default:
      throw invalid('不认识的写入类型')
  }
}
