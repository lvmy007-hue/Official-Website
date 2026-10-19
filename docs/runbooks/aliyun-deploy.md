# 阿里云 ECS 部署

建议 Ubuntu 22.04 LTS，最低 2 vCPU / 8 GB，正式运行建议 4 vCPU / 16 GB。安全组只开放受限 SSH、80 和 443，不开放 4000、5432、6379。

复制 `.env.aliyun.example` 为 `.env.aliyun` 并设置权限 `chmod 600 .env.aliyun`。编辑变量：`POSTGRES_PASSWORD` 必须和 `DATABASE_URL` 中一致；`JWT_SECRET` 至少 32 字符；`TOKEN_ENCRYPTION_KEY` 至少 64 位十六进制；`CORS_ORIGINS` 填 `https://erp.example.com` 这样的完整来源；填写首次管理员字段。生产环境不要设置 `LOCAL_NO_AUTH`，也不要把本地 `LOCAL_DEV_*` 变量带入阿里云。

本地 `docker-compose.yml` 为了方便先进入 ERP，明确开启了 `APP_MODE=development` + `LOCAL_NO_AUTH=true`，并自动创建一个真实但为空业务数据的本地企业工作区；它只用于本机 UI/接口联调，不会生成订单、库存、广告或 FBA 假数据。阿里云使用 `docker-compose.aliyun.yml`，保持生产 JWT、租户和权限校验。

接入 Amazon.com FBA 前还需完成 Amazon Developer Central / Seller Central 应用审批，并配置 `AMAZON_SP_APPLICATION_ID`、LWA Client ID/Secret、回调地址、`AMAZON_SP_API_ENDPOINT=https://sellingpartnerapi-na.amazon.com`、`AMAZON_SP_API_REGION=us-east-1`、AWS SigV4 的 `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY` 和 Amazon Ads 凭证。生产前端固定使用服务端 API；缺少外部授权时，页面只显示“未连接/不可用”并保留失败原因，不会把演示数据写成“已同步”。当前 Worker 已具备 LWA refresh-token 解密、Inventory/Orders/Reports 的真实请求入口；Inbound、Finances、Returns、Catalog 等数据域仍需按官方 schema 完成归一化 importer 后才能在生产打开。

首次启动：

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml config --quiet`

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml up -d --build`

检查：

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml ps`

`curl -fsS http://127.0.0.1/health` 和 `curl -fsS http://127.0.0.1/api/v1/health`。

启动顺序为 PostgreSQL/Redis 健康检查、迁移、首次管理员初始化、API/Worker 和 Nginx。首次登录成功后删除 `.env.aliyun` 中的 `BOOTSTRAP_CONFIRM` 与管理员密码字段，再执行 `up -d`。

域名通过 DNS A 记录指向 ECS。正式环境建议使用阿里云证书/ALB/CLB 终止 HTTPS，再把请求转发到 Compose 的 `web:80`。如果使用 RDS PostgreSQL 和云 Redis，把 `DATABASE_URL`、`REDIS_URL` 改为内网地址，并移除本地数据库服务。

上线后的入口约定：`https://你的域名/` 为官网，`https://你的域名/login` 为 ERP 登录，`https://你的域名/app/overview` 为登录后的运营工作台；Nginx 已配置 SPA fallback，官网和 ERP 的前端路由均由同一个 Web 容器托管。部署完成后至少检查官网首页、ERP 登录页、`/health` 和 `/api/v1/health`。

更新前执行 `git pull --ff-only`、`docker compose ... build`、`docker compose ... run --rm migrate`，再执行 `up -d --no-deps api worker web`。生产模式会拒绝 `DEMO_MODE=true` 和 `MOCK_CONNECTOR=true`。
