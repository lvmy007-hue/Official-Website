import { useMemo } from 'react'
import { Button, Tag } from 'antd'
import { buildRuleCatalog, describeConditions, validateConditions, type RuleMetric, type RuleTemplate } from '@nova/api-contracts'
import { cloneConditions } from './condition-model'
import './config.css'

// 模板选择器（P6-07，15 章 5.5）：系统模板与自定义模板分开显示，每张卡片写名称、一句话条件、适用维度，点“使用”把条件填进构造器。
// “使用”交出的是模板的副本，构造器里怎么改都不会动到模板；模板里有当前不能用的指标时，不静默丢条件，按钮置灰并说明原因。

export interface TemplatePickerProps {
  templates: readonly RuleTemplate[]
  metrics: readonly RuleMetric[]
  onUse: (template: RuleTemplate) => void
  disabled?: boolean
}

const SECTIONS = [
  { source: 'SYSTEM', title: '系统模板', empty: '尚无系统模板' },
  { source: 'CUSTOM', title: '自定义模板', empty: '尚无自定义模板' },
] as const

export function TemplatePicker({ templates, metrics, onUse, disabled }: TemplatePickerProps) {
  const catalog = useMemo(() => buildRuleCatalog(metrics), [metrics])
  return (
    <div className="erp-tpl-picker">
      {SECTIONS.map(section => {
        const list = templates.filter(template => template.source === section.source)
        const groups = [...new Set(list.map(template => template.group))]
        return (
          <section key={section.source} className="erp-tpl-section" aria-label={section.title}>
            <h4 className="erp-tpl-title">
              {section.title} <span className="erp-cond-hint">{list.length}</span>
            </h4>
            {list.length === 0 ? <p className="erp-cond-note">{section.empty}</p> : null}
            {groups.map(group => (
              <div key={group} className="erp-tpl-group">
                <div className="erp-tpl-group-name">{group}</div>
                <div className="erp-tpl-cards">
                  {list
                    .filter(template => template.group === group)
                    .map(template => {
                      const problem = validateConditions(template.conditions, catalog)[0]
                      return (
                        <article key={template.id} className="erp-tpl-card" aria-label={template.name}>
                          <div className="erp-tpl-card-head">
                            <strong>{template.name}</strong>
                            <Tag bordered={false}>{template.dimension}</Tag>
                          </div>
                          <p className="erp-tpl-summary">{describeConditions(template.conditions, catalog)}</p>
                          {problem ? <p className="erp-cond-issues">暂时不能使用：{problem.message}</p> : null}
                          <Button
                            size="small"
                            disabled={disabled || problem !== undefined}
                            onClick={() => onUse({ ...template, conditions: cloneConditions(template.conditions) })}
                            aria-label={`使用模板：${template.name}`}
                          >
                            使用
                          </Button>
                        </article>
                      )
                    })}
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
