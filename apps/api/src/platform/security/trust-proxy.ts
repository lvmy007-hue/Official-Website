// 代理信任（P1-17，12.9 第 9 条）：只信任我方网关，才能从 X-Forwarded-For 里拿到真实客户端地址。
// 信任范围过宽会让攻击者伪造地址绕过限流与登录锁定；不配置则不信任任何代理（直接看连接地址）。
//
// TRUST_PROXY 取值：
//   未设置、false      不信任任何代理（默认）
//   正整数 N           信任前面 N 跳代理（例如网关只有一层写 1）
//   地址列表           逗号分隔的地址、网段或关键字：loopback、linklocal、uniquelocal，例如 10.0.0.0/8,172.16.0.5
//   true               不允许：等于信任一切来源，会被拒绝

export type TrustProxySetting = false | number | string[]

export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const text = (value ?? '').trim()
  if (text === '' || text.toLowerCase() === 'false') return false
  if (text.toLowerCase() === 'true') throw new Error('TRUST_PROXY 不能设为 true（会信任任何来源伪造的地址）。请写网关的地址或网段，或写信任的代理层数')
  if (/^\d+$/.test(text)) {
    const hops = Number(text)
    if (hops < 1 || hops > 5) throw new Error('TRUST_PROXY 的代理层数应在 1 到 5 之间')
    return hops
  }
  const list = text
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  const valid = (item: string) => ['loopback', 'linklocal', 'uniquelocal'].includes(item) || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(item)
  const bad = list.find(item => !valid(item))
  if (bad) throw new Error(`TRUST_PROXY 里的 "${bad}" 不是合法的地址、网段或关键字`)
  return list
}
