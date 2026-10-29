#!/usr/bin/env node
// ???????P1-29?11.4??????? ? ??????????????????? ???? ? ?? ? ???? ? ???????
// ??????????????  node scripts/ci.mjs
//
// ???
//   --only=typecheck,test   ???????
//   --skip=audit            ?????????????? 3???�?????�?
//   --keep-going            ???????????????
//
// ???????? https://registry.npmjs.org??????????????
// ????? CI_AUDIT_REGISTRY ???????? 12.6 ? 8 ???
//
// ??? Redis ??????????? TEST_REDIS_URL????????????????????
// ??TEST_REDIS_URL=redis://127.0.0.1:26379 node scripts/ci.mjs

import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
spawnSync(process.execPath, [resolve(root, 'scripts/clean-test-temp.mjs')], { cwd: root, stdio: 'inherit' })
const pnpm = process.env.CI_PNPM ?? 'corepack pnpm'
const auditRegistry = process.env.CI_AUDIT_REGISTRY ?? 'https://registry.npmjs.org'
const vitestWorkers = process.env.CI_VITEST_MAX_WORKERS || (platform() === 'win32' ? '6' : '')
const vitestCmd = `${pnpm} exec vitest run${vitestWorkers ? ` --maxWorkers=${vitestWorkers} --minWorkers=1` : ''}`

const steps = [
  {
    name: 'prepare',
    title: '??????????????',
    commands: [
      `${pnpm} --filter @nova/api-contracts build`,
      `${pnpm} --filter @nova/authz build`,
      `${pnpm} --filter @nova/metrics build`,
      `${pnpm} --filter @nova/tenancy build`,
      `${pnpm} --filter @nova/workflow build`,
      `${pnpm} --filter @nova/storage build`,
      `${pnpm} --filter @nova/crypto build`,
      `${pnpm} --filter @nova/api prisma:generate`,
    ],
  },
  {
    name: 'typecheck',
    title: '?????????????????',
    commands: [
      'node scripts/gen-permission-catalog.mjs --check',
      'node scripts/gen-route-manifest.mjs --check',
      'node scripts/gen-metric-definitions.mjs --check',
      'node scripts/check-tenant-isolation.mjs --self-test',
      'node scripts/check-tenant-isolation.mjs',
      'node scripts/check-security.mjs --self-test',
      'node scripts/check-security.mjs',
      'node scripts/check-code-quality.mjs --self-test',
      'node scripts/check-code-quality.mjs',
      `${pnpm} lint`,
      `${pnpm} format:check`,
      `${pnpm} typecheck`,
      `${pnpm} --filter @nova/api typecheck`,
      `${pnpm} --filter @nova/worker typecheck`,
    ],
  },
  { name: 'test', title: '????????????????????????', commands: [vitestCmd] },
  { name: 'build', title: '????????????', commands: [`${pnpm} build`, `${pnpm} --filter @nova/api build`, `${pnpm} --filter @nova/worker build`] },
  { name: 'website', title: '?????????????', commands: ['node scripts/website-fingerprint.mjs --check'] },
  { name: 'audit', title: '??????', commands: [`${pnpm} audit --prod --audit-level high --registry=${auditRegistry}`] },
]

const args = process.argv.slice(2)
const option = name =>
  args
    .find(arg => arg.startsWith(`--${name}=`))
    ?.split('=')[1]
    ?.split(',')
    .filter(Boolean) ?? []
const only = option('only')
const skip = new Set(option('skip'))
const keepGoing = args.includes('--keep-going')

const unknown = [...only, ...skip].filter(name => !steps.some(step => step.name === name))
if (unknown.length > 0) {
  console.error(`?????${unknown.join('?')}??????${steps.map(step => step.name).join('?')}`)
  process.exit(2)
}

const results = []
for (const step of steps) {
  if (only.length > 0 && !only.includes(step.name)) continue
  if (skip.has(step.name)) {
    results.push({ step, status: 'skipped', seconds: 0 })
    continue
  }
  console.log(`\n=== ${step.name}?${step.title} ===`)
  const startedAt = Date.now()
  let failed = false
  for (const command of step.commands) {
    console.log(`$ ${command}`)
    const run = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    if (run.status !== 0) {
      failed = true
      break
    }
  }
  results.push({ step, status: failed ? 'failed' : 'passed', seconds: Math.round((Date.now() - startedAt) / 1000) })
  if (failed && !keepGoing) break
}

console.log('\n=== ?? ===')
const label = { passed: '??', failed: '??', skipped: '???' }
for (const { step, status, seconds } of results) console.log(`${label[status].padEnd(6)} ${step.name.padEnd(10)} ${seconds}s`)
const notRun = steps.filter(step => (only.length === 0 || only.includes(step.name)) && !results.some(result => result.step === step)).map(step => step.name)
if (notRun.length > 0) console.log(`????????????${notRun.join('?')}`)
if (results.some(result => result.status === 'skipped')) console.log('??????????????????????')
if (!process.env.TEST_REDIS_URL && results.some(result => result.step.name === 'test' && result.status === 'passed')) {
  console.log('\n?????? TEST_REDIS_URL???? Redis ????????????????????')
  console.log('      ??????? Redis ???TEST_REDIS_URL=redis://127.0.0.1:26379 node scripts/ci.mjs')
}

const ok = results.every(result => result.status !== 'failed') && notRun.length === 0 && !results.some(result => result.status === 'skipped')
process.exit(results.some(result => result.status === 'failed') || notRun.length > 0 ? 1 : ok ? 0 : 3)
