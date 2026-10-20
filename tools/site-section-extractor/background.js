function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hostName(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9.]+/gi, '-') } catch { return 'page' }
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
}

function shouldVisit(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (!parts.length || parts.length > 2) return false
  const last = parts[parts.length - 1]
  if (/login|register|signin|signup/i.test(pathname)) return false
  if (/\.(png|jpe?g|gif|svg|pdf|zip|css|js)$/i.test(last)) return false
  if (/\.(html|htm|php)$/i.test(last) && /\d/.test(last)) return false
  if (/^\d+$/.test(last)) return false
  return true
}

function linkedPages(page) {
  const base = new URL(page.url)
  const hrefs = []
  for (const item of page.navigation || []) hrefs.push(item.href)
  for (const menu of page.dropdowns || []) {
    for (const column of menu.columns || []) {
      for (const link of column.items || []) hrefs.push(link.href)
    }
    for (const link of menu.side?.items || []) hrefs.push(link.href)
  }
  for (const column of page.footerColumns || []) {
    for (const link of column.links || []) hrefs.push(link.href)
  }
  const seen = new Set([base.origin + base.pathname.replace(/\/$/, '')])
  const urls = []
  for (const href of hrefs) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue
    let url
    try { url = new URL(href, base) } catch { continue }
    if (url.origin !== base.origin) continue
    const path = url.pathname.replace(/\/$/, '') || '/'
    if (!shouldVisit(path)) continue
    const key = url.origin + path
    if (seen.has(key)) continue
    seen.add(key)
    urls.push(url.origin + path)
  }
  return urls.slice(0, 12)
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }, 20000)
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

async function note(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: text => {
      let bar = document.getElementById('__site-extract-status')
      if (!bar) {
        bar = document.createElement('div')
        bar.id = '__site-extract-status'
        bar.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:420px;padding:10px 14px;background:#1f2329;color:#fff;font:13px/1.45 sans-serif;border-radius:8px'
        document.documentElement.appendChild(bar)
      }
      bar.textContent = text
    },
  }).catch(() => {})
}

async function extractPage(tabId, scroll, reveal) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] })
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [scroll, reveal],
    func: (scrollPage, openMenus) => window.__runSiteExtract(scrollPage, openMenus),
  })
  return result?.result || null
}

async function saveJson(tabId, data) {
  const json = JSON.stringify(data, null, 2)
  const name = `${hostName(data.startedUrl)}-全站-${stamp()}.json`
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [name, json],
    func: (name, json) => {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.documentElement.appendChild(link)
      link.click()
      link.remove()
      let bar = document.getElementById('__site-extract-status')
      if (!bar) {
        bar = document.createElement('div')
        bar.id = '__site-extract-status'
        bar.style.cssText = 'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:420px;padding:10px 14px;background:#1f2329;color:#fff;font:13px/1.45 sans-serif;border-radius:8px'
        document.documentElement.appendChild(bar)
      }
      bar.textContent = `JSON 已下载：${name}。请看浏览器右上角下载栏，或打开下载文件夹。`
    },
  })
  return name
}

async function crawl(tabId, scroll, followLinks) {
  const first = await extractPage(tabId, scroll, true)
  if (!first) return { error: '当前页没有返回内容。请等页面加载完再提取。' }
  const pages = [first]
  const queue = followLinks ? linkedPages(first) : []
  for (let index = 0; index < queue.length; index += 1) {
    const url = queue[index]
    await note(tabId, `下拉已记录。正在打开第 ${index + 2}/${queue.length + 1} 页：${url}`)
    const loaded = waitForLoad(tabId)
    await chrome.tabs.update(tabId, { url })
    await loaded
    await delay(900)
    try {
      const page = await extractPage(tabId, scroll, true)
      if (page) pages.push(page)
    } catch (error) {
      pages.push({ url, error: String(error) })
    }
  }
  const data = {
    extractedAt: new Date().toISOString(),
    startedUrl: first.url,
    pageCount: pages.length,
    pages,
  }
  const filename = await saveJson(tabId, data)
  return {
    filename,
    pageCount: pages.length,
    dropdownCount: pages.reduce((sum, page) => sum + (page.dropdownCount || 0), 0),
    sectionCount: pages.reduce((sum, page) => sum + (page.sectionCount || 0), 0),
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'site-extract-start' || !message.tabId) return
  crawl(message.tabId, message.scroll !== false, message.followLinks !== false)
    .then(sendResponse)
    .catch(error => sendResponse({ error: String(error && error.message || error) }))
  return true
})
