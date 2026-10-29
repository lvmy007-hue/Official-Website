// Code 128 条码编码（字符集 B，覆盖可打印 ASCII 32 到 126）：FNSKU、SKU 这类字母数字编码够用。
// 输出是“条与空的模块宽度”序列（从条开始，条空交替，共 6 段 + 终止符 7 段），由调用方按模块宽度画成矩形。

/** 每个符号值（0 到 106）的 6 段条空宽度；106 是终止符（7 段）。 */
const PATTERNS = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
] as const
const START_B = 104
const STOP = 106
/** 条码左右各留的空白（模块数，规范要求至少 10 个）。 */
export const CODE128_QUIET_MODULES = 10

export class Code128Error extends Error {}

/** 能不能用字符集 B 编码：只含可打印 ASCII，且不为空。 */
export const code128Supports = (text: string) => text.length > 0 && /^[\x20-\x7E]+$/.test(text)

/** 符号值序列：起始符 B、各字符、校验符（按位置加权求和对 103 取余）、终止符。 */
export function code128Symbols(text: string): number[] {
  if (!code128Supports(text)) throw new Code128Error(`不能编码成 Code 128：${text}`)
  const values = [...text].map(char => char.charCodeAt(0) - 32)
  const sum = values.reduce((total, value, index) => total + value * (index + 1), START_B)
  return [START_B, ...values, sum % 103, STOP]
}

/** 条空宽度序列（模块数）：偶数位是条，奇数位是空，从条开始。 */
export function code128Modules(text: string): number[] {
  return code128Symbols(text).flatMap(symbol => [...PATTERNS[symbol]!].map(Number))
}

/** 整个条码占的模块总数（不含两侧空白）。 */
export const code128Width = (text: string) => code128Modules(text).reduce((sum, width) => sum + width, 0)

/** 画条码用：返回每个黑条的起点与宽度（单位为模块，从 0 起，不含空白）。 */
export function code128Bars(text: string): Array<{ x: number; width: number }> {
  const bars: Array<{ x: number; width: number }> = []
  let x = 0
  code128Modules(text).forEach((width, index) => {
    if (index % 2 === 0) bars.push({ x, width })
    x += width
  })
  return bars
}
