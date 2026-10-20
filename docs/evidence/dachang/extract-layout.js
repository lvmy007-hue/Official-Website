const fs = require('fs')
const path = require('path')
const dir = 'docs/evidence/dachang/css'
const files = ['theme.css', 'banner.css', 'solution.css', 'box.css', 'linkbox.css', 'image.css', 'marquee.css', 'button.css', 'terminal.css', 'underline.css', 'infra.css']

function rules(css) {
  return css.split('}').map((part) => part.trim()).filter(Boolean)
}

const interesting = /min-height|height:|width:|grid-template|flex|position:|font-size|padding|gap:|border-radius|sticky|column|display:|top:|left:|background|max-width|margin/
for (const file of files) {
  const css = fs.readFileSync(path.join(dir, file), 'utf8')
  console.log('\n##', file, css.length)
  const vars = [...css.matchAll(/--[a-z0-9-]+:\s*[^;}{]{1,80}/gi)].slice(0, 40)
  if (vars.length) console.log('VARS', vars.map((m) => m[0].replace(/\s+/g, ' ')).join(' | '))
  const picked = rules(css).filter((r) => interesting.test(r) && r.length < 420).slice(0, 28)
  for (const rule of picked) console.log(rule.slice(0, 360))
}
