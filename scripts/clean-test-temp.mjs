#!/usr/bin/env node
// 清掉真实库测试留在 %TEMP% 里的嵌入式 Postgres 数据目录。中断或被杀的运行不会走 stop()，目录会一直堆到 C 盘写满。
// 必须排除 nova-pg-bin（二进制缓存）。默认不碰最近 KEEP_MINUTES 分钟内改过的目录，避免删掉正在跑的 CI。
//
//   node scripts/clean-test-temp.mjs
//   node scripts/clean-test-temp.mjs --keep-minutes 15
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const keepArg = args[args.indexOf('--keep-minutes') + 1]
const keepMinutes = Number(keepArg) > 0 && args.includes('--keep-minutes') ? Number(keepArg) : 15
const keepMs = keepMinutes * 60_000
const root = process.env.TEMP || tmpdir()
const cutoff = Date.now() - keepMs
const keepName = name => name === 'nova-pg-bin' || name.startsWith('nova-pg-bin')
const leftover = name =>
  !keepName(name) && /^(?:nova-pg-|nova-label-export-|nova-raw-|nova-export-|nova-close-|nova-receiving-|nova-first-mile-|nova-procurement-|nova-storage-|nova-sample-|nova-tenant-store-)/.test(name)

function removeDir(full) {
  if (process.platform === 'win32') {
    const run = spawnSync('cmd', ['/c', 'rd', '/s', '/q', full], { stdio: 'ignore', windowsHide: true, timeout: 8_000 })
    return run.status === 0
  }
  try {
    rmSync(full, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

let removed = 0
let skippedFresh = 0
let failed = 0
for (const name of readdirSync(root, { withFileTypes: true })) {
  if (!name.isDirectory() || !leftover(name.name)) continue
  const full = join(root, name.name)
  let mtime
  try {
    mtime = statSync(full).mtimeMs
  } catch {
    continue
  }
  if (mtime > cutoff) {
    skippedFresh += 1
    continue
  }
  if (removeDir(full)) removed += 1
  else failed += 1
}

console.log(`临时库清理：删掉 ${removed} 个目录，跳过最近 ${keepMinutes} 分钟内的 ${skippedFresh} 个，失败 ${failed} 个。`)
