// 自定义指标公式（P6-32）：四则运算与括号。引用字典编号（M-001）或自定义键（C-…），
// 也接受与字典名称完全一致的中文名（多名则拒绝，避免“销售额”这种简称对上好几条）。

export type Expr = { t: 'num'; v: number } | { t: 'ref'; id: string } | { t: 'neg'; x: Expr } | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Expr; r: Expr }

export interface MetricName {
  id: string
  name: string
}

export interface ParsedExpr {
  ast: Expr
  refs: string[]
  issues: string[]
}

export const EXPR_MAX_LEN = 400
export const EXPR_MAX_DEPTH = 12
export const EXPR_MAX_NODES = 64

type Tok = { k: 'num'; v: number } | { k: 'id'; id: string } | { k: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' }

const OPS: Record<string, '+' | '-' | '*' | '/' | '(' | ')'> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '(': '(',
  ')': ')',
  '（': '(',
  '）': ')',
}

const normalize = (text: string) => text.replace(/[−－]/g, '-').replace(/×/g, '*').replace(/÷/g, '/')

function longestName(text: string, index: number, known: readonly MetricName[]): { id: string; length: number } | { ambiguous: string; length: number } | null {
  let best: MetricName | null = null
  let ties = 0
  for (const item of known) {
    if (!text.startsWith(item.name, index) || /^[A-Z0-9]/.test(item.name)) continue
    if (!best || item.name.length > best.name.length) {
      best = item
      ties = 1
    } else if (item.name.length === best.name.length) ties += 1
  }
  if (!best) return null
  if (ties > 1) return { ambiguous: best.name, length: best.name.length }
  return { id: best.id, length: best.name.length }
}

function tokenize(text: string, known: readonly MetricName[], issues: string[]): Tok[] {
  const tokens: Tok[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i += 1
      continue
    }
    const named = longestName(text, i, known)
    if (named && 'ambiguous' in named) {
      issues.push(`“${named.ambiguous}”对应多个指标，请改用编号`)
      tokens.push({ k: 'id', id: named.ambiguous })
      i += named.length
      continue
    }
    if (named) {
      tokens.push({ k: 'id', id: named.id })
      i += named.length
      continue
    }
    const op = OPS[ch]
    if (op) {
      tokens.push({ k: 'op', op })
      i += 1
      continue
    }
    if (ch >= '0' && ch <= '9') {
      const start = i
      i += 1
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i += 1
      if (text[i] === '.' && text[i + 1]! >= '0' && text[i + 1]! <= '9') {
        i += 2
        while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i += 1
      }
      tokens.push({ k: 'num', v: Number(text.slice(start, i)) })
      continue
    }
    const id = /^[A-Z][A-Z0-9]*-[A-Z0-9]+/.exec(text.slice(i))
    if (id) {
      if (!known.some(item => item.id === id[0])) issues.push(`引用了不存在的指标 ${id[0]}`)
      tokens.push({ k: 'id', id: id[0] })
      i += id[0].length
      continue
    }
    const start = i
    while (i < text.length && !OPS[text[i]!] && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '\n') i += 1
    const word = text.slice(start, i)
    const hits = known.filter(item => item.name === word)
    if (hits.length === 1) tokens.push({ k: 'id', id: hits[0]!.id })
    else {
      if (hits.length > 1) issues.push(`“${word}”对应多个指标，请改用编号`)
      else issues.push(`引用了不存在的指标 ${word}`)
      tokens.push({ k: 'id', id: word })
    }
  }
  return tokens
}

function collectRefs(node: Expr, into: Set<string>) {
  if (node.t === 'ref') into.add(node.id)
  else if (node.t === 'neg') collectRefs(node.x, into)
  else if (node.t === 'bin') {
    collectRefs(node.l, into)
    collectRefs(node.r, into)
  }
}

/** 常量折叠：除数在保存时就能确定是 0（含 2-2）则拒绝。含指标引用的不算常量。 */
export function constantDivisorZero(node: Expr): boolean {
  const walk = (current: Expr): { value: number | null; bad: boolean } => {
    if (current.t === 'num') return { value: current.v, bad: false }
    if (current.t === 'ref') return { value: null, bad: false }
    if (current.t === 'neg') {
      const inner = walk(current.x)
      return { value: inner.value === null ? null : -inner.value, bad: inner.bad }
    }
    const left = walk(current.l)
    const right = walk(current.r)
    const bad = left.bad || right.bad || (current.op === '/' && right.value === 0)
    if (left.value === null || right.value === null) return { value: null, bad }
    if (current.op === '+') return { value: left.value + right.value, bad }
    if (current.op === '-') return { value: left.value - right.value, bad }
    if (current.op === '*') return { value: left.value * right.value, bad }
    return { value: right.value === 0 ? null : left.value / right.value, bad }
  }
  return walk(node).bad
}

export function parseMetricExpr(raw: string, known: readonly MetricName[]): ParsedExpr {
  const issues: string[] = []
  const text = normalize(raw ?? '')
  if (!text.trim()) issues.push('公式不能为空')
  if (text.length > EXPR_MAX_LEN) issues.push(`公式最长 ${EXPR_MAX_LEN} 个字符`)
  let nodes = 0
  const bump = () => {
    nodes += 1
    if (nodes > EXPR_MAX_NODES) issues.push(`公式最多 ${EXPR_MAX_NODES} 个节点`)
  }
  const tokens = text.trim() ? tokenize(text, known, issues) : []
  let at = 0
  const peek = () => tokens[at]
  const eatOp = (op: string) => {
    const token = peek()
    if (token?.k === 'op' && token.op === op) {
      at += 1
      return true
    }
    return false
  }
  const parseExpr = (depth: number): Expr => {
    if (depth > EXPR_MAX_DEPTH) {
      issues.push(`公式最多嵌套 ${EXPR_MAX_DEPTH} 层`)
      return { t: 'num', v: 0 }
    }
    let left = parseTerm(depth)
    while ((peek()?.k === 'op' && (peek() as { op: string }).op === '+') || (peek()?.k === 'op' && (peek() as { op: string }).op === '-')) {
      const op = (tokens[at] as { op: '+' | '-' }).op
      at += 1
      const right = parseTerm(depth)
      bump()
      left = { t: 'bin', op, l: left, r: right }
    }
    return left
  }
  const parseTerm = (depth: number): Expr => {
    let left = parseUnary(depth)
    while (peek()?.k === 'op' && ((peek() as { op: string }).op === '*' || (peek() as { op: string }).op === '/')) {
      const op = (tokens[at] as { op: '*' | '/' }).op
      at += 1
      const right = parseUnary(depth)
      bump()
      left = { t: 'bin', op, l: left, r: right }
    }
    return left
  }
  const parseUnary = (depth: number): Expr => {
    if (eatOp('-')) {
      bump()
      return { t: 'neg', x: parseUnary(depth + 1) }
    }
    if (eatOp('+')) return parseUnary(depth + 1)
    return parsePrimary(depth)
  }
  const parsePrimary = (depth: number): Expr => {
    const token = peek()
    if (!token) {
      issues.push('公式不完整')
      return { t: 'num', v: 0 }
    }
    if (token.k === 'num') {
      at += 1
      bump()
      return { t: 'num', v: token.v }
    }
    if (token.k === 'id') {
      at += 1
      bump()
      return { t: 'ref', id: token.id }
    }
    if (token.k === 'op' && token.op === '(') {
      at += 1
      const inner = parseExpr(depth + 1)
      if (!eatOp(')')) issues.push('括号没有闭合')
      return inner
    }
    issues.push('公式里有无法识别的符号')
    at += 1
    return { t: 'num', v: 0 }
  }
  const ast = tokens.length ? parseExpr(1) : { t: 'num' as const, v: 0 }
  if (at < tokens.length) issues.push('公式末尾有多余内容')
  if (constantDivisorZero(ast)) issues.push('不能除以常数 0')
  const refs = new Set<string>()
  collectRefs(ast, refs)
  return { ast, refs: [...refs], issues: [...new Set(issues)] }
}

/** 运行时求值：引用没有值不当 0；除以 0 得空。 */
export function evalMetricExpr(ast: Expr, values: Readonly<Record<string, number | null | undefined>>): number | null {
  const walk = (node: Expr): number | null => {
    if (node.t === 'num') return node.v
    if (node.t === 'ref') {
      const value = values[node.id]
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    if (node.t === 'neg') {
      const value = walk(node.x)
      return value === null ? null : -value
    }
    const left = walk(node.l)
    const right = walk(node.r)
    if (left === null || right === null) return null
    if (node.op === '+') return left + right
    if (node.op === '-') return left - right
    if (node.op === '*') return left * right
    return right === 0 ? null : left / right
  }
  return walk(ast)
}

/** 自定义指标之间的循环引用。只沿 C- 键继续，字典指标没有出边。 */
export function metricCycle(start: string, edges: ReadonlyMap<string, readonly string[]>): boolean {
  const stack = new Set<string>()
  const seen = new Set<string>()
  const visit = (key: string): boolean => {
    if (stack.has(key)) return true
    if (seen.has(key)) return false
    seen.add(key)
    stack.add(key)
    for (const next of edges.get(key) ?? []) {
      if (next.startsWith('C-') && visit(next)) return true
    }
    stack.delete(key)
    return false
  }
  return visit(start)
}

export function expressionText(stored: unknown): string {
  if (stored && typeof stored === 'object' && 'text' in stored && typeof (stored as { text: unknown }).text === 'string') return (stored as { text: string }).text
  return ''
}

export function expressionAst(stored: unknown): Expr | null {
  if (!stored || typeof stored !== 'object' || !('ast' in stored)) return null
  const ast = (stored as { ast: unknown }).ast
  return ast && typeof ast === 'object' && 't' in ast ? (ast as Expr) : null
}
