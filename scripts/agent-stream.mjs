// 把 Cursor CLI 的 stream-json 事件流转成人能看的中文进度行（给 agent-loop.mjs 用）。
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { mergeStream } from './cli-zh.mjs'

const CODE_LINES = 24
const SPEECH_LINES = 80
const clip = (text, size) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > size ? `${flat.slice(0, size)}…` : flat
}
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const activityFile = () => join(tmpdir(), 'erp-cli-activity.jsonl')
const sessionFile = () => join(tmpdir(), 'erp-cli-session.json')

const TOOL_ZH = {
  read: '读文件',
  grep: '搜索',
  shell: '跑命令',
  edit: '改文件',
  write: '写文件',
  delete: '删文件',
  await: '等待',
  task: '子任务',
}

function toolNameOf(event) {
  return Object.keys(event.tool_call ?? {}).find(key => key.endsWith('ToolCall')) ?? '工具'
}

function argsOf(event) {
  const name = toolNameOf(event)
  return event.tool_call?.[name]?.args ?? {}
}

function partsOf(event) {
  const raw = event.message?.content ?? event.content ?? []
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  return Array.isArray(raw) ? raw : []
}

function speechOf(event) {
  return partsOf(event)
    .filter(part => !part.type || part.type === 'text')
    .map(part => part.text ?? part.content ?? '')
    .join('')
}

function thinkingOf(event) {
  const fromParts = partsOf(event)
    .filter(part => part.type === 'thinking' || part.type === 'reasoning')
    .map(part => part.text ?? part.thinking ?? '')
    .join('')
  return fromParts || event.message?.thinking || event.thinking || event.text || ''
}

function previewLines(text, mark) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const cut = lines.length > CODE_LINES ? [...lines.slice(0, CODE_LINES), `… 另有 ${lines.length - CODE_LINES} 行`] : lines
  return cut.map(line => `  ${mark} ${line}`)
}

function wrapLabel(label, text, maxLines = SPEECH_LINES) {
  const lines = String(text).replace(/\r\n/g, '\n').trim().split('\n')
  const cut = lines.length > maxLines ? [...lines.slice(0, maxLines), `… 另有 ${lines.length - maxLines} 行`] : lines
  return [`${label}`, ...cut.map(line => `  ${line}`)]
}

/** 从写文件/替换参数里抽出要给人看的代码片段。 */
export function codePreview(args = {}) {
  const path = args.path ?? args.file_path ?? args.filePath ?? ''
  const next = args.contents ?? args.new_string ?? args.newString ?? args.streamContent
  const prev = args.old_string ?? args.oldString
  if (typeof next === 'string' && typeof prev === 'string') {
    return [`  写代码 ${path}`, ...previewLines(prev, '-'), ...previewLines(next, '+')]
  }
  if (typeof next === 'string' && next.trim()) return [`  写代码 ${path}`, ...previewLines(next, '+')]
  if (Array.isArray(args.edits)) {
    const lines = [`  写代码 ${path}`]
    for (const edit of args.edits.slice(0, 4)) {
      if (edit.old_string) lines.push(...previewLines(edit.old_string, '-'))
      if (edit.new_string) lines.push(...previewLines(edit.new_string, '+'))
    }
    return lines.length > 1 ? lines : null
  }
  return null
}

function writeSession(patch) {
  let prev
  try {
    prev = JSON.parse(readFileSync(sessionFile(), 'utf8'))
  } catch {
    prev = {}
  }
  if (patch.thinking) patch.thinking = mergeStream(prev.thinking, patch.thinking)
  if (patch.speech) patch.speech = mergeStream(prev.speech, patch.speech)
  try {
    writeFileSync(sessionFile(), `${JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() })}\n`)
  } catch {
    /* 会话快照写失败不影响循环 */
  }
}

function recordActivity(row) {
  try {
    appendFileSync(activityFile(), `${JSON.stringify({ time: new Date().toISOString(), ...row })}\n`)
  } catch {
    /* 写活动日志失败不影响循环 */
  }
}

/** 把一个事件格式化成一行或多行（不需要显示的事件返回 null）。 */
export function formatEvent(event) {
  if (event.type === 'system' && event.subtype === 'init') {
    writeSession({ model: event.model, sessionId: event.session_id, speech: '', thinking: '', action: '会话开始' })
    return `会话开始 模型=${event.model} 会话ID=${event.session_id}`
  }
  if (event.type === 'thinking' || event.subtype === 'thinking') {
    const thinking = thinkingOf(event).trim()
    if (!thinking) return null
    writeSession({ thinking })
    return null
  }
  if (event.type === 'assistant') {
    const speech = speechOf(event).trim()
    const thinking = thinkingOf(event).trim()
    if (thinking) writeSession({ thinking })
    if (speech) writeSession({ speech })
    if (event.timestamp_ms || !speech) return null
    recordActivity({ kind: 'speech', text: speech.slice(0, 4000) })
    return wrapLabel('会话', speech)
  }
  if (event.type === 'tool_call' && event.subtype === 'started') {
    const raw = toolNameOf(event).replace(/ToolCall$/, '')
    const name = TOOL_ZH[raw.toLowerCase()] ?? raw
    const args = argsOf(event)
    const detail = args.command ?? args.path ?? args.pattern ?? args.query ?? args.description ?? JSON.stringify(args)
    const action = `${name}：${clip(detail, 160)}`
    writeSession({ action, file: args.path ?? args.file_path ?? args.filePath ?? '' })
    recordActivity({ kind: raw, path: args.path ?? '', command: typeof args.command === 'string' ? clip(args.command, 240) : '', short: action })
    const code = /edit|write|apply|strreplace/i.test(raw) ? codePreview(args) : null
    return code ? [`动作 ${action}`, ...code] : `动作 ${action}`
  }
  if (event.type === 'result') {
    const seconds = Math.round((event.duration_ms ?? 0) / 1000)
    const u = event.usage ?? {}
    const tokens = `输入 ${u.inputTokens ?? '?'} 缓存读 ${u.cacheReadTokens ?? '?'} 缓存写 ${u.cacheWriteTokens ?? '?'} 输出 ${u.outputTokens ?? '?'}`
    writeSession({ action: event.is_error ? '会话失败' : '会话结束' })
    return `会话结束 ${event.is_error ? '失败' : '成功'} 用时 ${seconds} 秒 token：${tokens}`
  }
  return null
}

function printFormatted(out) {
  const time = stamp()
  for (const line of Array.isArray(out) ? out : [out]) console.log(`[${time}] ${line}`)
}

/** 运行 agent 并实时打印进度，返回退出码。 */
export function runAgentStreaming(bin, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(bin, [...args, '--output-format', 'stream-json'], { cwd, shell: true, stdio: ['ignore', 'pipe', 'inherit'] })
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line)
        if (event.type === 'result') {
          const record = { time: new Date().toISOString(), durationMs: event.duration_ms, usage: event.usage, isError: event.is_error }
          appendFileSync(join(tmpdir(), 'agent-usage.jsonl'), `${JSON.stringify(record)}\n`)
        }
        const out = formatEvent(event)
        if (out) printFormatted(out)
      } catch {
        if (line.trim()) console.log(line)
      }
    })
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code))
    child.on('exit', code =>
      setTimeout(() => {
        child.stdout.destroy()
        resolve(code)
      }, 3000),
    )
  })
}
