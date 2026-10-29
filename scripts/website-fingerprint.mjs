// 官网指纹工具：生成或核对官网预渲染页面与官网源码的哈希。
// 用法：
//   node scripts/website-fingerprint.mjs --write   生成基线文件 docs/erp-plan/freeze/fingerprints.json
//   node scripts/website-fingerprint.mjs --check   与基线核对，有差异则以非零状态退出
// 预渲染页面指纹：去除 <script> 与 stylesheet/modulepreload 的 <link> 后再哈希，
// 这样构建产物文件名哈希变化不会造成误报，只反映页面实际内容。
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const src = join(root, 'src')
const baselineFile = join(root, 'docs', 'erp-plan', 'freeze', 'fingerprints.json')

// 属于 ERP 工作区的源码，不计入官网源码指纹
const erpOnly = [`erp${sep}`, 'App.tsx', 'app-entry.tsx', 'data.ts', 'data.test.ts', 'api.ts', 'api.test.ts', 'workspace-headers.test.ts']
// 官网与 ERP 共用的文件，单独标记，变更时必须同时核对官网
const shared = [`ui${sep}chart.tsx`, `ui${sep}motion.tsx`]

const sha = text => createHash('sha256').update(text).digest('hex')

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === '.vite') continue
      out.push(...(await walk(full)))
    } else out.push(full)
  }
  return out
}

function normalizeHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:stylesheet|modulepreload)"[^>]*>/g, '')
    .replace(/<link\b[^>]*rel="(?:modulepreload|stylesheet)"[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
}

async function collect() {
  const pages = {}
  for (const file of (await walk(dist)).filter(item => item.endsWith('.html')).sort()) {
    pages[relative(dist, file).split(sep).join('/')] = sha(normalizeHtml(await readFile(file, 'utf8')))
  }
  const sources = {}
  const sharedSources = {}
  for (const file of (await walk(src)).sort()) {
    const rel = relative(src, file)
    const key = rel.split(sep).join('/')
    const hash = sha((await readFile(file, 'utf8')).replace(/\r\n/g, '\n'))
    if (shared.includes(rel)) sharedSources[key] = hash
    else if (!erpOnly.some(item => (item.endsWith(sep) ? rel.startsWith(item) : rel === item))) sources[key] = hash
  }
  return { pageCount: Object.keys(pages).length, pages, sources, sharedSources }
}

const mode = process.argv.includes('--check') ? 'check' : 'write'
const current = await collect()

if (mode === 'write') {
  await mkdir(dirname(baselineFile), { recursive: true })
  await writeFile(baselineFile, JSON.stringify({ generatedAt: new Date().toISOString(), ...current }, null, 2) + '\n')
  console.log(`已写入基线：页面 ${current.pageCount} 个，官网源码 ${Object.keys(current.sources).length} 个，共用源码 ${Object.keys(current.sharedSources).length} 个`)
} else {
  const base = JSON.parse(await readFile(baselineFile, 'utf8'))
  const diffs = []
  for (const group of ['pages', 'sources', 'sharedSources']) {
    const names = new Set([...Object.keys(base[group] ?? {}), ...Object.keys(current[group])])
    for (const name of names) {
      if (base[group]?.[name] !== current[group][name]) diffs.push(`${group}: ${name}`)
    }
  }
  if (diffs.length) {
    console.error(`官网指纹与基线不一致，共 ${diffs.length} 项：\n` + diffs.join('\n'))
    process.exit(1)
  }
  console.log(`官网指纹核对通过：页面 ${current.pageCount} 个，官网源码 ${Object.keys(current.sources).length} 个，共用源码 ${Object.keys(current.sharedSources).length} 个`)
}
