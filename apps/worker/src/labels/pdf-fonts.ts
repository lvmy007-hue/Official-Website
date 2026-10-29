import { readFile } from 'node:fs/promises'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import { LabelError } from './errors'

// 标签文字用的字体：纯英文数字与拉丁字符用内置 Helvetica（不需要字体文件）；只要有一段文字含 Helvetica 编不出来的字符（中文等），
// 就必须用 LABEL_FONT_PATH 指向的 TTF/OTF 字体文件，没配或读不出来就失败并写明原因，绝不印成乱码或悄悄丢字。

export class LabelFontError extends LabelError {
  constructor(message: string) {
    super('LABEL_FONT_MISSING', message)
  }
}

/** Helvetica（WinAnsi 编码）能编出来的字符：可打印 ASCII 与拉丁字符补充区。 */
const WIN_ANSI = /^[\x20-\x7E\xA0-\xFF]*$/

/** 去掉换行、制表等控制字符（标签文字只有单行），保证文字落在可预期的位置。 */
export const cleanLabelText = (text: string) => text.replace(/\p{Cc}+/gu, ' ').trim()
export const needsEmbeddedFont = (text: string) => !WIN_ANSI.test(text)

export interface LabelFonts {
  regular: PDFFont
  bold: PDFFont
  /** 实际用了自定义字体（日志与测试用）。 */
  embedded: boolean
}

/**
 * 给文档装上字体。`texts` 是这份文档要印的全部文字：全部能用 Helvetica 就不加载字体文件。
 * 自定义字体加子集嵌入（文件体积小），粗体与常规用同一个字体文件（中文字体通常没有单独的粗体文件）。
 */
export async function embedLabelFonts(doc: PDFDocument, texts: readonly string[], fontPath: string | undefined): Promise<LabelFonts> {
  let needed: string | null = null
  for (const text of texts) {
    if (needsEmbeddedFont(text)) {
      needed = text
      break
    }
  }
  if (needed === null) {
    return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), embedded: false }
  }
  const sample = needed.length > 20 ? `${needed.slice(0, 20)}…` : needed
  if (!fontPath)
    throw new LabelFontError(`标签上有 Helvetica 印不出来的字符（例如“${sample}”），但 worker 没有配置字体文件（环境变量 LABEL_FONT_PATH）；请配置中文字体，或把标签文字改成英文后重新生成`)
  let bytes: Buffer
  try {
    bytes = await readFile(fontPath)
  } catch {
    throw new LabelFontError(`字体文件读不出来（${fontPath}）；请检查 worker 的 LABEL_FONT_PATH 配置与文件权限`)
  }
  doc.registerFontkit(fontkit)
  try {
    const font = await doc.embedFont(bytes, { subset: true })
    const supported = new Set(font.getCharacterSet())
    for (const text of texts) {
      for (const char of text) {
        const code = char.codePointAt(0)!
        if (code > 0x20 && !supported.has(code)) throw new Error(`字体里没有“${char}”这个字`)
      }
    }
    return { regular: font, bold: font, embedded: true }
  } catch (error) {
    throw new LabelFontError(`字体文件不能用来印标签（${fontPath}）：${error instanceof Error ? error.message : '无法解析'}；请换成 TTF 或 OTF 字体，并确认它包含标签上用到的字符`)
  }
}

/** 把一段文字按宽度折行（英文按空格，中文按字），最多折成 `maxLines` 行；放不下返回 null。 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] | null {
  const width = (value: string) => font.widthOfTextAtSize(value, size)
  const lines: string[] = []
  let current = ''
  for (const token of text.match(/\S+\s*|\s+/g) ?? [text]) {
    if (width((current + token).trimEnd()) <= maxWidth) {
      current += token
      continue
    }
    if (current) lines.push(current.trimEnd())
    let rest = token
    // 一个词本身就超宽（长编码或连续中文）：按字符硬折
    while (width(rest.trimEnd()) > maxWidth) {
      let cut = rest.length
      while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut -= 1
      if (cut <= 0 || width(rest.slice(0, cut)) > maxWidth) return null
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
      if (lines.length > maxLines) return null
    }
    current = rest
  }
  if (current.trim()) lines.push(current.trimEnd())
  return lines.length <= maxLines ? lines : null
}
