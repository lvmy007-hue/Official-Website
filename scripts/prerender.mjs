import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const server = await import(pathToFileURL(join(root, 'dist-ssr', 'entry-server.mjs')).href)
const shell = await readFile(join(dist, 'index.html'), 'utf8')
const manifest = JSON.parse(await readFile(join(dist, '.vite', 'manifest.json'), 'utf8'))

function collect(key, seen = new Set()) {
  const chunk = manifest[key]
  if (!chunk || seen.has(key)) return { css: [], js: [] }
  seen.add(key)
  const css = [...(chunk.css ?? [])]
  const js = [chunk.file]
  for (const child of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? []).filter(item => !item.includes('app-entry'))]) {
    const nested = collect(child, seen)
    css.push(...nested.css)
    js.push(...nested.js)
  }
  return { css, js }
}

const publicAssets = collect('src/public-entry.tsx')
const headAssets =
  [...new Set(publicAssets.css)].map(file => `<link rel="stylesheet" href="/${file}"/>`).join('') + [...new Set(publicAssets.js)].map(file => `<link rel="modulepreload" href="/${file}"/>`).join('')
const template = shell.replace('</head>', `${headAssets}</head>`)

const escape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function documentFor(path) {
  const page = server.render(path)
  const alternates = [
    page.alternates.zh ? `<link rel="alternate" hreflang="zh-CN" href="${page.alternates.zh}"/>` : '',
    page.alternates.en ? `<link rel="alternate" hreflang="en" href="${page.alternates.en}"/>` : '',
  ].join('')
  return template
    .replace(/<html lang="[^"]*">/, () => `<html lang="${page.lang}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escape(page.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\/>/, () => `<meta name="description" content="${escape(page.description)}"/>`)
    .replace(/<link rel="canonical" href="[^"]*"\/>/, () => `<link rel="canonical" href="${page.canonical}"/>`)
    .replace(/(<link rel="alternate" hreflang="[^"]*" href="[^"]*"\/>)+/, () => alternates)
    .replace('<!--app-html-->', () => page.html)
}

await writeFile(join(dist, 'app.html'), shell.replace('<!--app-html-->', ''))

const paths = server.prerenderPaths()
for (const path of paths) {
  const file = path === '/' ? join(dist, 'index.html') : join(dist, path.slice(1), 'index.html')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, documentFor(path))
}
await writeFile(join(dist, '404.html'), documentFor('/__not-found__'))
await rm(join(root, 'dist-ssr'), { recursive: true, force: true })
console.log(`prerendered ${paths.length} pages, plus app.html and 404.html`)
