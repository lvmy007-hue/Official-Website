# Amazon 公有应用上线清单

本项目按“公有第三方应用、多卖家授权、Amazon.com 美国站 FBA + Amazon Ads”设计。代码只在对应环境变量和 Amazon 审批完成后启用真实连接，不把未授权状态显示成已同步。

## 必须在 Amazon 侧完成

- SP-API 公有应用注册，并取得 Application ID、LWA Client ID、LWA Client Secret。
- SP-API 应用审核和所需角色审批；库存、订单、财务、FBA 入库和 Reports 按实际业务申请最小角色。
- Amazon Ads API 公有应用申请，使用独立的 Ads LWA Client ID/Secret；广告权限不从 Seller 授权继承。
- 将以下回调地址加入对应 Amazon 应用：
  - `https://dzanx.com/api/v1/sp-api/oauth/callback`
  - `https://dzanx.com/api/v1/ads/oauth/callback`
- 提供可公开访问的隐私政策、服务条款、安全说明、支持邮箱和数据删除联系渠道。本项目对应页面为 `/privacy`、`/terms`、`/security`、`/contact`。

## 部署前必须配置

复制 `.env.aliyun.example` 为阿里云部署环境的 `.env`，填写密钥、数据库、Redis、SP-API、Ads API 和 AWS SigV4 凭证。生产环境保持：

```text
APP_MODE=production
DEMO_MODE=false
MOCK_CONNECTOR=false
AMAZON_SP_API_APPROVED=true
AMAZON_ADS_API_APPROVED=true
```

审批未完成时应保持对应值为 `false`。此时授权按钮会明确返回审批状态，不会创建虚构的店铺、Campaign 或报表记录。

## 代码已经覆盖的授权后链路

1. 企业成员从 ERP 发起固定回调地址的 OAuth。
2. 服务端校验 state、租户、法律主体和回调地址。
3. LWA Refresh Token 使用 `TOKEN_ENCRYPTION_KEY` 加密后保存，前端不接触原文。
4. Worker 使用 SP-API SigV4 或 Ads API Profile Header 调用官方 API。
5. Inventory、Orders、Order Items、Finances、Inbound Plan/Shipment、Returns、Catalog/Listing Reports、Settlement Reports、Ads Profile/Campaign/Report/Metrics 写入租户隔离表。
6. 异步报表按创建、生成中、READY、FAILED 轮询；失败保留错误码和任务记录。

## 官方资料

- [SP-API 注册和公有应用](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/sp-api-registration-overview)
- [SP-API Onboarding / OAuth](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)
- [SP-API 连接方式](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api)
- [Ads API LWA 应用](https://advertising.amazon.com/API/docs/en-us/onboarding/create-lwa-app)
- [Ads API OAuth 授权](https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants)
- [Ads API 申请入口](https://advertising.amazon.com/en-ca/about-api)
