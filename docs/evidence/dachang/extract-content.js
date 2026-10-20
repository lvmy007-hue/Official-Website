const fs = require('fs')
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')

const modules = [...html.matchAll(/data-module-name="([^"]+)"/g)].map((m) => ({
  name: m[1],
  index: m.index,
}))

const roots = []
for (let i = 0; i < modules.length; i++) {
  const cur = modules[i]
  const prev = roots[roots.length - 1]
  if (prev && prev.name === cur.name && cur.index - prev.index < 400) continue
  roots.push(cur)
}

function sliceOf(i) {
  const start = roots[i].index
  const end = i + 1 < roots.length ? roots[i + 1].index : Math.min(start + 180000, html.length)
  return html.slice(start, end)
}

function textOf(chunk) {
  return chunk
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== 'undefined' && s.length < 180)
}

const out = []
for (let i = 0; i < roots.length; i++) {
  const chunk = sliceOf(i)
  const texts = []
  const seen = new Set()
  for (const line of textOf(chunk)) {
    if (seen.has(line)) continue
    seen.add(line)
    texts.push(line)
    if (texts.length >= 80) break
  }
  const links = [...chunk.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 24)
    .map((m) => {
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
      return label ? `${label} -> ${m[1].slice(0, 90)}` : m[1].slice(0, 90)
    })
  const imgs = [...chunk.matchAll(/<img [^>]*>/g)].slice(0, 12).map((m) => {
    const alt = (m[0].match(/alt="([^"]*)"/) || [])[1] || ''
    const src = (m[0].match(/src="([^"]+)"/) || [])[1] || ''
    return `${alt} | ${src.slice(0, 110)}`
  })
  const vars = [...chunk.matchAll(/style="([^"]{0,400})"/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('--'))
    .slice(0, 12)
  out.push({
    name: roots[i].name,
    chars: chunk.length,
    texts,
    links: [...new Set(links)].slice(0, 16),
    imgs,
    vars,
  })
}

fs.writeFileSync('docs/evidence/dachang/content-outline.json', JSON.stringify(out, null, 2))
console.log(out.map((x) => `${x.name} texts=${x.texts.length} links=${x.links.length} imgs=${x.imgs.length} chars=${x.chars}`).join('\n'))
