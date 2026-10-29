import { Alert, Button, Modal, Typography } from 'antd'
import { formatDateTime } from '../format'
import type { InvitationDelivery } from './platform-queries'

// 邀请交付结果（P1-19，14.10）：邮件通道未配置时，链接只在这一次响应里出现，由平台人员复制后通过安全渠道交给企业管理员。
// 链接一次性、72 小时有效、服务端只存哈希——关闭窗口后无法再次查看，需要时重发邀请。

export function InvitationDialog({ delivery, tenantName, onClose }: { delivery: InvitationDelivery | null; tenantName: string; onClose: () => void }) {
  return (
    <Modal
      open={Boolean(delivery)}
      title="邀请已生成"
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          我已保存，关闭
        </Button>
      }
      maskClosable={false}
      destroyOnClose
    >
      {delivery ? (
        delivery.emailed ? (
          <Alert type="success" showIcon message={`邀请邮件已发送至 ${delivery.email}`} description={`有效期至 ${formatDateTime(delivery.expiresAt)}，只能使用一次。`} />
        ) : (
          <div>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="邮件通道尚未配置，请复制链接并通过安全渠道交给企业管理员"
              description={`受邀人：${delivery.email}（${tenantName}）。链接只显示这一次，72 小时内有效，只能使用一次；丢失后请在租户详情里重发邀请。`}
            />
            <Typography.Paragraph copyable={{ text: delivery.link ?? '' }} code style={{ wordBreak: 'break-all', marginBottom: 4 }}>
              {delivery.link}
            </Typography.Paragraph>
            <Typography.Text type="secondary">有效期至 {formatDateTime(delivery.expiresAt)}</Typography.Text>
          </div>
        )
      ) : null}
    </Modal>
  )
}
