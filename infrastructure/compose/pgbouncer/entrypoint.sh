#!/bin/sh
# 根据环境变量生成连接池配置并启动。密码只来自环境变量，不写进镜像。
#   PGB_DB_HOST / PGB_DB_PORT / PGB_DB_NAME   后端数据库
#   PGB_USERS                                 允许连接的账号，空格分隔的“账号:密码”，例如 "nova_app:xxx nova_system:yyy"（密码只能是字母数字与 _-.）
#   PGB_DEFAULT_POOL_SIZE                     每个“库 + 账号”最多保持的真实连接数（默认 20）
#   PGB_MAX_CLIENT_CONN                       最多接受的客户端连接数（默认 500）
#   PGB_QUERY_WAIT_TIMEOUT                    客户端排队等连接的最长秒数（默认 30）
#   PGB_SERVER_TLS_SSLMODE                    连接数据库的加密模式（默认 prefer；数据库在另一台机器上时用 verify-full 并提供 PGB_SERVER_TLS_CA_FILE）
set -eu

: "${PGB_DB_HOST:?必须设置 PGB_DB_HOST}"
: "${PGB_DB_NAME:?必须设置 PGB_DB_NAME}"
: "${PGB_USERS:?必须设置 PGB_USERS}"

conf=/tmp/pgbouncer.ini
users=/tmp/userlist.txt
: > "$users"
chmod 600 "$users"
for pair in $PGB_USERS; do
  name="${pair%%:*}"
  pass="${pair#*:}"
  case "$name$pass" in
    *[!A-Za-z0-9_.-]*) echo "PGB_USERS：账号与密码只能包含字母、数字与 _ - ." >&2; exit 1 ;;
  esac
  [ -n "$name" ] && [ -n "$pass" ] && [ "$name" != "$pair" ] || { echo "PGB_USERS 格式应为 账号:密码" >&2; exit 1; }
  printf '"%s" "%s"\n' "$name" "$pass" >> "$users"
done

cat > "$conf" <<EOF
[databases]
${PGB_DB_NAME} = host=${PGB_DB_HOST} port=${PGB_DB_PORT:-5432} dbname=${PGB_DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${users}
pool_mode = transaction
default_pool_size = ${PGB_DEFAULT_POOL_SIZE:-20}
reserve_pool_size = 5
reserve_pool_timeout = 3
max_client_conn = ${PGB_MAX_CLIENT_CONN:-500}
query_wait_timeout = ${PGB_QUERY_WAIT_TIMEOUT:-30}
server_idle_timeout = 600
ignore_startup_parameters = extra_float_digits
server_tls_sslmode = ${PGB_SERVER_TLS_SSLMODE:-prefer}
${PGB_SERVER_TLS_CA_FILE:+server_tls_ca_file = ${PGB_SERVER_TLS_CA_FILE}}
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
EOF

exec pgbouncer "$conf"
