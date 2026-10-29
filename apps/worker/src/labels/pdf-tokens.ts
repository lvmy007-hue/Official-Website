// 页面内容流的词法分析（PDF 操作符与操作数）：只认 pdf-content.ts 需要的几类记号，读不明白的东西交给上层按“不确定”处理。

export type Token = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'str'; v: string; hex: boolean } | { t: 'op'; v: string } | { t: 'arr'; v: Token[] }

export const WHITESPACE = new Set([0, 9, 10, 12, 13, 32])
export const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

export function tokenize(source: string): Token[] {
  let pos = 0
  const readString = (): string => {
    let depth = 1
    let out = ''
    pos += 1
    while (pos < source.length && depth > 0) {
      const char = source[pos]!
      if (char === '\\') {
        const next = source[pos + 1] ?? ''
        pos += 2
        if (next === 'n') out += '\n'
        else if (next === 'r') out += '\r'
        else if (next === 't') out += '\t'
        else if (/[0-7]/.test(next)) {
          let octal = next
          while (octal.length < 3 && /[0-7]/.test(source[pos] ?? '')) octal += source[pos++]
          out += String.fromCharCode(parseInt(octal, 8) & 0xff)
        } else if (next !== '\n' && next !== '\r') out += next
        continue
      }
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (depth > 0) out += char
      pos += 1
    }
    return out
  }
  const readList = (): Token[] => {
    const items: Token[] = []
    while (pos < source.length) {
      const token = next()
      if (token === 'end') return items
      if (token) items.push(token)
    }
    return items
  }
  const next = (): Token | 'end' | null => {
    while (pos < source.length) {
      const code = source.charCodeAt(pos)
      if (WHITESPACE.has(code)) pos += 1
      else if (source[pos] === '%') while (pos < source.length && source[pos] !== '\n' && source[pos] !== '\r') pos += 1
      else break
    }
    if (pos >= source.length) return null
    const char = source[pos]!
    if (char === '(') return { t: 'str', v: readString(), hex: false }
    if (char === '[') {
      pos += 1
      return { t: 'arr', v: readList() }
    }
    if (char === ']') {
      pos += 1
      return 'end'
    }
    if (char === '<') {
      if (source[pos + 1] === '<') {
        pos += 2
        return { t: 'op', v: '<<' }
      }
      const close = source.indexOf('>', pos)
      const end = close === -1 ? source.length : close
      const hex = source.slice(pos + 1, end).replace(/\s+/g, '')
      pos = end + 1
      return { t: 'str', v: hex, hex: true }
    }
    if (char === '>') {
      pos += source[pos + 1] === '>' ? 2 : 1
      return { t: 'op', v: '>>' }
    }
    if (char === '/') {
      let end = pos + 1
      while (end < source.length && !WHITESPACE.has(source.charCodeAt(end)) && !DELIMITERS.has(source[end]!)) end += 1
      const name = source.slice(pos + 1, end)
      pos = end
      return { t: 'name', v: name }
    }
    if (char === '{' || char === '}' || char === ')') {
      pos += 1
      return null
    }
    let end = pos
    while (end < source.length && !WHITESPACE.has(source.charCodeAt(end)) && !DELIMITERS.has(source[end]!)) end += 1
    const word = source.slice(pos, end)
    pos = end
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word) }
    return { t: 'op', v: word }
  }
  const tokens: Token[] = []
  while (pos < source.length) {
    const before = pos
    const token = next()
    if (token && token !== 'end') tokens.push(token)
    if (pos === before) pos += 1
  }
  return tokens
}
