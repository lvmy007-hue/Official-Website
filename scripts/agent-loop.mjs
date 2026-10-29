#!/usr/bin/env node
// 自动换会话的外层循环：每一轮新开一个全新的 Cursor Agent 会话，只做 PROGRESS.md 里 NEXT 指定的一个工作包。
// 交接靠 docs/erp-plan/PROGRESS.md，不靠会话上下文。
//
// 施工会话只做便宜检查，禁止跑全量 CI。全量 CI 由本脚本独立跑。
// 超时等偶发只重跑 CI，不开修复会话。
// 断言、类型、lint 等真失败才开修复会话。
// 全自动：方案分叉自选最新最优；真失败当场修。
// 停止条件：STATUS 为 DONE；登录彻底失败；达到轮数上限。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentStreaming } from './agent-stream.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const progressFile = resolve(root, 'docs/erp-plan/PROGRESS.md')
const ciLogFile = join(tmpdir(), 'erp-loop-ci.txt')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const max = Number(args[args.indexOf('--max') + 1]) > 0 && args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 3
const bin = process.env.AGENT_BIN || 'agent'
const workPrompt = [
  '严格按 docs/erp-plan/PROGRESS.md 的会话约定做，只做 NEXT 那一个工作包。',
  '开工只读：PROGRESS 开头到硬规则之前、change-log 最新一条 CR、14-execution-plan.md 里该包描述及其点名的冻结小节。',
  '不要通读环境与踩过的坑，不要通读整份 change-log。命令失败再按报错去坑笔记里搜对应条。',
  '禁止运行 node scripts/ci.mjs。只对改动跑 prettier、eslint、对应包 typecheck、相关 vitest。全量 CI 由外层循环跑。',
  'LAST_CI 写 pending，不要写 green。',
  '全自动：方案分叉按 15-16 章和冻结文档选最新最优，写进 CR，不要 BLOCKED。新界面必须用 PagedGrid/MassiveGrid。',
  '若该包已有中断留下的文件，检查后补完，不要重做。',
  '只有缺外部凭据或生产环境才允许 BLOCKED。直接改文件，不要在回复里复述整套方案。',
].join(' ')
const repairPrompt = () =>
  [
    '这是修复会话：独立核验发现了真实失败（不是超时偶发）。不要等人。',
    `先读 ${ciLogFile} 的尾部和 FAIL、error TS、AssertionError、ESLint 行，只修这些。包括包外挡路文件。`,
    '不要通读 PROGRESS 坑笔记和整份 change-log。禁止运行 node scripts/ci.mjs。修完用便宜命令确认对应文件。',
    'LAST_CI 写 pending。不要把 STATUS 写成 BLOCKED。直接改文件。',
  ].join(' ')

/** 读取 PROGRESS.md 开头的机器可读状态。 */
export function readState(text) {
  const field = key => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim() ?? ''
  return { status: field('STATUS'), next: field('NEXT'), lastDone: field('LAST_DONE'), lastCi: field('LAST_CI') }
}

const state = () => readState(readFileSync(progressFile, 'utf8'))
const run = (command, commandArgs, extraEnv = {}) => spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ...extraEnv } })
const modelArg = () => {
  const model = process.env.AGENT_MODEL || (args.includes('--model') ? args[args.indexOf('--model') + 1] : '')
  return { model, flag: model ? ['--model', model.includes('[') ? `"${model}"` : model] : [] }
}

const CI_TIMEOUT_MS = Number(process.env.ERP_CI_TIMEOUT_MS) > 0 ? Number(process.env.ERP_CI_TIMEOUT_MS) : 32 * 60_000

export function classifyCi(text) {
  const log = String(text || '')
  if (/AssertionError|error TS[0-9]+|ESLint found|max-warnings|fingerprint|check-code-quality|check-tenant-isolation|check-security|format:check/.test(log)) {
    return 'real'
  }
  if (
    /timed? out|Timeout of \d+|Hook timed out|Zone Allocation failed|ECONNRESET|No space left on device|Worker exited unexpectedly|the test was canceled|EPERM|EBUSY|resource busy or locked|CI_HUNG_TIMEOUT|uv_fs_|killed \(timeout\)/i.test(
      log,
    )
  ) {
    return 'flake'
  }
  return 'real'
}

function writeLastCi(value) {
  const text = readFileSync(progressFile, 'utf8')
  writeFileSync(progressFile, text.replace(/^LAST_CI:\s*.+$/m, `LAST_CI: ${value}`))
}

async function runSession(promptText) {
  const { flag: modelFlags } = modelArg()
  const command = ['-p', '--force', '--trust', ...modelFlags, JSON.stringify(promptText)]
  const before = state()
  let code = null
  let after = before
  for (let attempt = 1; attempt <= 4; attempt++) {
    code = await runAgentStreaming(bin, command, root)
    after = state()
    const moved = after.next !== before.next || after.lastDone !== before.lastDone || after.status !== before.status
    if (code === 0 || moved || attempt === 4) break
    console.log(`Agent 命令失败（退出码 ${code ?? '无'}），60 秒后第 ${attempt + 1} 次重试`)
    await new Promise(done => setTimeout(done, 60_000))
  }
  return { code, after, before }
}

export function snapshot(label) {
  const gitDir = resolve(root, '..', '..', '_erp-snapshots', 'git')
  const git = (...gitArgs) => spawnSync('git', ['--git-dir', gitDir, '--work-tree', root, ...gitArgs], { encoding: 'utf8' })
  if (!existsSync(gitDir)) {
    mkdirSync(gitDir, { recursive: true })
    git('init', '-q')
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.longpaths', 'true'],
    ])
      git('config', key, value)
    mkdirSync(resolve(gitDir, 'info'), { recursive: true })
    writeFileSync(resolve(gitDir, 'info', 'exclude'), ['shots/', 'video-review/', '*.tmp.txt', '*.tsbuildinfo', '.turbo/'].join('\n') + '\n')
  }
  git('add', '-A')
  const identity = ['-c', 'user.name=erp-loop', '-c', 'user.email=erp-loop@local']
  const commit = git(...identity, 'commit', '-q', '--allow-empty', '-m', `after ${label || 'unknown'}`)
  console.log(commit.status === 0 ? `回退点已提交到影子仓库：${label}` : `回退点提交失败：${(commit.stderr || '').trim().slice(0, 120)}（不影响继续）`)
}

function sweepTemp() {
  const sweep = run('node', ['scripts/clean-test-temp.mjs'])
  if (sweep.status !== 0) console.log('临时库清理失败（不影响继续跑 CI）')
}

function killStaleTestProcs() {
  const stale = run('node', ['scripts/kill-stale-test-procs.mjs'])
  if (stale.status !== 0) console.log('残留测试进程清理失败（不影响继续跑 CI）')
}

function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已经退出 */
  }
}

function attachLoopLog() {
  const path = process.env.AGENT_LOOP_LOG || join(tmpdir(), 'agent-loop.log')
  try {
    if (existsSync(path)) {
      const fd = openSync(path, 'r')
      const head = Buffer.alloc(2)
      readSync(fd, head, 0, 2, 0)
      closeSync(fd)
      if (head[0] === 0xff && head[1] === 0xfe) renameSync(path, `${path}.${Date.now()}.utf16.bak`)
    }
  } catch {
    /* 旧日志转存失败则继续往原文件追加 */
  }
  const file = createWriteStream(path, { flags: 'a' })
  const hook = (stream, orig) => {
    stream.write = (chunk, enc, cb) => {
      try {
        file.write(chunk)
      } catch {
        /* 日志写失败不挡循环 */
      }
      if (stream.writableNeedDrain) {
        const done = typeof enc === 'function' ? enc : cb
        if (typeof done === 'function') done()
        return true
      }
      return orig(chunk, enc, cb)
    }
  }
  hook(process.stdout, process.stdout.write.bind(process.stdout))
  hook(process.stderr, process.stderr.write.bind(process.stderr))
}

function runCiOnce() {
  killStaleTestProcs()
  sweepTemp()
  return new Promise(done => {
    const chunks = []
    const child = spawn('node', ['scripts/ci.mjs'], {
      cwd: root,
      env: { ...process.env, TEST_REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:26379' },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let hung = false
    const onData = buf => {
      chunks.push(buf)
      process.stdout.write(buf)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      hung = true
      console.log(`\n--- CI 超过 ${Math.round(CI_TIMEOUT_MS / 60_000)} 分钟未结束，杀掉进程树 ---`)
      killProcessTree(child.pid)
    }, CI_TIMEOUT_MS)
    const finish = code => {
      clearTimeout(timer)
      const text = `${Buffer.concat(chunks).toString('utf8')}${hung ? '\nCI_HUNG_TIMEOUT\n' : ''}`
      writeFileSync(ciLogFile, text)
      done({ status: hung ? 1 : (code ?? 1), text, logFile: ciLogFile })
    }
    child.on('error', () => finish(1))
    child.on('close', code => finish(code))
  })
}

async function runCiWithFlakeRetry() {
  let ci = await runCiOnce()
  if (ci.status === 0) return ci
  for (let round = 1; round <= 2 && classifyCi(ci.text) === 'flake'; round += 1) {
    console.log(`\n--- 判定为偶发（${round} / 2），重跑全量 CI，不开修复会话 ---`)
    ci = await runCiOnce()
    if (ci.status === 0) return ci
  }
  return ci
}

async function main() {
  attachLoopLog()
  for (let round = 1; round <= max; round++) {
    let before = state()
    console.log(`\n=== 第 ${round} / ${max} 轮：状态 ${before.status}，下一包 ${before.next}，上一个完成 ${before.lastDone} ===`)
    if (flag('--dry')) {
      const { model } = modelArg()
      return console.log(`[dry] ${bin} --model ${model || 'auto'} <prompt>`)
    }
    if (before.lastCi === 'red' || before.lastCi === 'pending') {
      console.log(before.lastCi === 'pending' ? '上次 CI 未完成，先独立核验；偶发不开修复会话' : '上次 CI 红灯，先独立重跑；偶发不开修复会话')
      const ci = await runCiWithFlakeRetry()
      if (ci.status === 0) {
        writeLastCi('green')
        snapshot(state().lastDone)
      } else if (classifyCi(ci.text) === 'real') {
        console.log('确认为真实失败，开修复会话')
        await runSession(repairPrompt())
      } else {
        writeLastCi('red')
        console.log('仍是偶发失败，本轮不修会话、不开新包，下一轮再跑 CI。')
        continue
      }
      before = state()
    }
    if (before.status === 'DONE') {
      if (before.lastCi === 'green') return console.log('全部完成。')
      continue
    }
    if (before.status === 'BLOCKED') {
      console.log('STATUS 为 BLOCKED，开修复会话（凭据/生产环境除外应解阻）')
      await runSession(repairPrompt())
      before = state()
      if (before.status === 'DONE') return console.log('全部完成。')
    }

    const session = await runSession(workPrompt)
    const after = session.after
    const advanced = after.next !== before.next || after.lastDone !== before.lastDone
    if (session.code !== 0 && !advanced && after.status === before.status) {
      console.log(`Agent 命令失败（退出码 ${session.code ?? '无'}），下一轮再试，不退出。`)
      continue
    }
    if (session.code !== 0) console.log(`注意：Agent 退出码 ${session.code ?? '无'}，但进度有变化，继续核验。`)
    if (after.status === 'BLOCKED') {
      console.log('会话写成了 BLOCKED，全自动再开修复会话，不等人')
      await runSession(repairPrompt())
    }
    if (!advanced && state().status !== 'BLOCKED') {
      console.log('本轮未推进 NEXT / LAST_DONE，跳过全量 CI，下一轮再开新会话。')
      continue
    }

    if (!flag('--no-verify')) {
      console.log('\n--- 独立核验：全量 CI ---')
      let ci = await runCiWithFlakeRetry()
      for (let fix = 1; fix <= 5 && ci.status !== 0 && classifyCi(ci.text) === 'real'; fix += 1) {
        console.log(`\n--- 真实失败，第 ${fix} / 5 次修复会话 ---`)
        writeLastCi('red')
        await runSession(repairPrompt())
        ci = await runCiWithFlakeRetry()
      }
      if (ci.status !== 0) {
        writeLastCi('red')
        console.log(classifyCi(ci.text) === 'flake' ? '独立核验仍是偶发，本轮不进下一包，下一轮先重跑 CI。' : '独立核验仍未绿，本轮不进入下一包快照，下一轮继续修。')
        continue
      }
      writeLastCi('green')
    }
    const done = state()
    snapshot(done.lastDone)
    console.log(`本轮完成：${done.lastDone}，下一包：${done.next}`)
  }
  console.log(`已达到轮数上限（${max}）。`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
