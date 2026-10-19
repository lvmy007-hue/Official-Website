# NOVA ERP 全栈运行说明

这是根据历史会话重新搭建的可运行基线：浅色 ERP 前端、NestJS API、Prisma PostgreSQL、Redis/BullMQ Worker、登录/刷新会话、租户权限边界，以及阿里云 ECS Docker Compose 部署。

官网入口：生产模式访问 `/`，本地预览可访问 `/site`。官网包含产品能力、业务链路、安全与治理、阿里云部署架构和内部部署需求表单；ERP 入口为 `/login`，登录后进入 `/app/overview`。本地预览为了方便团队直接验收，根路径仍会直达 ERP 工作台；生产构建不会绕过登录。

本地预览：`pnpm install` 后执行 `pnpm dev`，打开 `http://127.0.0.1:5173/login`。默认是本地示例模式，输入任意非空邮箱和密码即可进入预览工作台；生产模式不会接受这种本地登录。

本地全栈：`docker compose -f infrastructure/compose/docker-compose.yml up --build`。

阿里云部署：复制 `.env.aliyun.example` 为 `.env.aliyun`，修改数据库密码、JWT_SECRET、TOKEN_ENCRYPTION_KEY、域名和首个管理员，然后执行：

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml up -d --build`

详细步骤见 [`docs/runbooks/aliyun-deploy.md`](docs/runbooks/aliyun-deploy.md)。正式环境只开放 80/443 和受限 SSH，不开放 PostgreSQL、Redis 或 API 端口。

Amazon SP-API / Ads API 的应用审批、AWS SigV4 请求签名、各数据域 importer、对象存储签名下载、邮件通知、HTTPS、WAF、备份恢复和真实浏览器验收仍必须在部署环境完成，不能以示例数据替代。当前已实现 OAuth state 校验、LWA authorization-code exchange、Refresh Token AES-256-GCM 加密保存、报表任务和同步重试；Worker 对未完成的 Amazon connector 会 fail-closed，不伪造成功。美国站 SP-API 使用 `https://sellingpartnerapi-na.amazon.com` / `us-east-1`；FBA 页面和 API 已按 Catalog、Listings、Inventory、Inbound、Orders、Finances、Reports、Returns、Ads 数据域拆分。
