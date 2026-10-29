# 连接池中间件（P1-25，12.4 后端第 6 条）：接口服务与后台任务的数据库连接先到这里，由它复用少量真实连接。
# 事务池模式：每个事务临时借一条真实连接，事务结束即归还。本项目的租户变量、语句超时都是事务级设置（set_config(..., true)），
# 在这种模式下不会泄漏给其他使用者；应用的连接串必须带 pgbouncer=true（关闭预备语句缓存）。数据库迁移与运维直连数据库，不经过它。
FROM alpine:3.20
RUN apk add --no-cache pgbouncer \
  && (id pgbouncer >/dev/null 2>&1 || adduser -S -D -H -s /sbin/nologin pgbouncer)
COPY entrypoint.sh /entrypoint.sh
# 在 Windows 上检出的脚本可能是 CRLF 换行，去掉回车避免容器里无法执行
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
USER pgbouncer
EXPOSE 6432
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 CMD nc -z 127.0.0.1 6432 || exit 1
ENTRYPOINT ["/entrypoint.sh"]
