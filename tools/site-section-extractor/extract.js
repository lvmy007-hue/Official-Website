function clean(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function box(element) {
  const rect = element.getBoundingClientRect()
  return { x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) }
}

function className(element) {
  return clean(element?.getAttribute?.('class'), 120)
}

function isWidget(element) {
  return Boolean(element.closest('[class*="message-"], [class*="chat-widget"], [id*="intercom"], [id*="crisp"]'))
}

function visible(element) {
  if (isWidget(element)) return false
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 160 && rect.height > 28
}

function plainText(element) {
  const copy = element.cloneNode(true)
  copy.querySelectorAll('svg, i, img').forEach(node => node.remove())
  return clean(String(copy.textContent || '').replace(/([^\u0000-\u00ff])\s+(?=[^\u0000-\u00ff])/g, '$1'), 80)
}

function linkDetail(anchor) {
  const titleNode = anchor.querySelector('.title-with-icon, .text-base, h3, h4, strong, b')
  const descNode = [...anchor.querySelectorAll('.text-textSup, .text-sm, p, small')].find(node => !titleNode || !titleNode.contains(node))
  const title = clean(titleNode ? titleNode.textContent : anchor.textContent, 80)
  let description = descNode ? clean(descNode.textContent, 180) : ''
  if (!description) {
    const full = clean(anchor.textContent, 320)
    if (title && full.startsWith(title) && full.length > title.length) description = clean(full.slice(title.length), 180)
  }
  if (description === title) description = ''
  return {
    title,
    description,
    href: anchor.getAttribute('href') || '',
    icon: Boolean(anchor.querySelector('svg, img, i')),
  }
}

function columnFrom(node) {
  const heading = node.querySelector(':scope > .second-menu-title, :scope > h3, :scope > h4, :scope > strong')
  const anchors = [...node.querySelectorAll('a')]
  const items = anchors.length
    ? anchors.map(linkDetail).filter(item => item.title)
    : [{ title: clean(node.textContent, 80), description: '', href: '', icon: false }].filter(item => item.title)
  return { title: clean(heading ? heading.textContent : '', 80), items }
}

function sideFrom(tip) {
  if (!tip) return null
  const heading = [...tip.children].find(node => node.matches('span, h3, h4, div, p') && !node.querySelector('a'))
  return {
    title: clean(heading ? heading.textContent : '', 80),
    items: [...tip.querySelectorAll('a')].map(linkDetail).filter(item => item.title),
    media: [...tip.querySelectorAll('img')].slice(0, 4).map(img => ({
      alt: clean(img.alt, 80),
      src: clean((img.currentSrc || img.getAttribute('src') || '').split('?')[0].split('/').pop(), 80),
    })),
  }
}

function parsePanel(panel, owner) {
  const tip = panel.querySelector(':scope > .lx-submenu-tip, .lx-submenu-tip')
  const columnNodes = [...panel.querySelectorAll(':scope > dd, :scope > li, dl > dd, .lx-submenu > dd')].filter(node => !tip || !tip.contains(node))
  let columns = columnNodes.map(columnFrom).filter(column => column.title || column.items.length)
  if (columns.length > 1 && columns.every(column => !column.title && column.items.length <= 1)) {
    columns = [{ title: '', items: columns.flatMap(column => column.items) }]
  }
  if (!columns.length) {
    const items = [...panel.querySelectorAll('a')].filter(anchor => !tip || !tip.contains(anchor)).map(linkDetail).filter(item => item.title)
    if (items.length) columns = [{ title: '', items }]
  }
  const triggerNode = owner?.querySelector(':scope > .lx-lang-title, :scope > .lx-menu-title, :scope > div > .lx-menu-title, :scope > a, :scope > span, :scope > button')
  let trigger = triggerNode ? plainText(triggerNode) : ''
  if (panel.matches('.lx-lang-panel') || owner?.matches?.('.lx-lang-switch, .lx-mobile-lang-switch')) trigger = '语言'
  return { trigger, kind: 'dropdown', columns, side: sideFrom(tip) }
}

function dropdownKey(item) {
  return [item.trigger, ...item.columns.flatMap(column => column.items.map(link => link.href + link.title))].join('|')
}

function mobileMenus() {
  return [...document.querySelectorAll('.lx-m-menu')].flatMap(menu => [...menu.children].filter(item => item.tagName === 'LI').map(item => {
    const label = [...item.children].find(node => node.matches('span, a, button'))
    const panel = [...item.children].find(node => node.matches('div, ul'))
    const trigger = label ? plainText(label) : ''
    const groups = panel ? [...panel.querySelectorAll('li')].filter(row => row.querySelector(':scope > span') && row.querySelector(':scope > ul')) : []
    const columns = groups.length
      ? groups.map(group => ({
        title: plainText(group.querySelector(':scope > span')),
        items: [...group.querySelectorAll(':scope > ul a')].map(linkDetail).filter(link => link.title),
      })).filter(column => column.items.length)
      : [{ title: '', items: [...(panel ? panel.querySelectorAll('a') : [])].map(linkDetail).filter(link => link.title) }].filter(column => column.items.length)
    return { trigger, kind: 'mobile', columns, side: null }
  })).filter(item => item.trigger && item.columns.length)
}

function collectDropdowns() {
  const panels = [...document.querySelectorAll('.panel, .lx-lang-panel, .lx-mobile-lang-switch ul')]
  const loose = [...document.querySelectorAll('[role="submenu"], .lx-submenu, [class*="dropdown"], [class*="submenu"], [class*="mega"]')]
    .filter(element => !element.closest('.panel, .lx-lang-panel') && element.querySelector('a'))
  const found = []
  const seen = new Set()
  for (const panel of [...panels, ...loose]) {
    if (isWidget(panel)) continue
    const owner = panel.closest('.lx-menu-item, .lx-lang-switch, .lx-mobile-lang-switch, [role="menuitem"]') || panel.parentElement
    const item = parsePanel(panel, owner)
    if (!item.columns.length && !item.side?.items?.length && !item.side?.title) continue
    const key = dropdownKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(item)
  }
  return [...found, ...mobileMenus()]
}

function isButtonLike(element) {
  const name = element.getAttribute('class') || ''
  return element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' || /lx-button|el-button|\bbtn\b|button/.test(name)
}

function buttonStyle(element) {
  const name = element.getAttribute('class') || ''
  if (/primary/.test(name)) return 'primary'
  if (/border/.test(name)) return 'border'
  if (/plain/.test(name)) return 'plain'
  if (/ordinary/.test(name)) return 'ordinary'
  if (/text/.test(name)) return 'text'
  return 'default'
}

function buttonInfo(element) {
  return {
    text: plainText(element),
    href: element.getAttribute('href') || '',
    style: buttonStyle(element),
    className: className(element),
  }
}

function placeOf(element) {
  if (element.closest('header')) return '页头'
  if (element.closest('.lx-m-menu, aside')) return '移动导航'
  if (element.closest('footer, .footer-banner')) return '页脚'
  if (getComputedStyle(element).position === 'fixed') return '悬浮'
  let node = element.parentElement
  for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
    const heading = [...node.querySelectorAll('h1, h2, h3, h4, h5, [class*="title"]')].find(item => {
      const text = clean(item.textContent, 40)
      return text && !/客服|udesk/i.test(text) && !isWidget(item) && (item.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    if (heading) return clean(heading.textContent, 40)
    const label = [...node.children].find(child => {
      if (child.contains(element) || child.querySelector('a, button, img')) return false
      const text = clean(child.textContent, 40)
      return text.length > 1 && text.length <= 24
    })
    if (label) return clean(label.textContent, 40)
    node = node.parentElement
  }
  return ''
}

function collectButtonBlocks() {
  const buttons = [...document.querySelectorAll('a, button, [role="button"]')].filter(element => {
    if (!isButtonLike(element) || isWidget(element)) return false
    if (element.closest('.panel, .lx-submenu, .lx-lang-panel, [role="submenu"], .swiper-slide-duplicate, #udesk_container, [id*="udesk"]')) return false
    return true
  })
  const groups = new Map()
  for (const button of buttons) {
    const parent = button.parentElement
    if (!parent) continue
    if (!groups.has(parent)) groups.set(parent, [])
    groups.get(parent).push(button)
  }
  const seen = new Set()
  return [...groups.entries()].map(([parent, group]) => {
    const style = getComputedStyle(parent)
    const selfFixed = group.some(button => getComputedStyle(button).position === 'fixed')
    return {
      place: placeOf(group[0]),
      fixed: style.position === 'fixed' || selfFixed,
      className: className(parent),
      buttons: group.map(buttonInfo).filter(item => item.text),
    }
  }).filter(block => {
    if (!block.buttons.length) return false
    const key = block.place + '|' + block.buttons.map(button => button.text + button.href).join(',')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function itemLabel(element) {
  const heading = element.querySelector('h1,h2,h3,h4,h5,b,strong')
  return clean(heading ? heading.textContent : element.textContent, 80)
}

function repeatedGroups(root) {
  const groups = []
  for (const parent of root.querySelectorAll('div, ul, ol, section')) {
    const kids = [...parent.children].filter(visible)
    if (kids.length < 3 || kids.length > 30) continue
    const heights = kids.map(kid => kid.getBoundingClientRect().height)
    const average = heights.reduce((sum, height) => sum + height, 0) / heights.length
    if (average < 24 || !heights.every(height => Math.abs(height - average) < Math.max(28, average * 0.45))) continue
    const signature = className(kids[0])
    if (groups.some(group => group.signature === signature && group.count === kids.length)) continue
    groups.push({
      count: kids.length,
      signature,
      samples: kids.slice(0, 12).map(itemLabel).filter(Boolean),
    })
  }
  return groups.slice(0, 6)
}

function summarize(element, index) {
  const headings = [...element.querySelectorAll('h1,h2,h3,h4')].filter(heading => !isWidget(heading)).slice(0, 8).map(heading => ({
    tag: heading.tagName.toLowerCase(),
    text: clean(heading.textContent, 120),
  }))
  const buttons = [...element.querySelectorAll('a, button, [role="button"]')]
    .filter(control => isButtonLike(control) && !control.closest('.panel, .lx-submenu, [role="submenu"]'))
    .map(buttonInfo)
    .filter(item => item.text)
    .slice(0, 24)
  return {
    index,
    kind: 'section',
    tag: element.tagName.toLowerCase(),
    id: element.id || '',
    className: className(element),
    box: box(element),
    headings,
    text: clean(element.innerText, 280),
    buttons,
    groups: repeatedGroups(element),
  }
}

function sectionCandidates() {
  const selector = [
    'header',
    'footer',
    'aside',
    '.lx-banner-container',
    '.lx-home-module',
    '.section-reason',
    '.case-module-box',
    '.footer-banner',
    'section',
    '[class*="section"]',
    '[class*="banner"]',
    '[class*="floor"]',
    '[class*="module"]',
  ].join(', ')
  const found = [...document.querySelectorAll(selector)].filter(visible).filter(element => !/message-section/.test(element.getAttribute('class') || ''))
  return found.filter(element => {
    if (element.matches('header, footer, aside')) return true
    const nested = found.filter(other => other !== element && element.contains(other))
    return nested.length < 2
  })
}

function footerColumns() {
  const footer = document.querySelector('footer')
  if (!footer) return []
  const lists = [...footer.querySelectorAll('ul, ol, dl')].filter(list => list.querySelectorAll('a').length >= 2 && !isWidget(list))
  const leaves = lists.filter(list => !lists.some(other => other !== list && list.contains(other)))
  return leaves.slice(0, 12).map(list => {
    const heading = list.previousElementSibling || list.parentElement?.querySelector('h3, h4, strong, .footer-title')
    let title = clean(heading && !list.contains(heading) ? heading.textContent : '', 60)
    if (!title && list.querySelector('[class*="friend"]')) title = '友情链接'
    return {
      title,
      links: [...list.querySelectorAll('a')].slice(0, 20).map(linkDetail).filter(item => item.title),
    }
  }).filter(column => column.links.length)
}

function navigation() {
  const items = [...document.querySelectorAll('.lx-menu > .lx-menu-item, ul.lx-menu > li')]
  const source = items.length ? items : [...document.querySelectorAll('header .lx-menu-item')]
  return source.map(item => {
    const title = item.querySelector('.lx-menu-title, a, span')
    const link = item.querySelector('a[href]')
    return {
      text: title ? plainText(title) : '',
      href: link?.getAttribute('href') || '',
      dropdown: Boolean(item.querySelector('.panel, [role="submenu"], .lx-submenu')),
    }
  }).filter(item => item.text)
}

function pageHeight() {
  return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight)
}

function setStatus(text) {
  let bar = document.getElementById('__site-extract-status')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = '__site-extract-status'
    bar.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:360px;padding:10px 14px;background:#1f2329;color:#fff;font:13px/1.45 sans-serif;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.2)'
    document.documentElement.appendChild(bar)
  }
  bar.textContent = text
}

function rememberStyle(element) {
  if (element.dataset.extractStyle != null) return
  element.dataset.extractStyle = element.getAttribute('style') || ''
}

function openElement(element) {
  rememberStyle(element)
  element.style.setProperty('display', 'block', 'important')
  element.style.setProperty('visibility', 'visible', 'important')
  element.style.setProperty('opacity', '1', 'important')
  element.style.setProperty('height', 'auto', 'important')
  element.style.setProperty('max-height', 'none', 'important')
  element.style.setProperty('overflow', 'visible', 'important')
}

function restoreElement(element) {
  if (element.dataset.extractStyle == null) return
  if (element.dataset.extractStyle) element.setAttribute('style', element.dataset.extractStyle)
  else element.removeAttribute('style')
  delete element.dataset.extractStyle
}

function menuStyle() {
  let style = document.getElementById('__site-extract-menu-style')
  if (style) return style
  style = document.createElement('style')
  style.id = '__site-extract-menu-style'
  style.textContent = [
    'header .panel, header [role="submenu"], header .lx-submenu, header .lx-lang-panel, .lx-m-menu div, .lx-m-menu ul {',
    'display:block !important; visibility:visible !important; opacity:1 !important;',
    'height:auto !important; max-height:none !important; overflow:visible !important; pointer-events:auto !important;',
    '}',
  ].join('')
  document.documentElement.appendChild(style)
  return style
}

function menuOwners() {
  const found = [...document.querySelectorAll('.lx-menu-item, .lx-lang-switch, header [role="menuitem"], nav [role="menuitem"]')]
  const owners = found.filter(item => item.querySelector('.panel, .lx-lang-panel, [role="submenu"], .lx-submenu, ul'))
  if (owners.length) return owners.filter(item => !owners.some(other => other !== item && other.contains(item)))
  return [...document.querySelectorAll('header li, nav li')].filter(item => item.querySelector('ul, .panel, [role="menu"]'))
}

async function revealMenus() {
  window.scrollTo(0, 0)
  await delay(300)
  menuStyle()
  const owners = menuOwners()
  let opened = 0
  for (const owner of owners) {
    const panels = [...owner.querySelectorAll('.panel, .lx-lang-panel, [role="submenu"], .lx-submenu, ul')].filter(panel => !panelsInside(panel))
    if (!panels.length) continue
    const name = plainText(owner.querySelector('.lx-menu-title, .lx-lang-title, a, span') || owner)
    setStatus(`正在打开下拉：${name || '菜单'}`)
    owner.scrollIntoView({ block: 'start', inline: 'nearest' })
    panels.forEach(openElement)
    const title = owner.querySelector('.lx-menu-title, .lx-lang-title, a, button, span') || owner
    title.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }))
    title.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }))
    opened += 1
    await delay(700)
  }
  return opened
}

function panelsInside(panel) {
  return Boolean(panel.parentElement?.closest('.panel, .lx-lang-panel'))
}

async function scrollPage() {
  const step = Math.max(280, Math.round(window.innerHeight * 0.7))
  let screens = 0
  const startHeight = pageHeight()
  for (let y = 0; y <= startHeight; y += step) {
    screens += 1
    const height = pageHeight()
    setStatus(`正在逐屏滚动 ${location.pathname} ${Math.min(y, height)} / ${height}`)
    window.scrollTo(0, y)
    await delay(620)
  }
  const grown = pageHeight()
  if (grown > startHeight + 200) {
    for (let y = startHeight; y <= grown; y += step) {
      screens += 1
      setStatus(`页面变长，继续滚动 ${Math.min(y, grown)} / ${grown}`)
      window.scrollTo(0, y)
      await delay(620)
    }
  }
  window.scrollTo(0, pageHeight())
  await delay(800)
  window.scrollTo(0, 0)
  await delay(250)
  return screens
}

function mergeDropdowns(lists) {
  const merged = []
  const seen = new Set()
  for (const item of lists.flat()) {
    const key = (item.kind || '') + '|' + (item.trigger || dropdownKey(item))
    const previous = merged.find(entry => entry.kind === item.kind && entry.trigger && entry.trigger === item.trigger)
    if (previous) {
      const previousCount = previous.columns.reduce((sum, column) => sum + column.items.length, 0)
      const nextCount = item.columns.reduce((sum, column) => sum + column.items.length, 0)
      if (nextCount > previousCount) merged[merged.indexOf(previous)] = item
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

async function runExtract(scroll, reveal) {
  const started = Date.now()
  setStatus(`开始提取 ${location.pathname}。先滚完这一页，再打开下拉。`)
  let screens = 0
  if (scroll) screens = await scrollPage()
  const before = collectDropdowns()
  let menusOpened = 0
  if (reveal !== false) menusOpened = await revealMenus()
  const dropdowns = mergeDropdowns([before, collectDropdowns()])
  document.getElementById('__site-extract-menu-style')?.remove()
  document.querySelectorAll('[data-extract-style]').forEach(restoreElement)
  const buttonBlocks = collectButtonBlocks()
  const sections = sectionCandidates().map(summarize)
  return {
    extractedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pageHeight: pageHeight(),
    screens,
    menusOpened,
    elapsedMs: Date.now() - started,
    navigation: navigation(),
    dropdownCount: dropdowns.length,
    buttonBlockCount: buttonBlocks.length,
    sectionCount: sections.length,
    dropdowns,
    buttonBlocks,
    footerColumns: footerColumns(),
    sections,
  }
}

function collectNow() {
  const dropdowns = collectDropdowns()
  const buttonBlocks = collectButtonBlocks()
  const sections = sectionCandidates().map(summarize)
  return {
    navigation: navigation(),
    dropdownCount: dropdowns.length,
    buttonBlockCount: buttonBlocks.length,
    sectionCount: sections.length,
    dropdowns,
    buttonBlocks,
    footerColumns: footerColumns(),
    sections,
  }
}

window.__collectSiteNow = collectNow
window.__runSiteExtract = runExtract
