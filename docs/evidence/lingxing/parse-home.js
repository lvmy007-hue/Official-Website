const fs = require('fs')
const html = fs.readFileSync('docs/evidence/lingxing/home.html', 'utf8')
const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
const internal = [...new Set(hrefs.filter((h) => h.startsWith('/') || h.includes('lingxing.com')))]
fs.writeFileSync('docs/evidence/lingxing/links.txt', internal.join('\n'))
console.log('links', internal.length)
const text = html
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .split('\n')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s && s.length > 1 && s.length < 160 && /[\u4e00-\u9fffA-Za-z0-9]/.test(s))
const seen = new Set()
const lines = []
for (const line of text) {
  if (seen.has(line)) continue
  seen.add(line)
  lines.push(line)
}
fs.writeFileSync('docs/evidence/lingxing/copy.txt', lines.join('\n'))
console.log('lines', lines.length)
console.log('title', (html.match(/<title>([^<]+)/) || [])[1])
const classes = [...html.matchAll(/class="([^"]{0,80})"/g)].slice(0, 5)
console.log('sample class', classes.map((m) => m[1]).join(' | '))
