const fs = require('fs')
const path = require('path')
const dir = 'docs/evidence/dachang/css'
for (const file of ['products.css', 'nav.css', 'footer.css']) {
  const css = fs.readFileSync(path.join(dir, file), 'utf8')
  const rules = css.split('}').map(part => part.trim() + '}').filter(rule => /font-size|height:|padding:|grid-template|position:|min-width:|max-width:|gap:|sticky|flex:/.test(rule))
  const picked = rules.filter(rule => /1056|font-size|sticky|grid-template-columns|height:\s*\d|padding:\s*\d/.test(rule)).slice(0, 35)
  console.log('\n## ' + file + ' rules ' + rules.length)
  console.log(picked.join('\n'))
}
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')
const vars = [...html.matchAll(/--(text-heading\d|text-body|font-weight-[a-z0-9-]+|line-height-[a-z0-9-]+|spacing-[a-z0-9-]+)\s*:\s*([^;}]+)/g)]
const uniq = new Map()
for (const item of vars) uniq.set(item[1], item[2].trim())
console.log('\n## tokens')
for (const [key, value] of uniq) console.log(key + ' = ' + value)
