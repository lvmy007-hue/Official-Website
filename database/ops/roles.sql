-- 数据库连接账号（P1-16 / P1-25，12 章 12.8、12.9）。用 psql 以迁移账号（表的所有者）执行，可重复执行：
--
--   NOVA_APP_PASSWORD=... NOVA_SYSTEM_PASSWORD=... psql -v ON_ERROR_STOP=1 -h <主机> -U <迁移账号> -d <库名> -f database/ops/roles.sql -f database/ops/regrant.sql
--
-- docker compose 部署里由一次性服务 roles 自动执行（在数据库迁移之前）。密码只从环境变量读取，不要写进文件或提交到代码库。
--
-- 账号分工：
--   <迁移账号>   表的所有者，只用于 prisma migrate deploy 与运维，应用进程不得使用。
--   nova_app     接口服务与后台任务的租户连接：DATABASE_URL。
--                普通账号，行级安全对它生效；每个请求或任务先设置 app.tenant_id。
--   nova_system  系统连接：DATABASE_SYSTEM_URL。登录、授权回调、后台调度、平台运营使用，可绕过行级安全。
--                只放在需要它的进程里，网络上限定来源地址。
--
-- 语句超时是兜底：接口服务与后台任务每次访问时还会按自己的默认值设置事务级超时（QUERY_STATEMENT_TIMEOUT_MS、WORKER_STATEMENT_TIMEOUT_MS）。
-- 库侧的账号级设置保证即使应用代码遗漏，单条语句也不会无限占用连接。
--
-- 连接串在跨机部署时必须启用加密连接（sslmode=verify-full 或 require），见 12.9 第 2 条与 .env 里的 DB_REQUIRE_TLS。

\set ON_ERROR_STOP on
\getenv app_password NOVA_APP_PASSWORD
\getenv system_password NOVA_SYSTEM_PASSWORD
\if :{?app_password}
\else
  \set app_password ''
\endif
\if :{?system_password}
\else
  \set system_password ''
\endif

SELECT (length(:'app_password') >= 16 AND length(:'system_password') >= 16 AND :'app_password' <> :'system_password') AS passwords_ok \gset
\if :passwords_ok
\else
  \echo '错误：环境变量 NOVA_APP_PASSWORD 与 NOVA_SYSTEM_PASSWORD 必须设置，各不少于 16 个字符，且两者不能相同'
  SELECT 1/0;
\endif

-- 创建账号（已存在则只更新密码与属性，便于轮换密码）
SELECT format('CREATE ROLE nova_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') \gexec
SELECT format('CREATE ROLE nova_system LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'system_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') \gexec
SELECT format('ALTER ROLE nova_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') \gexec
SELECT format('ALTER ROLE nova_system LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'system_password') \gexec

-- 账号级超时（单条语句、事务里空闲）
ALTER ROLE nova_app SET statement_timeout = '30s';
ALTER ROLE nova_app SET idle_in_transaction_session_timeout = '120s';
ALTER ROLE nova_system SET statement_timeout = '300s';
ALTER ROLE nova_system SET idle_in_transaction_session_timeout = '120s';

-- 不允许应用账号在公共模式里建表
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
