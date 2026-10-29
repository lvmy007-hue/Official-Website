import { useState } from 'react'
import { App, Segmented } from 'antd'
import { DENSITIES, DENSITY_HINT, DENSITY_LABEL, type Density } from '@nova/api-contracts'
import { describeError } from '../../query/errors'
import { useShellPrefs } from '../../shell/shell-prefs'
import { InfoCard } from './profile-parts'

// 界面密度（P6-01，15 章第 3 节）：紧凑（表格行高 36）或标准（40），存在个人偏好里，换设备也在；Ant Design 与 AG Grid 两套主题同时响应。
// 内部访问与平台支持访问没有个人账号，只读并写明原因。

export function DensityCard({ available }: { available: boolean }) {
  const { message } = App.useApp()
  const { ready, loading, failed, density, save } = useShellPrefs()
  const [saving, setSaving] = useState(false)
  if (!available) return <InfoCard id="density" name="界面密度" value="标准" readonlyBy="内部访问与平台支持访问没有个人账号，不能保存个人偏好。" />
  const change = async (next: Density) => {
    if (next === density) return
    setSaving(true)
    try {
      await save(() => ({ density: next }))
      void message.success(`已切换为${DENSITY_LABEL[next]}密度`)
    } catch (error) {
      void message.error(describeError(error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <InfoCard
      id="density"
      name="界面密度"
      value={density ? DENSITY_LABEL[density] : loading ? '读取中…' : failed ? '暂时读不到' : '—'}
      note={density ? DENSITY_HINT[density] : '表格行高：紧凑 36 像素，标准 40 像素。'}
      action={
        <Segmented
          aria-label="界面密度"
          value={density}
          disabled={!ready || saving}
          options={DENSITIES.map(item => ({ value: item, label: DENSITY_LABEL[item] }))}
          onChange={value => void change(value as Density)}
        />
      }
    />
  )
}
