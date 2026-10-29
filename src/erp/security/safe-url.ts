// 链接与跳转的安全收口（P5-13，跨站脚本核查）：页面里凡是“来自服务端或外部数据”的网址，都先过这里再放进 href、window.open 或路由跳转。
// 只放行 http、https 与本站相对路径；javascript:、data:、vbscript: 等一律丢弃。

/** 外部链接：返回可以放进 href 的地址，不安全返回 undefined。本站相对路径（以单个 / 开头）原样放行。 */
export function safeHttpUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  // 控制字符（含换行、制表）可以拆开协议名绕过检查，直接拒绝
  // eslint-disable-next-line no-control-regex
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.includes('\\')) return undefined
  if (text.startsWith('/')) return text.startsWith('//') ? undefined : text
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** 在新标签页打开服务端签发的下载链接；不安全的链接不打开，返回是否已打开。 */
export function openSignedUrl(value: string | null | undefined): boolean {
  const url = safeHttpUrl(value)
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

/** 登录后的跳转目标：只能是工作台内部路径（/app 开头、不含协议与双斜杠），其余回到默认入口。 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/app'): string {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback
  if (value !== '/app' && !value.startsWith('/app/') && !value.startsWith('/app?')) return fallback
  return value
}
