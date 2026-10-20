const fs = require('fs')
const html = fs.readFileSync('docs/evidence/dachang/aliyun.html', 'utf8')
const names = [...html.matchAll(/data-module-name="([^"]+)"/g)].map(m => m[1])
const count = {}
for (const name of names) count[name] = (count[name] || 0) + 1
console.log(Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('\n'))
console.log('---CSS---')
const css = [...html.matchAll(/hmod-[a-z0-9-]+\/[0-9.]+/g)].map(m => m[0])
console.log([...new Set(css)].join('\n'))
