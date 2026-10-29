import { SCOPE_DEFAULTS } from '../scope/params'

// 地址栏参数的读写（P1-03）：
// - 读：所有值一律按字符串读取，不做 JSON 猜测（否则店铺编号 "123" 会被读成数字而校验失败）；
//   具体类型转换由各页面的校验规则（zod）完成；
// - 写：数组用逗号连接；范围参数等于默认值时不写入，保持地址简洁。

export function parseSearch(searchStr: string): Record<string, string> {
  const text = searchStr.startsWith('?') ? searchStr.slice(1) : searchStr
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const key of Object.keys(search).sort()) {
    const value = search[key]
    if (value === undefined || value === null || value === '') continue
    if ((SCOPE_DEFAULTS as Record<string, unknown>)[key] === value) continue
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','))
    } else if (typeof value === 'object') {
      continue
    } else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}
