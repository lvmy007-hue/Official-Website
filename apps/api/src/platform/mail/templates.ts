// 邮件模板（P1-19，14.10）：邀请、新设备登录提醒、经营日报、告警。
// 模板是纯函数，不依赖发送通道，便于测试。正文不放任何令牌之外的敏感信息；邀请链接本身就是一次性令牌。

export type MailTemplate =
  | { kind: 'invitation'; companyName: string; link: string; expiresAt: Date; inviterName?: string }
  | { kind: 'new-device'; displayName: string; device: string; ipMasked: string | null; signedInAt: Date }
  | { kind: 'daily-report'; companyName: string; reportDate: string; link: string }
  | { kind: 'alert'; companyName: string; title: string; detail: string; link: string }

export interface RenderedMail {
  subject: string
  text: string
  html: string
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
const when = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

function wrap(title: string, lines: string[], action?: { label: string; link: string }): RenderedMail {
  const text = [...lines, ...(action ? ['', `${action.label}：${action.link}`] : []), '', '—— NOVA ERP'].join('\n')
  const body = lines.map(line => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('')
  const button = action ? `<p><a href="${escapeHtml(action.link)}" style="color:#2b57cf">${escapeHtml(action.label)}</a></p>` : ''
  return { subject: title, text, html: `<div style="font-family:sans-serif;font-size:14px;color:#1f2937">${body}${button}<p style="color:#6b7280">NOVA ERP</p></div>` }
}

export function renderMail(template: MailTemplate): RenderedMail {
  switch (template.kind) {
    case 'invitation':
      return wrap(
        `邀请你加入 ${template.companyName} 的 NOVA ERP`,
        [
          template.inviterName ? `${template.inviterName} 邀请你加入 ${template.companyName}。` : `你被邀请加入 ${template.companyName}。`,
          `链接只能使用一次，有效期至 ${when(template.expiresAt)}。请在打开后设置密码并开启多因素认证。`,
          '如果这不是你预期的邮件，请忽略它，不要转发链接。',
        ],
        { label: '接受邀请', link: template.link },
      )
    case 'new-device':
      return wrap('新设备登录提醒', [
        `${template.displayName}，你的账号刚刚在新的设备上登录。`,
        `设备：${template.device}；来源地址：${template.ipMasked ?? '未知'}；时间：${when(template.signedInAt)}。`,
        '如果不是你本人操作，请立即修改密码，并在“个人账号”页退出其他登录。',
      ])
    case 'daily-report':
      return wrap(`${template.companyName} ${template.reportDate} 经营日报`, [`${template.companyName} 的经营日报已生成。`], { label: '查看日报', link: template.link })
    case 'alert':
      return wrap(`${template.companyName} 告警：${template.title}`, [template.title, template.detail], { label: '查看详情', link: template.link })
  }
}
