import { Alert, Form, InputNumber, Select, Switch } from 'antd'
import {
  PRICING_ACTIONS,
  PRICING_ACTION_LABEL,
  PRICING_SITUATIONS,
  PRICING_SITUATION_LABEL,
  SCENARIO_LIMITS,
  scenarioMatrixIssue,
  type PricingAction,
  type PricingSituation,
  type ScenarioMatrix,
} from '@nova/api-contracts'

// 定价规则的“情形 × 动作”矩阵编辑（P6-17，16 章第 3.2 节）：五种情形各选一个动作；打开后这条规则不再按上面的策略求价，
// 而是先判断商品所处的情形，再按该格的动作求目标价。目标价仍要经过单次调幅与最低价、最高价、最低利润率护栏：超出护栏的不会执行，会留下一条“被护栏拦截”的记录并写明原因。
// 这是 5 行的固定表单，不是数据列表，所以不用 PagedGrid；没有填的情形按“不调价”。

export interface MatrixFormValues {
  useMatrix: boolean
  matrixAction: Partial<Record<PricingSituation, PricingAction>>
  matrixOffset: Partial<Record<PricingSituation, number | null>>
  matrixBasePrice: number | null
}

export const BLANK_MATRIX_VALUES: MatrixFormValues = { useMatrix: false, matrixAction: {}, matrixOffset: {}, matrixBasePrice: null }

export function matrixValuesOf(matrix: ScenarioMatrix | null | undefined): MatrixFormValues {
  if (!matrix) return BLANK_MATRIX_VALUES
  const matrixAction: MatrixFormValues['matrixAction'] = {}
  const matrixOffset: MatrixFormValues['matrixOffset'] = {}
  for (const situation of PRICING_SITUATIONS) {
    const cell = matrix.cells[situation]
    if (!cell) continue
    matrixAction[situation] = cell.action
    if (cell.action === 'FOLLOW_OTHER') matrixOffset[situation] = cell.offset ?? 0
  }
  return { useMatrix: true, matrixAction, matrixOffset, matrixBasePrice: matrix.basePrice ?? null }
}

/** 表单值 → 提交给接口的矩阵；没打开返回 null（修改时表示取消矩阵，改回按策略求价）。 */
export function matrixOfValues(values: Partial<MatrixFormValues>): ScenarioMatrix | null {
  if (!values.useMatrix) return null
  const cells: ScenarioMatrix['cells'] = {}
  for (const situation of PRICING_SITUATIONS) {
    const action = values.matrixAction?.[situation] ?? 'NONE'
    cells[situation] = action === 'FOLLOW_OTHER' ? { action, offset: values.matrixOffset?.[situation] ?? 0 } : { action }
  }
  return { cells, basePrice: values.matrixBasePrice ?? null }
}

export const matrixIssueOf = (values: Partial<MatrixFormValues>): string | null => {
  const matrix = matrixOfValues(values)
  return matrix ? scenarioMatrixIssue(matrix) : null
}

export function ScenarioMatrixFields({ enabled, actions }: { enabled: boolean; actions: Partial<Record<PricingSituation, PricingAction>> | undefined }) {
  return (
    <div data-testid="scenario-matrix" style={{ marginBottom: 12 }}>
      <Form.Item label="按“情形 × 动作”矩阵定价" name="useMatrix" valuePropName="checked" extra="打开后，这条规则不再按上面的策略求价，而是按商品所处的情形选动作。">
        <Switch aria-label="按情形矩阵定价" />
      </Form.Item>
      {enabled ? (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="每个情形选一个动作；没选的按“不调价”。目标价超出最低价、最高价或最低利润率护栏时不会执行，系统会记一条“被护栏拦截”并写明原因。情形按从上到下的顺序判断，命中第一个就停。"
          />
          {PRICING_SITUATIONS.map(situation => (
            <div key={situation} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
              <div style={{ width: 210, paddingTop: 5 }}>{PRICING_SITUATION_LABEL[situation]}</div>
              <Form.Item name={['matrixAction', situation]} style={{ marginBottom: 0 }}>
                <Select
                  aria-label={`${PRICING_SITUATION_LABEL[situation]}的动作`}
                  placeholder={PRICING_ACTION_LABEL.NONE}
                  allowClear
                  style={{ width: 190 }}
                  options={PRICING_ACTIONS.map(value => ({ value, label: PRICING_ACTION_LABEL[value] }))}
                />
              </Form.Item>
              {actions?.[situation] === 'FOLLOW_OTHER' ? (
                <Form.Item name={['matrixOffset', situation]} style={{ marginBottom: 0 }}>
                  <InputNumber
                    aria-label={`${PRICING_SITUATION_LABEL[situation]}的加减额`}
                    addonBefore="加减（美元）"
                    min={-SCENARIO_LIMITS.offsetMax}
                    max={SCENARIO_LIMITS.offsetMax}
                    step={0.01}
                    style={{ width: 190 }}
                  />
                </Form.Item>
              ) : null}
            </div>
          ))}
          <Form.Item label="基础价（美元，可空：空则取近 30 天平均成交价）" name="matrixBasePrice" style={{ marginTop: 8 }}>
            <InputNumber aria-label="基础价" min={0.01} max={SCENARIO_LIMITS.basePriceMax} step={0.01} style={{ width: 200 }} />
          </Form.Item>
        </>
      ) : null}
    </div>
  )
}
