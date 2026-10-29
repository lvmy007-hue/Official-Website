#!/usr/bin/env node
// CLI 中文会话板：只显示干什么、生成什么、改什么、在想什么、要注意什么。不刷英文碎片。
//
// 用法（项目根，单独开一个终端）：node scripts/cli-sync.mjs
import { watch, existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actionZh, attendZh, fileZh, mergeStream, speechZh, thinkZh } from './cli-zh.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const progressFile = join(root, 'docs/erp-plan/PROGRESS.md')
const planFile = join(root, 'docs/erp-plan/14-execution-plan.md')
const loopLog = process.env.CLI_SYNC_LOG || join(tmpdir(), 'agent-loop.log')
const sessionFile = join(tmpdir(), 'erp-cli-session.json')
const boardFile = join(tmpdir(), 'erp-cli-board.txt')
const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.css', '.sql', '.md', '.json'])
const SKIP = /(?:^|[\\/])(?:node_modules|dist|dist-ssr|coverage|\.git|\.turbo|generated|shots)(?:[\\/]|$)/i
const lastText = new Map()
const knownFiles = new Set()
const pending = new Map()
const generated = new Map()
const modified = new Map()
const recent = []
let thinkBuf = ''
let speechBuf = ''
let lastSessionId = ''
let doing = { title: '未知', status: '?', lastDone: '?', ci: '?' }
let current = '还没开始动作'
let lastBoard = ''

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const field = (text, key) => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim() ?? '?'

function note(text) {
  if (!text) return
  const line = `${stamp()}  ${text}`
  if (recent[0] === line || recent[0]?.endsWith(text)) return
  recent.unshift(line)
  if (recent.length > 8) recent.pop()
}

function readUtf8(path) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (!/EBUSY|EPERM|EACCES/.test(error?.code ?? '') || attempt === 5) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
  return ''
}

function packageTitle() {
  if (!existsSync(progressFile)) return
  const text = readUtf8(progressFile)
  const next = field(text, 'NEXT')
  let title = next
  if (existsSync(planFile)) {
    const hit = readUtf8(planFile).match(new RegExp(`^##### ${next} (.+)$`, 'm'))
    if (hit) title = `${next} ${hit[1].trim()}`
  }
  doing = { title, status: field(text, 'STATUS'), lastDone: field(text, 'LAST_DONE'), ci: field(text, 'LAST_CI') }
}

function listOf(map) {
  const items = [...map.entries()].slice(-4).map(([path, hint]) => (hint ? `${fileZh(path)}（${hint}）` : fileZh(path)))
  return items.length ? items.join('、') : '还没有'
}

function renderBoard() {
  const think = thinkZh(thinkBuf) || (thinkBuf.trim() ? '还在组织思路，等它想完一整句再更新' : '暂无')
  const attend = attendZh(thinkBuf) || attendZh(speechBuf) || '暂无特别风险'
  const talk = speechZh(speechBuf)
  return [
    '──────── CLI 中文会话 ────────',
    `正在做  ${doing.title}`,
    `状态    ${doing.status}  上一包 ${doing.lastDone}  CI ${doing.ci}`,
    `干什么  ${current}`,
    talk ? `说明    ${talk}` : null,
    `生成    ${listOf(generated)}`,
    `修改    ${listOf(modified)}`,
    `思考    ${think}`,
    `注意    ${attend}`,
    '最近',
    ...(recent.length ? recent.map(line => `  ${line}`) : ['  （等待 CLI 动作）']),
    '────────────────────────────',
  ]
    .filter(Boolean)
    .join('\n')
}

function paint() {
  const board = renderBoard()
  if (board === lastBoard) return
  try {
    writeFileSync(boardFile, `${board}\n`, 'utf8')
  } catch {
    /* 看板文件写失败不挡刷新 */
  }
  if (!process.stdout.writable || process.stdout.writableNeedDrain) return
  lastBoard = board
  process.stdout.write(`\n${board}\n`)
}

function onFileChange(fullPath) {
  if (SKIP.test(fullPath) || !CODE_EXT.has(extname(fullPath))) return
  let next
  try {
    next = readFileSync(fullPath, 'utf8')
  } catch {
    return
  }
  const rel = relative(root, fullPath).replace(/\\/g, '/')
  const prev = lastText.get(fullPath)
  lastText.set(fullPath, next)
  if (prev === next) return
  const existed = knownFiles.has(fullPath)
  const lines = next.split('\n').length - String(prev ?? '').split('\n').length
  const hint = `${lines >= 0 ? '+' : ''}${lines} 行`
  if (!existed) {
    knownFiles.add(fullPath)
    generated.set(rel, hint)
    current = `正在生成 ${fileZh(rel)}`
    note(`生成 ${fileZh(rel)}`)
  } else if (prev !== undefined) {
    modified.set(rel, hint)
    current = `正在改 ${fileZh(rel)}`
    note(`修改 ${fileZh(rel)} ${hint}`)
  }
  paint()
}

function seedTree(dir) {
  if (!existsSync(dir)) return
  const stack = [dir]
  while (stack.length) {
    const currentDir = stack.pop()
    let entries
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(currentDir, entry.name)
      if (SKIP.test(full.replace(/\\/g, '/'))) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!CODE_EXT.has(extname(entry.name))) continue
      try {
        if (statSync(full).size > 500_000) continue
        lastText.set(full, readFileSync(full, 'utf8'))
        knownFiles.add(full)
      } catch {
        /* 跳过正在写的文件 */
      }
    }
  }
}

function watchTree(dir) {
  if (!existsSync(dir)) return
  seedTree(dir)
  try {
    watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return
      const full = resolve(dir, file)
      clearTimeout(pending.get(full))
      pending.set(
        full,
        setTimeout(() => onFileChange(full), 160),
      )
    })
  } catch (error) {
    note(`监视失败 ${error instanceof Error ? error.message : error}`)
  }
}

function peekEncoding(path) {
  try {
    const fd = openSync(path, 'r')
    const head = Buffer.alloc(8)
    const n = readSync(fd, head, 0, 8, 0)
    closeSync(fd)
    if (n >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le'
    if (n >= 4 && head[1] === 0 && head[3] === 0) return 'utf16le'
  } catch {
    /* 文件刚创建时读不到头 */
  }
  return 'utf8'
}

function ingestLog(line) {
  const text = line
    .replace(/\0/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
  if (/DEP0190|FullyQualifiedErrorId|CategoryInfo|所在位置 C:\\/.test(text)) return
  if (text.includes('会话开始')) {
    thinkBuf = ''
    speechBuf = ''
    current = '新会话刚开始'
    note(text.slice(0, 80))
  }
  if (text.startsWith('思考')) {
    thinkBuf = mergeStream(thinkBuf, text.replace(/^思考\s*/, ''))
    return
  }
  if (text.startsWith('会话') || text.startsWith('Agent:')) {
    speechBuf = mergeStream(speechBuf, text.replace(/^(?:会话|Agent:)\s*/, ''))
    const zh = speechZh(speechBuf)
    if (zh) current = zh.slice(0, 80)
    return
  }
  if (text.startsWith('动作') || text.startsWith('工具')) {
    current = actionZh(text)
    note(current)
    return
  }
  if (/独立核验|上次 CI|确认为真实失败|全部完成|本轮完成|回退点/.test(text)) {
    current = text.replace(/\s+/g, ' ').trim().slice(0, 80)
    note(current)
    return
  }
  if (/^=== /.test(text) && /prepare|typecheck|test|build|website|audit/i.test(text)) {
    current = `全量 CI：${text.replace(/=+/g, '').trim().slice(0, 40)}`
    note(current)
    return
  }
  if (/Test Files|FAIL |AssertionError|error TS\d+/.test(text)) {
    current = text.replace(/\s+/g, ' ').trim().slice(0, 80)
    note(current)
    return
  }
  if (/^\s*✓ /.test(text)) {
    current = `全量 CI 测试：${text
      .replace(/^\s*✓\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 56)}`
  }
}

function tailFile(path, onLine) {
  let offset = 0
  let encoding = 'utf8'
  let carry = ''
  const pump = () => {
    if (!existsSync(path)) return
    let fd
    try {
      encoding = peekEncoding(path)
      const size = statSync(path).size
      if (encoding === 'utf16le' && offset % 2) offset -= 1
      if (size < offset) offset = 0
      if (size === offset) return
      fd = openSync(path, 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      offset = size
      const start = encoding === 'utf16le' && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0
      carry += buf.slice(start).toString(encoding)
      const lines = carry.split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const row of lines) if (row.replace(/\0/g, '').trim()) onLine(row)
      paint()
    } catch {
      /* 日志正在写时偶发失败 */
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  if (existsSync(path)) offset = statSync(path).size
  setInterval(pump, 350)
}

function pollSession() {
  if (!existsSync(sessionFile)) return
  try {
    const row = JSON.parse(readUtf8(sessionFile))
    if (row.sessionId && row.sessionId !== lastSessionId) {
      lastSessionId = row.sessionId
      thinkBuf = row.thinking ?? ''
      speechBuf = row.speech ?? ''
      current = row.action ? actionZh(row.action) : '新会话刚开始'
      note(`新会话 ${row.model || ''}`.trim())
    } else {
      thinkBuf = mergeStream(thinkBuf, row.thinking ?? '')
      speechBuf = mergeStream(speechBuf, row.speech ?? '')
      if (row.action) current = actionZh(row.action)
    }
    paint()
  } catch {
    /* 快照写到一半忽略 */
  }
}

if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8')
try {
  packageTitle()
} catch {
  /* 进度文件正在写 */
}
for (const dir of ['src/erp', 'apps', 'packages', 'docs/erp-plan', 'database', 'scripts']) watchTree(join(root, dir))
watch(progressFile, () => {
  try {
    packageTitle()
    paint()
  } catch {
    /* 进度文件正在写，等下一轮刷新 */
  }
})
tailFile(loopLog, ingestLog)
setInterval(pollSession, 400)
setInterval(paint, 1200)
paint()
