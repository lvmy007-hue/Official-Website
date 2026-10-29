import { createHmac } from 'node:crypto'

// 阿里云对象存储（OSS）V1 签名：请求头签名（服务端自己的请求）与 URL 签名（给浏览器的短时链接）。
// StringToSign = VERB \n Content-MD5 \n Content-Type \n Date(或 Expires) \n CanonicalizedOSSHeaders + CanonicalizedResource
// 签名 = Base64(HMAC-SHA1(AccessKeySecret, StringToSign))

/** 参与签名的子资源（只列出本适配器会用到的）。 */
const SIGNED_SUBRESOURCES = new Set(['uploads', 'uploadId', 'partNumber'])

export function canonicalizedOssHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), value.trim()] as const)
    .filter(([name]) => name.startsWith('x-oss-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}\n`)
    .join('')
}

/** `/bucket/object` 加上排序后的子资源（`?partNumber=1&uploadId=xxx`）；值是未经 URL 编码的原值。 */
export function canonicalizedResource(bucket: string, key: string, query: Record<string, string | undefined> = {}): string {
  const subresources = Object.keys(query)
    .filter(name => SIGNED_SUBRESOURCES.has(name))
    .sort()
  const suffix = subresources.map(name => (query[name] === undefined || query[name] === '' ? name : `${name}=${query[name]}`)).join('&')
  return `/${bucket}/${key}${suffix ? `?${suffix}` : ''}`
}

export interface StringToSignInput {
  verb: string
  contentMd5?: string
  contentType?: string
  /** 请求头签名用 Date 头的值；URL 签名用 Expires（秒级时间戳字符串）。 */
  dateOrExpires: string
  headers?: Record<string, string>
  resource: string
}

export function stringToSign(input: StringToSignInput): string {
  return `${input.verb}\n${input.contentMd5 ?? ''}\n${input.contentType ?? ''}\n${input.dateOrExpires}\n${canonicalizedOssHeaders(input.headers ?? {})}${input.resource}`
}

export function signV1(accessKeySecret: string, input: StringToSignInput): string {
  return createHmac('sha1', accessKeySecret).update(stringToSign(input), 'utf8').digest('base64')
}

export const authorizationHeader = (accessKeyId: string, signature: string) => `OSS ${accessKeyId}:${signature}`
