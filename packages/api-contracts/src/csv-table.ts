// 文本表格（CSV、制表符、分号分隔）的最小读取：装箱文件导入（P6-10）与供应商装箱单（P6-11）共用。纯函数，不带 zod。
// 支持双引号包裹（引号里的分隔符与双双引号按字面）；不支持引号内换行（一行就是一行）；分隔符按前几行出现次数最多的那个。

const DELIMITERS = [',', '\t', ';'] as const

/** 按一行表头判断分隔符：逗号、制表符、分号里出现次数最多的。 */
export function csvDelimiterOf(header: string): string {
  const counts = DELIMITERS.map(delimiter => ({ delimiter, count: header.split(delimiter).length - 1 }))
  return counts.sort((a, b) => b.count - a.count)[0]!.delimiter
}

/** 拆一行：支持双引号包裹（引号里的分隔符与双双引号按字面）。 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') quoted = false
      else current += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) {
      cells.push(current)
      current = ''
    } else current += char
  }
  cells.push(current)
  return cells.map(cell => cell.trim())
}

/**
 * 读成二维表：每一行文本对应结果里的一行（空行是空数组），所以下标加一就是文件里的行号。
 * 分隔符取前 30 个非空行里出现总次数最多的（装箱单顶部常有只写一个标题的行，不能只看第一行）。
 */
export function parseCsvTable(content: string): string[][] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const sample = lines.filter(line => line.trim() !== '').slice(0, 30)
  const delimiter = csvDelimiterOf(sample.join('\n'))
  return lines.map(line => (line.trim() === '' ? [] : splitCsvLine(line, delimiter)))
}
