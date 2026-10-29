import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream, type PDFPage } from 'pdf-lib'
import { tokenize, type Token } from './pdf-tokens'

// 读 PDF 页面内容流，估算“已经画了东西的范围”：追加文字到亚马逊标签前先确认空白区够用、不会压住条码。
// 这里只做保守估算：凡是读不明白的东西（内嵌图片、渐变、批注、旋转页面、读不出的流）一律报告“不确定”，调用方就改成附页，不冒险叠印。

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}
export interface PageProbe {
  /** 页面坐标系下的已绘制范围；整页空白为 null。 */
  bounds: Rect | null
  /** 不为 null 表示无法确定空白区，不要在这一页上追加文字。 */
  uncertain: string | null
  /** 页面尺寸（pt）。 */
  width: number
  height: number
}
export interface TextPlacement {
  text: string
  x: number
  y: number
  size: number
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
]
const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]

// ---------------------------------------------------------------- 读内容流
function contentSource(page: PDFPage): { source: string } | { error: string } {
  const contents = page.node.Contents()
  if (!contents) return { source: '' }
  const streams: PDFStream[] = []
  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const item = contents.lookup(index)
      if (!(item instanceof PDFStream)) return { error: '页面内容流格式不认识' }
      streams.push(item)
    }
  } else if (contents instanceof PDFStream) streams.push(contents)
  else return { error: '页面内容流格式不认识' }
  const parts: string[] = []
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) return { error: '页面内容流尚未保存为文件，无法读取' }
    try {
      parts.push(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    } catch {
      return { error: '页面内容流压缩格式不支持，无法读取' }
    }
  }
  return { source: parts.join('\n') }
}

const numbers = (operands: Token[], count: number): number[] | null => {
  const values = operands.slice(-count).map(token => (token.t === 'num' ? token.v : Number.NaN))
  return values.length === count && values.every(Number.isFinite) ? values : null
}

interface XObjectInfo {
  kind: 'image' | 'form'
  rect: Rect | null
  matrix: Matrix
}
function xObjectInfo(page: PDFPage, name: string): XObjectInfo | null {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const stream = xobjects?.lookupMaybe(PDFName.of(name), PDFStream)
  if (!stream) return null
  const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()
  if (subtype === 'Image') return { kind: 'image', rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, matrix: IDENTITY }
  if (subtype !== 'Form') return null
  const box = stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray)
  const values = box ? box.asArray().map(item => (item instanceof PDFNumber ? item.asNumber() : Number.NaN)) : []
  if (values.length !== 4 || !values.every(Number.isFinite)) return { kind: 'form', rect: null, matrix: IDENTITY }
  const matrixArray = stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)
  const matrixValues = matrixArray ? matrixArray.asArray().map(item => (item instanceof PDFNumber ? item.asNumber() : Number.NaN)) : IDENTITY
  const matrix = matrixValues.length === 6 && matrixValues.every(Number.isFinite) ? (matrixValues as Matrix) : IDENTITY
  return { kind: 'form', rect: { x0: values[0]!, y0: values[1]!, x1: values[2]!, y1: values[3]! }, matrix }
}

/** 复合字体（Type0，中文等嵌入字体）一个字符占两个字节，其余按单字节算。 */
function isTwoByteFont(page: PDFPage, name: string): boolean {
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const font = fonts?.lookupMaybe(PDFName.of(name), PDFDict)
  return font?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Type0'
}

const decodeHex = (hex: string) => (hex.match(/../g) ?? []).map(pair => String.fromCharCode(parseInt(pair, 16))).join('')

interface Run {
  bounds: Rect | null
  uncertain: string | null
  texts: TextPlacement[]
}

function interpret(page: PDFPage, source: string): Run {
  const tokens = tokenize(source)
  const state: { bounds: Rect | null; uncertain: string | null } = { bounds: null, uncertain: null }
  const texts: TextPlacement[] = []
  const add = (x: number, y: number) => {
    const b = state.bounds
    state.bounds = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
  }
  const addRect = (m: Matrix, rect: Rect) => {
    for (const [x, y] of [
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x0, rect.y1],
      [rect.x1, rect.y1],
    ] as const)
      add(...apply(m, x, y))
  }
  let ctm = IDENTITY
  const stack: Matrix[] = []
  let path: Array<[number, number]> = []
  let tm = IDENTITY
  let tlm = IDENTITY
  let fontSize = 0
  let leading = 0
  let invisible = false
  let twoByte = false
  let operands: Token[] = []

  const showText = (token: Token) => {
    if (token.t !== 'str' || invisible) return
    const bytes = token.hex ? Math.ceil(token.v.length / 2) : token.v.length
    const glyphs = twoByte ? Math.ceil(bytes / 2) : bytes
    if (glyphs === 0) return
    const width = glyphs * fontSize * (twoByte ? 1 : 0.7)
    const matrix = mul(tm, ctm)
    addRect(matrix, { x0: 0, y0: -0.25 * fontSize, x1: width, y1: 0.9 * fontSize })
    const [x, y] = apply(matrix, 0, 0)
    if (!twoByte) texts.push({ text: token.hex ? decodeHex(token.v) : token.v, x, y, size: fontSize * Math.hypot(matrix[0], matrix[1]) })
    tm = mul([1, 0, 0, 1, width, 0], tm)
  }

  for (const token of tokens) {
    if (token.t !== 'op') {
      operands.push(token)
      continue
    }
    const op = token.v
    const args = operands
    operands = []
    switch (op) {
      case 'q':
        stack.push(ctm)
        break
      case 'Q':
        ctm = stack.pop() ?? ctm
        break
      case 'cm': {
        const m = numbers(args, 6)
        if (m) ctm = mul(m as Matrix, ctm)
        else state.uncertain ??= '页面变换参数读不明白'
        break
      }
      case 'm':
      case 'l': {
        const p = numbers(args, 2)
        if (p) path.push(apply(ctm, p[0]!, p[1]!))
        break
      }
      case 'c': {
        const p = numbers(args, 6)
        if (p) for (let i = 0; i < 6; i += 2) path.push(apply(ctm, p[i]!, p[i + 1]!))
        break
      }
      case 'v':
      case 'y': {
        const p = numbers(args, 4)
        if (p) for (let i = 0; i < 4; i += 2) path.push(apply(ctm, p[i]!, p[i + 1]!))
        break
      }
      case 're': {
        const p = numbers(args, 4)
        if (p) addRectPoints(path, ctm, p[0]!, p[1]!, p[2]!, p[3]!)
        break
      }
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        for (const [x, y] of path) add(x, y)
        path = []
        break
      case 'n':
        path = []
        break
      case 'BT':
        tm = IDENTITY
        tlm = IDENTITY
        break
      case 'Tf': {
        const size = args[args.length - 1]
        const name = args[args.length - 2]
        if (size?.t === 'num') fontSize = size.v
        twoByte = name?.t === 'name' ? isTwoByteFont(page, name.v) : false
        break
      }
      case 'TL': {
        const value = numbers(args, 1)
        if (value) leading = value[0]!
        break
      }
      case 'Tr': {
        const mode = numbers(args, 1)
        invisible = mode?.[0] === 3
        break
      }
      case 'Td':
      case 'TD': {
        const p = numbers(args, 2)
        if (p) {
          if (op === 'TD') leading = -p[1]!
          tlm = mul([1, 0, 0, 1, p[0]!, p[1]!], tlm)
          tm = tlm
        }
        break
      }
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        break
      case 'Tm': {
        const m = numbers(args, 6)
        if (m) {
          tm = m as Matrix
          tlm = tm
        }
        break
      }
      case 'Tj':
        showText(args[args.length - 1]!)
        break
      case "'":
      case '"':
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        showText(args[args.length - 1]!)
        break
      case 'TJ': {
        const list = args[args.length - 1]
        if (list?.t === 'arr') for (const item of list.v) showText(item)
        break
      }
      case 'Do': {
        const name = args[args.length - 1]
        const info = name?.t === 'name' ? xObjectInfo(page, name.v) : null
        if (!info || !info.rect) state.uncertain ??= '页面里有读不明白的图形对象'
        else addRect(mul(info.matrix, ctm), info.rect)
        break
      }
      case 'BI':
      case 'ID':
        state.uncertain ??= '页面里有内嵌图片，无法确定范围'
        break
      case 'sh':
        state.uncertain ??= '页面里有渐变填充，无法确定范围'
        break
      default:
        break
    }
  }
  return { bounds: state.bounds, uncertain: state.uncertain, texts }
}

function addRectPoints(path: Array<[number, number]>, ctm: Matrix, x: number, y: number, w: number, h: number) {
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const)
    path.push(apply(ctm, px, py))
}

/** 估算页面已绘制范围；只读，不改页面。页面必须是“从文件加载”的（内容流已是原始流）。 */
export function probePage(page: PDFPage): PageProbe {
  const { width, height } = page.getSize()
  const base = { width, height }
  if (page.getRotation().angle % 360 !== 0) return { bounds: null, uncertain: '页面带旋转，无法确定空白区', ...base }
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (annots && annots.size() > 0) return { bounds: null, uncertain: '页面带批注或表单，无法确定空白区', ...base }
  const mediaBox = page.getMediaBox()
  if (mediaBox.x !== 0 || mediaBox.y !== 0) return { bounds: null, uncertain: '页面原点不在左下角，无法确定空白区', ...base }
  const content = contentSource(page)
  if ('error' in content) return { bounds: null, uncertain: content.error, ...base }
  const run = interpret(page, content.source)
  return { bounds: run.bounds, uncertain: run.uncertain, ...base }
}

/** 取出页面里所有普通（单字节编码）文字的位置，测试用：确认追加的文字落在预期位置。 */
export function pageTexts(page: PDFPage): TextPlacement[] {
  const content = contentSource(page)
  if ('error' in content) return []
  return interpret(page, content.source).texts
}
