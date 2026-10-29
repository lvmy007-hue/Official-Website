#!/usr/bin/env node
// 清掉卡住的测试进程：vitest / ci.mjs 孤儿、postgres.exe -V 空探测。
// 不动 agent-loop、cli-sync、docker compose 里真正在跑的 postgres。
// 只在外层循环开全量 CI 之前调用，避免和当前 CI 抢锁。
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'win32') process.exit(0)

const keep = [process.pid, process.ppid].filter(Boolean)
const extra = process.env.ERP_KEEP_PIDS
if (extra) for (const id of extra.split(',')) if (/^\d+$/.test(id)) keep.push(Number(id))

const ps1 = join(tmpdir(), `erp-kill-stale-${process.pid}.ps1`)
const script = `
$keep = @(${keep.join(',')})
Get-CimInstance Win32_Process | ForEach-Object {
  if ($keep -contains $_.ProcessId) { return }
  $cl = [string]$_.CommandLine
  $name = $_.Name
  $hit = $false
  if ($name -eq 'postgres.exe' -and $cl -match '(^|\\s)-V(\\s|$)') { $hit = $true }
  elseif ($name -eq 'postgres.exe' -and $cl -match 'nova-pg-bin') { $hit = $true }
  elseif ($name -eq 'cmd.exe' -and $cl -match 'postgres\\.exe' -and $cl -match '(^|\\s)-V(\\s|$)') { $hit = $true }
  elseif ($name -match '^node(\\.exe)?$' -and $cl -match 'scripts[\\\\/]ci\\.mjs') { $hit = $true }
  elseif ($name -match '^node(\\.exe)?$' -and $cl -match 'vitest' -and $cl -match '(^|[\\\\"\\s])run([\\\\"\\s]|$)') { $hit = $true }
  if ($hit) { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
}
`
writeFileSync(ps1, script, 'utf8')
spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  stdio: 'ignore',
  windowsHide: true,
  timeout: 30_000,
})
try {
  unlinkSync(ps1)
} catch {
  /* 临时脚本删不掉也不挡 CI */
}
