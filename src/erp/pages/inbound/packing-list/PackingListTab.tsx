import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Card, Collapse, Select, Space, Typography } from 'antd'
import {
  PACKING_FILE_HINT,
  PACKING_MATCH_HINT,
  SKU_ALIAS_MANAGE,
  type InboundOverview,
  type PackingApplyResponse,
  type PackingPreviewResponse,
  type PackingPreviewRow,
  type SupplierListResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../../api'
import { FormAction, PagedGrid, type PageFetcher } from '../../../components'
import { describeError } from '../../../query/errors'
import { useApiQuery } from '../../../query/api-query'
import { useSession } from '../../../session/session'
import { usePlanWrite } from '../inbound-actions'
import { inboundGuard } from '../inbound-ui'
import { readCsvFile } from '../box-editor/decode-csv'
import { DecisionContext, packingColumns, type PackingDecisionApi } from './packing-list-columns'
import {
  EMPTY_SETTINGS,
  bytesToBase64,
  decisionList,
  formatOf,
  liveBoxIssues,
  readiness,
  requestBody,
  sizeProblem,
  withDecision,
  type DecisionMap,
  type PackingFile,
  type PackingSettings,
} from './packing-list-state'
import { PackingListSettings } from './PackingListSettings'
import { SaveMappingAction } from './SaveMappingAction'

// 装箱单匹配（P6-11，16 章 5）：选供应商与装箱单文件（Excel 或 CSV）→ 识别并匹配计划里的 SKU → 逐行确认 → 整体写入“箱内物品”。
// 匹配顺序：SKU、FNSKU、ASIN 精确比对 → 外部货号映射 → 相似的候选（只提示，不自动采用）。预览不改任何数据；应用才会替换现有箱子（保存在我们这里，提交给亚马逊是单独的动作）。
// 应用前的“哪些行还没解决”与服务端用同一个函数计算（resolvePacking），按钮状态与服务端判断一致。

const PAGE_SIZE_HINT = '装箱单最多 2000 行，表格分页显示；决定（选 SKU、忽略、记住）按行号保存，翻页不会丢。'

const readFile = async (file: File): Promise<PackingFile> => {
  const format = formatOf(file.name)
  if (format === 'XLS') throw new Error('不支持老版 Excel（.xls），请在 Excel 里另存为 .xlsx 或 CSV 后再选')
  if (format === 'CSV') return { fileName: file.name, format, content: await readCsvFile(file) }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
  return { fileName: file.name, format, content: bytesToBase64(new Uint8Array(buffer)) }
}

export function PackingListTab({ overview, onApplied }: { overview: InboundOverview; onApplied: () => void }) {
  const { message } = App.useApp()
  const { canPermission } = useSession()
  const write = usePlanWrite(overview.plan.id)
  const planId = overview.plan.id
  const [file, setFile] = useState<PackingFile | null>(null)
  const [settings, setSettings] = useState<PackingSettings>(EMPTY_SETTINGS)
  const [analysis, setAnalysis] = useState<PackingPreviewResponse | null>(null)
  const [decisions, setDecisions] = useState<DecisionMap>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [panel, setPanel] = useState<string[]>([])
  const latest = useRef(0)

  const suppliers = useApiQuery<SupplierListResponse>({ domain: 'reference', path: '/suppliers', params: { pageSize: 200 }, scoped: false, enabled: canPermission('supplier.read') })
  const planItems = useMemo(() => overview.items.map(item => ({ sku: item.sku, productName: item.productName })), [overview.items])
  const planSkus = useMemo(() => new Set(overview.items.map(item => item.sku)), [overview.items])
  const saveState = overview.actions.SAVE_BOXES
  const canWrite = canPermission('inbound.plan.write') && saveState.allowed

  const run = useCallback(
    async (nextFile: PackingFile, nextSettings: PackingSettings, keepDecisions: boolean) => {
      const ticket = ++latest.current
      const tooBig = sizeProblem(nextFile)
      if (tooBig) {
        setProblem(tooBig)
        return
      }
      setBusy(true)
      setProblem(null)
      try {
        const result = await apiFetch<PackingPreviewResponse>(`/inbound/plans/${encodeURIComponent(planId)}/packing-list/parse`, {
          method: 'POST',
          body: JSON.stringify(requestBody(nextFile, nextSettings)),
        })
        if (ticket !== latest.current) return
        setAnalysis(result)
        // 缺列或整份文件有问题时自动展开设置，让人直接去选列
        if (result.fatal || result.missingFields.length > 0) setPanel(['settings'])
        setRound(value => value + 1)
        // 重新识别后行号可能变了：只保留仍然存在的行的决定
        setDecisions(current => (keepDecisions ? Object.fromEntries(Object.entries(current).filter(([line]) => result.rows.some(row => row.line === Number(line)))) : {}))
      } catch (error) {
        if (ticket !== latest.current) return
        const info = describeError(error)
        setProblem(info.fieldErrors?.content?.[0] ?? info.message)
        setAnalysis(null)
      } finally {
        if (ticket === latest.current) setBusy(false)
      }
    },
    [planId],
  )

  const pick = async (picked: File | undefined) => {
    setProblem(null)
    if (!picked) return
    try {
      const next = await readFile(picked)
      setFile(next)
      const nextSettings = { ...EMPTY_SETTINGS, supplierId: settings.supplierId, defaults: settings.defaults }
      setSettings(nextSettings)
      await run(next, nextSettings, false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : describeError(error).message)
    }
  }

  const rows = analysis?.rows
  const rowsRef = useRef<PackingPreviewRow[]>([])
  rowsRef.current = rows ?? []
  const fetchPage = useCallback<PageFetcher<PackingPreviewRow>>(
    async ({ page, pageSize }) => ({ items: rowsRef.current.slice((page - 1) * pageSize, page * pageSize), total: rowsRef.current.length }),
    [],
  )
  const columns = useMemo(() => packingColumns(), [])

  const ready = useMemo(() => readiness(analysis, decisions, planSkus, settings.defaults), [analysis, decisions, planSkus, settings.defaults])
  const boxIssues = useMemo(() => liveBoxIssues(analysis, decisions, settings.defaults), [analysis, decisions, settings.defaults])
  const canRemember = analysis?.canRemember ?? canPermission(SKU_ALIAS_MANAGE)
  const api = useMemo<PackingDecisionApi>(
    () => ({
      decisions,
      boxIssues,
      choose: (line, sku) => setDecisions(current => withDecision(current, line, { sku })),
      ignore: (line, value) => setDecisions(current => withDecision(current, line, { ignore: value })),
      remember: (line, value) => setDecisions(current => withDecision(current, line, { remember: value })),
      planItems,
      canRemember,
      rememberBlockedReason: analysis?.rememberBlockedReason ?? '你没有维护外部货号映射的权限',
      readOnly: !canWrite,
    }),
    [decisions, boxIssues, planItems, canRemember, analysis?.rememberBlockedReason, canWrite],
  )

  const apply = async () => {
    if (!file || !analysis) throw new Error('请先选择装箱单')
    const body = { ...requestBody(file, settings), version: overview.plan.version, decisions: decisionList(decisions) }
    const result = (await write.post('/packing-list/apply', body)) as unknown as PackingApplyResponse
    void message.success(
      `已写入 ${result.imported.boxTypes} 个箱型，共 ${result.imported.boxes} 箱、${result.imported.units} 件${result.remembered > 0 ? `；已记住 ${result.remembered} 个外部货号` : ''}`,
    )
  }

  const applyReason = !saveState.allowed
    ? (saveState.reason ?? '当前状态不允许改装箱')
    : !analysis
      ? '先选择装箱单'
      : analysis.fatal
        ? analysis.fatal
        : (ready.blockers[0] ?? (ready.canApply ? undefined : '没有可以装箱的行'))
  const supplierOptions = [{ value: '', label: '不指定供应商（只用通用映射）' }, ...(suppliers.data?.items ?? []).map(item => ({ value: item.id, label: `${item.code} ${item.name}` }))]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="packing-list-tab">
      <Alert type="info" showIcon message="用供应商的装箱单自动对应计划里的 SKU" description={`${PACKING_FILE_HINT} ${PACKING_MATCH_HINT}`} />
      <Card size="small">
        <Space wrap size={12} align="center">
          <label>
            供应商{' '}
            <Select
              aria-label="供应商"
              style={{ width: 260 }}
              disabled={busy || !canPermission('supplier.read')}
              value={settings.supplierId ?? ''}
              options={supplierOptions}
              onChange={value => setSettings({ ...settings, supplierId: value || null, columns: {} })}
            />
          </label>
          <input
            aria-label="装箱单文件"
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv,.txt,.tsv,text/csv,text/plain"
            disabled={busy}
            onChange={event => {
              void pick(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button disabled={!file || busy} loading={busy} onClick={() => file && void run(file, settings, true)}>
            重新识别
          </Button>
          <SaveMappingAction analysis={analysis} settings={settings} />
        </Space>
        {!canPermission('supplier.read') ? (
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            你没有查看供应商的权限，不能指定供应商；只会使用通用映射。
          </Typography.Paragraph>
        ) : null}
        {file ? (
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
            已读取 {file.fileName}（{file.format === 'XLSX' ? 'Excel' : 'CSV'}）
          </Typography.Paragraph>
        ) : null}
        {problem ? <Alert style={{ marginTop: 8 }} type="error" showIcon role="alert" message={problem} /> : null}
      </Card>

      <Collapse
        size="small"
        items={[
          { key: 'settings', label: '识别设置（表头行、单位、默认箱规、列对应）', children: <PackingListSettings analysis={analysis} settings={settings} onChange={setSettings} disabled={busy} /> },
        ]}
        activeKey={panel}
        onChange={keys => setPanel(Array.isArray(keys) ? keys : [keys])}
      />

      {analysis?.fatal ? <Alert type="error" showIcon message={analysis.fatal} /> : null}
      {analysis && !analysis.fatal ? (
        <>
          <Typography.Paragraph style={{ margin: 0 }} data-testid="packing-summary">
            共 {analysis.summary.rows} 行：已匹配 {analysis.summary.matched}，候选 {analysis.summary.candidate}，未匹配 {analysis.summary.unmatched}，有问题 {analysis.summary.problems}；跳过{' '}
            {analysis.summary.skipped} 个合计或说明行；合计约 {analysis.summary.units} 件。
            {ready.total > 0 ? ` 现在：可装箱 ${ready.ready} 行，待选 SKU ${ready.needsSku} 行，忽略 ${ready.ignored} 行，有问题 ${ready.problems} 行。` : ''}
          </Typography.Paragraph>
          {analysis.notes.map(note => (
            <Alert key={note} type="warning" showIcon message={note} />
          ))}
          {analysis.missingFields.length === 0 && analysis.rows.length > 0 ? (
            <DecisionContext.Provider value={api}>
              <PagedGrid<PackingPreviewRow>
                gridId="inbound.packing-list"
                columns={columns}
                fetchPage={fetchPage}
                getRowId={row => String(row.line)}
                resetKey={String(round)}
                emptyState={{ kind: 'empty', domain: '装箱单行', prerequisite: '这份装箱单里没有读到商品行。' }}
                height={420}
                toolbarExtra={<Typography.Text type="secondary">{PAGE_SIZE_HINT}</Typography.Text>}
              />
            </DecisionContext.Provider>
          ) : null}
        </>
      ) : null}

      <Space wrap>
        <FormAction
          label="应用到箱内物品"
          guard={inboundGuard(undefined, { amazon: false, condition: { ok: !applyReason, reason: applyReason } })}
          title="把装箱单写入箱内物品（替换现有箱子）"
          description={
            <Alert
              type="warning"
              showIcon
              message={`将整体替换现有的 ${analysis?.existingBoxTypes ?? 0} 个箱型${ready.toRemember > 0 ? `，并记住 ${ready.toRemember} 个外部货号对应关系` : ''}`}
              description="写入只保存在我们这里，提交给亚马逊是单独的动作；写入后到“箱内物品”里核对数量与箱规。"
            />
          }
          confirmText="我已核对匹配结果，同意替换现有箱子"
          okText="应用"
          buttonProps={{ type: 'primary' }}
          onSubmit={apply}
          onDone={onApplied}
        />
      </Space>
    </Space>
  )
}
