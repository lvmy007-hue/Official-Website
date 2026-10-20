const fs = require('fs')
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')

const modules = []
const re = /data-module-name="([^"]+)"/g
let match
while ((match = re.exec(html))) {
  modules.push({ name: match[1], index: match.index })
}

const interesting = new Set([
  'AliyunComGlobalNav',
  'AliyunComGlobalNavSearch',
  'Adc2025HomepageBanner',
  'Adc2025DoubleColumnsScrollScreen',
  'Adc2025HomepageProducts',
  'Adc2025HomepageAiSolution',
  'Adc2025HomepageInfrastructure',
  'Ace2024GlobalFooter',
])

function sliceModule(name) {
  const start = html.indexOf(`data-module-name="${name}"`)
  if (start < 0) return ''
  return html.slice(start, start + 12000)
}

function stats(chunk) {
  const text = chunk.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  const headings = [...text.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8)
  return {
    imgs: (chunk.match(/<img\b/g) || []).length,
    links: (chunk.match(/<a\b/g) || []).length,
    buttons: (chunk.match(/<button\b/g) || []).length,
    headings,
  }
}

const report = []
for (const name of interesting) {
  const chunk = sliceModule(name)
  report.push({ name, length: chunk.length, ...stats(chunk) })
}
fs.writeFileSync('docs/evidence/dachang/module-stats.json', JSON.stringify(report, null, 2))

const nav = sliceModule('AliyunComGlobalNav')
const navText = [...nav.matchAll(/>([^<]{2,24})</g)].map(m => m[1].trim()).filter(t => /[\u4e00-\u9fa5]/.test(t))
const uniqueNav = [...new Set(navText)].slice(0, 40)
fs.writeFileSync('docs/evidence/dachang/nav-text.txt', uniqueNav.join('\n'))
console.log('modules', modules.length)
console.log(report.map(item => `${item.name} imgs=${item.imgs} links=${item.links} h=${item.headings.join(' | ')}`).join('\n'))
