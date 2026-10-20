const fs = require('fs')
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')
const body = html.slice(html.indexOf('data-module-name="Adc2025HomepageBanner"'))
const cleaned = body
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
const parts = cleaned.split(/<[^>]+>/)
const seen = new Set()
const lines = []
for (const raw of parts) {
  const s = raw.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  if (!s || s.length < 4 || s.length > 160) continue
  if (!/[\u4e00-\u9fff]/.test(s)) continue
  if (seen.has(s)) continue
  seen.add(s)
  lines.push(s)
}
fs.writeFileSync('docs/evidence/dachang/copy.txt', lines.join('\n'))
console.log(lines.length)

const theme = fs.readFileSync('docs/evidence/dachang/css/theme.css', 'utf8')
const keys = ['text-44', 'text-36', 'text-32', 'text-26', 'text-22', 'text-18', 'text-16', 'text-14', 'leading-64', 'leading-40', 'leading-28', 'leading-24', 'text-default', 'text-subtle', 'text-primary', 'font-semibold', 'rounded-card', 'shadow-large', 'mt-14', 'spacing-page', '--text-heading1', '--aliyun-font-size-44', 'page-margin']
for (const key of keys) {
  const i = theme.indexOf('.' + key + '{')
  const j = theme.indexOf('--' + key.replace(/^--/, ''))
  const hit = i >= 0 ? theme.slice(i, i + 180) : (theme.includes(key) ? theme.slice(Math.max(0, theme.indexOf(key) - 20), theme.indexOf(key) + 120) : '')
  if (hit) console.log('\nKEY', key, hit.replace(/\s+/g, ' ').slice(0, 220))
}
