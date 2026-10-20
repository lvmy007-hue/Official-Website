const fs = require('fs')
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')
const seen = []
for (const match of html.matchAll(/data-module-name="([^"]+)"/g)) {
  if (!seen.includes(match[1])) seen.push(match[1])
}
console.log(seen.join('\n'))
