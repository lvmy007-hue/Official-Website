import { NonRetryableError } from '@nova/workflow'
import { isIP } from 'node:net'

// 亚马逊返回的下载地址、上传地址的出站校验（P5-13，服务端请求伪造核查）。
// 报告文档、广告报告分片、数据中心文档、刊登反馈文件的地址都来自亚马逊接口的响应，不是用户输入；
// 但出站请求发生在内网里，所以仍要求：必须是 https，且不能指向本机、内网或云厂商的元数据地址。
// 这是“按字面地址判断”的防线：域名解析到内网地址（DNS 重绑定）和重定向跳转到内网，这里挡不住，需要出口网络策略配合（见 docs/security）。

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

function ipv4Blocked(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b] = parts as [number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 运营商级 NAT
    (a === 169 && b === 254) || // 链路本地，含云厂商元数据地址 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // 组播与保留
  )
}

function ipv6Blocked(address: string): boolean {
  const text = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (text === '::' || text === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (mapped) return ipv4Blocked(mapped[1]!)
  // URL 解析会把 ::ffff:10.0.0.1 规范成十六进制写法 ::ffff:a00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text)
  if (hex) {
    const high = parseInt(hex[1]!, 16)
    const low = parseInt(hex[2]!, 16)
    return ipv4Blocked([high >> 8, high & 255, low >> 8, low & 255].join('.'))
  }
  // 唯一本地 fc00::/7、链路本地 fe80::/10、组播 ff00::/8
  return /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || text.startsWith('ff')
}

/** 地址是否安全：https，主机不是本机、内网、链路本地或元数据地址。返回拒绝原因，安全返回 null。 */
export function remoteUrlProblem(value: string | URL): string | null {
  let url: URL
  try {
    url = typeof value === 'string' ? new URL(value) : value
  } catch {
    return '地址格式不正确'
  }
  if (url.protocol !== 'https:') return '不是加密地址'
  if (url.username || url.password) return '地址里带有账号信息'
  const host = url.hostname.toLowerCase()
  if (!host) return '没有主机名'
  const bare = host.replace(/^\[|\]$/g, '')
  const family = isIP(bare)
  if (family === 4 && ipv4Blocked(bare)) return '指向内网或保留地址'
  if (family === 6 && ipv6Blocked(bare)) return '指向内网或保留地址'
  if (host === 'localhost' || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return '指向本机或内网域名'
  return null
}

/** 校验失败抛“不可重试”错误（同样的地址重试只会重复失败）；通过则返回原地址文本。 */
export function assertRemoteUrl(value: string | URL, label: string): string {
  const problem = remoteUrlProblem(value)
  if (problem) throw new NonRetryableError('REMOTE_URL_REJECTED', `${label}被拒绝：${problem}`)
  return typeof value === 'string' ? value : value.toString()
}
