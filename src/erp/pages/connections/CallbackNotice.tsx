import { Alert } from 'antd'

// 授权回调结果（P5-04）：亚马逊授权完成后跳回连接中心，地址里带 provider、status、code；这里把它翻成人话。
const CODE_TEXT: Record<string, string> = {
  OAUTH_SELLER_MISMATCH: '重新授权选择的卖家账号与原连接不是同一个，没有更新。请用原来的卖家账号授权；要连接另一个卖家账号，请使用“授权卖家接口”新建连接。',
  OAUTH_CALLBACK_DENIED: '你在亚马逊页面上拒绝了授权，连接没有变化。',
  ADS_OAUTH_DENIED: '你在亚马逊页面上拒绝了授权，连接没有变化。',
  OAUTH_STATE_INVALID: '授权链接已使用或已过期，请重新发起授权。',
  ADS_OAUTH_STATE_INVALID: '授权链接已使用或已过期，请重新发起授权。',
  LWA_TOKEN_EXCHANGE_FAILED: '亚马逊没有签发令牌，请稍后重试。',
  ADS_LWA_TOKEN_EXCHANGE_FAILED: '亚马逊没有签发令牌，请稍后重试。',
}

export function CallbackNotice({ search }: { search: { provider?: unknown; status?: unknown; code?: unknown } }) {
  const provider = search.provider === 'ads' ? '广告接口' : search.provider === 'sp-api' ? '卖家接口' : null
  if (!provider) return null
  if (search.status === 'connected') {
    return <Alert type="success" showIcon closable style={{ marginBottom: 12 }} message={`${provider}授权成功`} description="已自动提交一次健康检查，结果稍后出现在对应的连接上。" />
  }
  if (search.status !== 'error') return null
  const code = typeof search.code === 'string' ? search.code : ''
  return (
    <Alert
      type="error"
      showIcon
      closable
      style={{ marginBottom: 12 }}
      message={`${provider}授权没有完成`}
      description={(CODE_TEXT[code] ?? '授权过程中出现问题，请稍后重试；仍不行请联系管理员。') + (code ? `（错误码 ${code}）` : '')}
    />
  )
}
