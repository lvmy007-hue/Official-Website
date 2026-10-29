import { useState } from 'react'
import { Button, Modal, Timeline } from 'antd'
import { ALERT_SEVERITY_LABEL, type AlertRuleVersionView, type AlertRuleView } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { paramLines, scopeText, type ScopeNames } from './alert-rules-ui'

// 规则版本记录（P5-01）：每次改动一个版本，列出当时的阈值、严重度、冷却、启停与范围。
// 更早生成的版本（P5-01 之前）只留存了阈值，其余项写“当时未留存”，不拿现在的值顶替。

const NOT_KEPT = '当时未留存'

function VersionBody({ rule, version, names }: { rule: AlertRuleView; version: AlertRuleVersionView; names: ScopeNames }) {
  const lines = paramLines(rule.type, version.params)
  return (
    <div>
      <div>
        <strong>第 {version.versionNo} 版</strong>
        {version.versionNo === rule.currentVersion ? '（当前）' : ''} · {version.changedByName} · {formatDateTime(version.createdAt)}
      </div>
      <div>变更原因：{version.changeReason}</div>
      <div>阈值：{lines.length > 0 ? lines.map(line => `${line.label} ${line.value}`).join('；') : <Muted>没有可调的阈值</Muted>}</div>
      <div>
        严重度 {version.severity ? ALERT_SEVERITY_LABEL[version.severity] : NOT_KEPT}；冷却 {version.cooldownMinutes === null ? NOT_KEPT : `${version.cooldownMinutes} 分钟`}；
        {version.enabled === null ? NOT_KEPT : version.enabled ? '启用' : '已关闭'}
      </div>
      <div>范围：{version.scope ? scopeText(version.scope, names) : NOT_KEPT}</div>
    </div>
  )
}

export function VersionsAction({ rule, names }: { rule: AlertRuleView; names: ScopeNames }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        版本记录
      </Button>
      <Modal open={open} title={`规则版本：${rule.name}`} footer={null} onCancel={() => setOpen(false)} width={720}>
        <Timeline items={rule.versions.map(version => ({ key: version.versionNo, children: <VersionBody rule={rule} version={version} names={names} /> }))} />
        {rule.currentVersion > rule.versions.length ? <Muted>只显示最近 {rule.versions.length} 个版本</Muted> : null}
      </Modal>
    </>
  )
}
