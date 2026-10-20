# 公开站缺口索引（V10 批次 A）

只记录编码位置。公司法律全称、对外邮箱、注册地址、存储地区、ICP 和公安备案号在仓库中不存在，禁止写入页面。

| 项 | 现状 | 状态 | 处理文件 | 优先级 | 验收 |
| --- | --- | --- | --- | --- | --- |
| 首页 12 个板块 | 原首页为 4 张模块卡加深色条 | 已改 | `src/ProductionWebsite.tsx` | P0 | 匿名打开 `/`，能看到痛点、六项能力、店铺表、退款矩阵、财务、广告建设中、流程、安全、场景、FAQ、底部预约 |
| 导航 | 原导航无下拉、无登录/演示分工 | 已改 | `src/ProductionWebsite.tsx` | P0 | 桌面下拉可点；390 宽打开菜单，Esc 关闭；链接进入已有页面 |
| 价格 | 无公开标价 | 已改 | `src/ProductDetailPages.tsx` | P0 | `/pricing` 只说明定制依据，不出现金额 |
| 页脚法律链接 | 原文是不可点击的 Privacy · Terms · Security | 已改 | `src/ProductionWebsite.tsx` | P0 | `/privacy` `/terms` `/security` 可打开，并标明草案/未证实项 |
| 公司主体与备案 | 配置中没有法律全称、邮箱、备案号 | 待核实 | 页脚不展示 | P0 | 页面不出现“待填写”或编造备案号；本文件即为发布阻断 |
| 广告表述 | 管理页在 Ads 未配置时直接报错 | 已改 | `src/public-site-content.ts` | P0 | 首页出现“功能建设中 / 待完成平台授权”，指标为“—” |
| 假新闻 | `/news` 写了未经核对的 2026.08–10 动态 | 已改 | `src/ProductionWebsite.tsx` | P0 | 页面写明暂无已核对发布记录 |
| 未知地址进工作台 | `/` 之外的未知路径会进入 ERP | 已改 | `src/App.tsx` `vite.config.ts` `infrastructure/aliyun/nginx.conf` | P0 | `/no-such-page` 返回 404；`/product` 刷新仍是产品页 |
| 产品深页 | 已有店铺、订单、退货、财务、广告、权限六页 | 已改 | `src/ProductDetailPages.tsx` | P0 | 四个业务页版式不同；广告页保持未授权 |
| 广告方案页 | 已有 `/solutions/advertising` | 已改 | `src/ProductDetailPages.tsx` | P0 | 含指标定义、空账户表、报表流程和 5 个问题 |
| 帮助中心、英文 | 无与界面一致的教程，无英文页 | 缺失 | 未挂菜单 | P1 | 导航不出现 `/help`、`/en` |
| 联系表单 | 已增加电话、店铺档位、隐私勾选和蜜罐 | 已改 | `src/ProductionWebsite.tsx` `apps/api/src/api.service.ts` | P0 | 字段写入咨询留言；运营后台筛选仍未做 |
| SEO | 首页 title、canonical、sitemap、robots 已加；英文 hreflang 无页面 | 已改 | `index.html` `public/` | P0 | 查看首页标题；不生成英文备用链接 |
