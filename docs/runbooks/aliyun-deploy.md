# 阿里云 ECS 部署

建议 Ubuntu 22.04 LTS，最低 2 vCPU / 8 GB，正式运行建议 4 vCPU / 16 GB。安全组只开放受限 SSH、80 和 443，不开放 4000、5432、6432、6379：部署文件里除网关（`web`）外没有任何服务映射宿主机端口。

## 结构（P1-25）

```
互联网 → [宿主机 nginx / 负载均衡，终止 HTTPS] → web（网关，唯一对外端口）
web → api；api、worker → pgbouncer（连接池，事务池模式）→ postgres
api、worker → queue-redis（队列：不淘汰、持久化、密码） 与 cache-redis（缓存：淘汰最久未用、密码）
api、worker 共享持久卷 nova-aliyun-storage（本地文件存储）
```

- **数据库账号分三类**：迁移账号（`POSTGRES_USER`，表的所有者，只给迁移与运维用，不会出现在 api / worker 容器里）；`nova_app`（接口与后台任务的租户连接，受行级安全约束）；`nova_system`（系统连接：登录、授权回调、调度、分区维护）。后两个账号由一次性服务 `roles` 创建或更新密码，并补齐已有表的权限，同时设置账号级语句超时。
- **语句超时**：`nova_app` 30 秒、`nova_system` 300 秒（库侧兜底）；应用每次访问还按自己的默认值设置事务级超时（接口 30 秒、后台任务 120 秒，`QUERY_STATEMENT_TIMEOUT_MS` / `WORKER_STATEMENT_TIMEOUT_MS`）。超时的语句由数据库取消，接口返回 `QUERY_TIMEOUT`（504，可重试）。
- **慢查询**：数据库记录超过 1 秒的语句（`log_min_duration_statement=1000`）与等锁超过 1 秒的情况；应用层同时输出带耗时的 `slow_query` 告警（`SLOW_QUERY_MS`）。查看：`docker compose ... logs postgres`。
- **启动自检**：生产模式下，接口与后台任务在以下情况拒绝启动并给出中文原因——队列与缓存没有分开配置、任一 Redis 连接串不带密码、两个 Redis 指向同一实例、`DB_REQUIRE_TLS` / `REDIS_REQUIRE_TLS` 打开但连接串没有启用加密、数据库连接串写了 `sslaccept=accept_invalid_certs`、租户连接账号权限过大（超级用户、可绕过行级安全或是表的所有者）、缺少 `DATABASE_SYSTEM_URL`、`JWT_SECRET` / `TOKEN_ENCRYPTION_KEY` / `ENCRYPTION_MASTER_KEYS` / `STORAGE_SIGNING_KEY` 或连接串里的密码仍是示例文件里的占位值（`REPLACE_…`、`…change-me…`、`…dev_password`、`0123456789abcdef…`）或过于简单（P5-13；提示里只写变量名，不回显值）。**证书校验没有关闭选项。**

## 首次部署

复制 `.env.aliyun.example` 为 `.env.aliyun` 并设置权限 `chmod 600 .env.aliyun`，编辑：

- 五个密码：`POSTGRES_PASSWORD`、`NOVA_APP_PASSWORD`、`NOVA_SYSTEM_PASSWORD`、`QUEUE_REDIS_PASSWORD`、`CACHE_REDIS_PASSWORD`。各自独立、至少 16 个字符、只用字母和数字（它们会出现在连接串里，不能含 `@ : / ? #`）。缺任何一个，`docker compose` 会直接报错而不会用空密码启动。
- `JWT_SECRET` 至少 32 字符；`TOKEN_ENCRYPTION_KEY` 64 位十六进制（密钥分层与轮换见 [`encryption-keys.md`](encryption-keys.md)）；`STORAGE_SIGNING_KEY` 至少 32 字符，`STORAGE_PUBLIC_BASE_URL` 写对外域名下的 `/api/v1/storage/local`。
- `CORS_ORIGINS` 填 `https://erp.example.com` 这样的完整来源；`TRUST_PROXY` 写前面的代理层数（宿主机 nginx 再转发到网关容器写 2），**不得写 true**；填写首次管理员字段。
- 生产环境不要设置 `LOCAL_NO_AUTH`，也不要把本地 `LOCAL_DEV_*` 变量带入阿里云。

本地 `docker-compose.yml` 为了方便先进入 ERP，明确开启了 `APP_MODE=development` + `LOCAL_NO_AUTH=true`，并自动创建一个真实但为空业务数据的本地企业工作区；它只用于本机 UI/接口联调，不会生成订单、库存、广告或 FBA 假数据。本地结构与生产一致（双 Redis、连接池、最小权限账号、只暴露网关）。阿里云使用 `docker-compose.aliyun.yml`，保持生产 JWT、租户和权限校验。

接入 Amazon.com FBA 前还需完成 Amazon Developer Central / Seller Central 应用审批，并配置 `AMAZON_SP_APPLICATION_ID`、LWA Client ID/Secret、回调地址、`AMAZON_SP_API_ENDPOINT=https://sellingpartnerapi-na.amazon.com`、`AMAZON_SP_API_REGION=us-east-1`、AWS SigV4 的 `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY` 和 Amazon Ads 凭证。生产前端固定使用服务端 API；缺少外部授权时，页面只显示“未连接/不可用”并保留失败原因，不会把演示数据写成“已同步”。当前 Worker 已具备 LWA refresh-token 解密、Inventory、Orders、Order Items、Inbound Plan/Shipment、Finances、Returns、Catalog Reports、Settlement Reports、Orders Reports 以及 Amazon Ads Profile/Campaign/Report 的真实请求和归一化写入入口。

首次启动：

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml config --quiet`

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml up -d --build`

检查：

`docker compose --env-file .env.aliyun -f infrastructure/compose/docker-compose.aliyun.yml ps`

`curl -fsS http://127.0.0.1:8080/health` 和 `curl -fsS http://127.0.0.1:8080/api/v1/health`（端口按 `HTTP_PORT` 调整）。`/api/v1/health` 返回的 `checks.database`、`checks.redis` 都应为 `ok`。

启动顺序为 PostgreSQL → `roles`（创建账号并补齐权限）→ `migrate`（迁移账号直连数据库，首次管理员初始化）→ Redis、连接池 → API/Worker → 网关。首次登录成功后删除 `.env.aliyun` 中的 `BOOTSTRAP_CONFIRM` 与管理员密码字段，再执行 `up -d`。管理员账号必须先在个人资料里绑定多因素认证后才能继续使用。

## 从旧的单账号部署升级

旧版本 api / worker 直接使用迁移账号（`.env.aliyun` 里的 `DATABASE_URL`），Redis 无密码且只有一个。升级步骤（数据保留：数据库卷与队列 Redis 的数据卷沿用原名）：

1. 备份：`pg_dump` 数据库；备份存储卷 `nova-aliyun-storage` 与队列 Redis 卷 `nova-aliyun-redis`。
2. 按 `.env.aliyun.example` 补齐新变量（五个密码、`STORAGE_*`、`TRUST_PROXY`）。旧的 `DATABASE_URL`、`REDIS_URL` 不再使用，可以删除（新变量名是 `DATABASE_APP_URL` 等，默认自动拼装）。
3. `docker compose ... build`，然后 `docker compose ... up -d`。`roles` 会创建两个账号并**补齐已有表的权限**（可重复执行），`migrate` 再应用新迁移。
4. 队列 Redis 沿用原数据卷，原有 AOF 里未消费的任务保留；容器带上 `--requirepass` 后只能用密码连接。
5. 确认：`curl .../api/v1/health` 的 `database`、`redis` 为 `ok`；`docker compose ... logs api worker` 无“部署配置不合格”；旧的宿主机端口映射（5432、6379、4000）已不存在：`docker compose ... ps` 只有 `web` 有端口。
6. 旧的 `redis` 服务已拆为 `queue-redis` 与 `cache-redis`，`docker compose ... up -d --remove-orphans` 清理遗留容器。

## 密码轮换

- 数据库账号：改 `.env.aliyun` 里的 `NOVA_APP_PASSWORD` / `NOVA_SYSTEM_PASSWORD`，执行 `docker compose ... up -d --force-recreate roles pgbouncer api worker`（`roles` 用新密码更新账号，连接池与应用换新密码）。
- Redis：改密码后 `docker compose ... up -d --force-recreate queue-redis cache-redis api worker`。队列 Redis 的任务数据在持久卷里，不丢。

## 使用云数据库、云 Redis（跨机部署）

- 改 `DATABASE_APP_URL`、`DATABASE_SYSTEM_URL`、`DATABASE_OWNER_URL`，连接串带 `sslmode=verify-full`（或 `require`），并设 `DB_REQUIRE_TLS=true`；`roles.sql` 与 `regrant.sql` 在云数据库上用迁移账号手动执行一次：`NOVA_APP_PASSWORD=... NOVA_SYSTEM_PASSWORD=... psql -v ON_ERROR_STOP=1 -h <主机> -U <迁移账号> -d nova_erp -f database/ops/roles.sql -f database/ops/regrant.sql`。
- 云 Redis：`QUEUE_REDIS_URL`、`CACHE_REDIS_URL` 写 `rediss://:密码@主机:6380`，设 `REDIS_REQUIRE_TLS=true`；使用私有 CA 时把证书挂进容器并设 `REDIS_TLS_CA_FILE`。队列实例必须是“不淘汰、持久化”的实例，缓存实例是“淘汰最久未用”的实例，两者不能是同一个。
- 随后可以从 compose 里去掉本地的 `postgres`、`pgbouncer`、`queue-redis`、`cache-redis` 服务（或用 `--scale` 置为 0）。

## 资源与容量

- 容器内存上限：接口 1.5 GB（Node 堆 1 GB）、后台任务 2 GB（堆 1.5 GB，进程内存守卫在 1.7 GB 优雅退出并由 `restart: unless-stopped` 拉起）、队列 Redis 768 MB（`maxmemory` 512 MB，满了拒绝写入而不是丢任务）、缓存 Redis 384 MB（`maxmemory` 256 MB，满了淘汰）。按机器规格用 `API_MEM_LIMIT`、`WORKER_MEM_LIMIT` 等变量调整，原则是“堆上限 + 余量 ≤ 容器上限”。
- 连接池：每个“库 + 账号”最多 20 条真实连接（`PGB_DEFAULT_POOL_SIZE`），客户端上限 500（`PGB_MAX_CLIENT_CONN`），排队超过 30 秒返回错误；每个应用进程默认 10 条连接（`DB_POOL_SIZE`）。迁移与运维直连数据库，不占连接池。

## 其他

域名通过 DNS A 记录指向 ECS。正式环境建议使用阿里云证书/ALB/CLB 终止 HTTPS，再把请求转发到 Compose 的 `web:80`（`HTTP_PORT=127.0.0.1:8080` 时转发到该地址）。

上线后的入口约定：`https://你的域名/` 为官网，`https://你的域名/login` 为 ERP 登录，`https://你的域名/app/overview` 为登录后的运营工作台；Nginx 已配置 SPA fallback，官网和 ERP 的前端路由均由同一个 Web 容器托管。部署完成后至少检查官网首页、ERP 登录页、`/health` 和 `/api/v1/health`。

更新前执行 `git pull --ff-only`、`docker compose ... build`、`docker compose ... run --rm migrate`，再执行 `up -d --no-deps api worker web`。生产模式会拒绝 `DEMO_MODE=true` 和 `MOCK_CONNECTOR=true`。

**备份清单**：PostgreSQL 数据库；存储卷 `nova-aliyun-storage`（本地驱动的全部文件）；队列 Redis 卷 `nova-aliyun-redis`（未消费的任务，可选，丢失后由调度重新生成同步任务）；`.env.aliyun`（含主密钥，必须与数据库备份分开保存——只有数据库备份没有主密钥，加密的令牌无法恢复）。缓存 Redis 不需要备份。备份与恢复演练属于部署专项。
