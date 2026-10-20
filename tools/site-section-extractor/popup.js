const status = document.querySelector('#status')

async function extract(scroll, followLinks) {
  status.textContent = followLinks
    ? '已开始。左下角会显示进度：先滚完当前页并打开每个下拉，再进入导航里的其他页面。全部完成后，JSON 会出现在浏览器下载栏。'
    : '正在提取当前页…'
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) { status.textContent = '没有找到当前标签页。'; return }
  const result = await chrome.runtime.sendMessage({ type: 'site-extract-start', tabId: tab.id, scroll, followLinks })
  if (!result) { status.textContent = '没有收到结果。请在扩展程序页重新加载插件后再试。'; return }
  if (result.error) { status.textContent = result.error; return }
  status.textContent = `已下载 ${result.filename}\n${result.pageCount} 个页面，${result.dropdownCount} 个下拉，${result.sectionCount} 个板块。\n请看浏览器下载栏。`
}

document.querySelector('#full').addEventListener('click', () => extract(true, true))
document.querySelector('#view').addEventListener('click', () => extract(false, false))
