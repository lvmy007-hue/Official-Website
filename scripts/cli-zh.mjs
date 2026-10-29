// 把 CLI 的英文碎片和文件路径收成一句中文，给会话同步器用。
import { basename } from 'node:path'

const FILE_ZH = [
  [/MassiveGrid/, '大表格'],
  [/grid-core/, '表格核心'],
  [/grid-toolbar/, '表格工具栏'],
  [/grid-columns/, '表格列定义'],
  [/grid-summary/, '表格汇总行'],
  [/grid-async/, '表格异步列'],
  [/PagedGrid/, '页码表格'],
  [/columns\.tsx/, '单元格类型'],
  [/TabBar/, '页签条'],
  [/NoticePanel/, '通知浮层'],
  [/PROGRESS\.md/, '进度文件'],
  [/14-execution-plan/, '执行计划'],
  [/change-log/, '变更记录'],
  [/style-guard/, '样式守卫'],
  [/summary-sql/, '日汇总刷新'],
]

const THINK_ZH = [
  [/pinn(ed|ing)?\s*col|固定列/i, '固定列'],
  [/column\s*group|列分组/i, '列分组'],
  [/summary\s*row|汇总行/i, '汇总行'],
  [/async\s*col|异步列/i, '异步列'],
  [/paginat|分页/i, '分页'],
  [/cell\s*type|单元格/i, '单元格类型'],
  [/tree\s*(data|row)|树形/i, '树形展开'],
  [/AG\s*Grid/i, 'AG Grid 能力'],
  [/antd|ant design/i, 'Ant Design 分页'],
  [/split|拆分|拆成/i, '拆文件'],
  [/400\s*(line|行)/i, '单文件行数上限'],
  [/virtuali[sz]e|虚拟滚动/i, '列虚拟滚动'],
  [/jsdom/i, 'jsdom 测试'],
  [/community/i, '社区版是否够用'],
]

const ATTEND_ZH = [
  [/jsdom|viewport width is zero|test environ/i, 'jsdom 里视口宽度为 0，虚拟滚动测试可能不准'],
  [/community/i, 'AG Grid 社区版不一定有树形数据，不够就改成展开子表'],
  [/400\s*(line|行)|MAX_LINES/i, '拆完后每个文件不能超过 400 行'],
  [/don't commit|不提交/i, '不要 git commit'],
  [/N\+1|unbounded/i, '热路径不能 N+1、不能无上限扫表'],
  [/first.?screen|首屏|350KB/i, '注意首屏体积'],
  [/租户隔离|RLS/i, '不要绕过租户隔离'],
]

const pick = (text, rules, limit = 6) => {
  const hit = []
  for (const [re, zh] of rules) {
    if (re.test(text) && !hit.includes(zh)) hit.push(zh)
    if (hit.length >= limit) break
  }
  return hit
}

export function fileZh(path = '') {
  const rel = String(path).replace(/\\/g, '/')
  for (const [re, zh] of FILE_ZH) if (re.test(rel)) return `${zh}（${basename(rel)}）`
  const name = basename(rel)
  return name && name !== rel ? `${name}` : rel || '未知文件'
}

export function thinkZh(text) {
  const hit = pick(text, THINK_ZH)
  return hit.length ? `在想：${hit.join('、')}` : ''
}

export function attendZh(text) {
  const hit = pick(text, ATTEND_ZH, 4)
  return hit.length ? hit.join('；') : ''
}

export function mergeStream(prev, chunk) {
  const next = String(chunk ?? '')
  const old = String(prev ?? '')
  if (!next) return old
  if (!old) return next
  if (next.startsWith(old)) return next
  if (old.startsWith(next) && next.length < old.length) return old
  if (old.endsWith(next)) return old
  if (next.length <= 80 && !next.includes(old.slice(-20))) return old + next
  return next
}

export function actionZh(raw = '') {
  const text = String(raw).replace(/^(?:动作|工具)\s*/, '')
  const path = text.match(/[A-Za-z]:\\[^\s]+|\/(?:src|apps|packages|docs|database|scripts)[^\s]*/)
  const file = path ? fileZh(path[0]) : ''
  if (/读文件|read/i.test(text)) return file ? `正在读 ${file}` : '正在读文件'
  if (/写文件|write/i.test(text)) return file ? `正在生成 ${file}` : '正在生成文件'
  if (/改文件|edit/i.test(text)) return file ? `正在改 ${file}` : '正在改文件'
  if (/搜索|grep/i.test(text)) {
    const q = text
      .split(/：|:\s*/)
      .slice(1)
      .join('：')
      .trim()
    return q ? `正在搜索 ${q.slice(0, 40)}` : '正在搜索代码'
  }
  if (/跑命令|shell/i.test(text)) {
    if (/vitest|ci\.mjs/i.test(text)) return '正在跑测试'
    if (/ag-grid|Pinned|Column/i.test(text)) return '正在查 AG Grid 的固定列/列分组接口'
    if (/prettier|eslint/i.test(text)) return '正在做格式和检查'
    return '正在跑命令'
  }
  if (/等待|await/i.test(text)) return '正在等待命令结束'
  return text.replace(/\s+/g, ' ').slice(0, 80)
}

export function speechZh(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  if (/[\u4e00-\u9fff]/.test(raw)) return raw.replace(/\s+/g, ' ').slice(0, 180)
  return thinkZh(raw).replace(/^在想：/, '它在说明：') || ''
}
