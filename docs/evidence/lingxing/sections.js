const fs = require('fs')
const html = fs.readFileSync('docs/evidence/lingxing/home.html', 'utf8')
const classes = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1])
const interesting = classes.filter((c) => /banner|section|footer|header|nav|submenu|logo|case|reason|cert|aside|float|price|marquee|swiper|feature|core/i.test(c))
const uniq = []
const seen = new Set()
for (const c of interesting) {
  const key = c.split(' ').slice(0, 4).join(' ')
  if (seen.has(key)) continue
  seen.add(key)
  uniq.push(key)
}
console.log(uniq.slice(0, 80).join('\n'))
