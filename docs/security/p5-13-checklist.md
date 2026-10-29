# P5-13 安全核查报告

依据：第 12 章 §12.9 第 13 项、第 11 章 §11.2。核查范围：越权、注入、跨站脚本、跨站请求伪造、敏感信息泄露，外加服务端请求伪造与部署配置两项（评审中发现与前五项直接相关）。

本报告只写“已经用代码和测试证明了什么”和“没有证明什么”。没有做过真实渗透测试，也没有在真实浏览器里复查响应头；这两项在第三方渗透测试与部署验收时补做（材料见 `pentest/README.md`）。

## 一、核查结论一览

| 类别 | 结论 | 主要证据 |
| --- | --- | --- |
| 越权（水平、垂直、跨租户） | 已核查，未发现未登记的开放接口 | `apps/api/src/access-control.test.ts`（全部接口按“无凭证 401、无权限 403”逐条扫描）；`apps/api/src/testing/security-sweep.db.test.ts`（真实数据库、两个企业、全部无参数读接口、未知编号与注入值探测）；`cross-tenant.db.test.ts` 与行级安全测试 |
| 注入（数据库、命令、表达式） | 已核查，发现并堵住 1 处 | 全局查询参数形状守卫（`platform/query-shape.ts`）；`scripts/check-security.mjs` 规则 S1、S6；扫描测试里的 12 个参数 × 注入值模糊测试 |
| 跨站脚本 | 已核查，发现并堵住 2 类 | 图表提示框转义（`chart-utils.ts` 的 `escapeHtml`）；链接与新窗口协议校验（`src/erp/security/safe-url.ts`）；网关内容安全策略 |
| 跨站请求伪造 | 已核查，无需改动 | 访问令牌只走请求头，不依赖 Cookie；刷新令牌 Cookie 为 HttpOnly、SameSite=Strict、限定路径，且刷新接口校验来源；`apps/api/src/security.test.ts` |
| 敏感信息泄露 | 已核查，发现并堵住 1 类 | 全路由响应键名与植入值扫描；日志去敏；生产启动拒绝示例密钥（`packages/crypto/src/secret-config.ts`） |
| 服务端请求伪造 | 已核查，发现并堵住 1 类 | 出站地址校验（`apps/worker/src/connectors/remote-url.ts`）；规则 S8 要求新增出站请求先过校验 |
| 部署配置 | 已核查，发现 1 处 | 网关内容安全策略的图片来源（见发现 F8）；其余见下文 |

## 二、发现与处置

| 编号 | 问题 | 影响 | 处置 | 验证 |
| --- | --- | --- | --- | --- |
| F1 | 查询参数 `?q[$ne]=1` 被框架解析成对象，直接当字符串使用的旧接口会把对象交给数据库查询层 | 采购单、联系记录、库存流水等接口返回 500，或筛选语义被改变 | 入口统一拒绝非字符串的查询参数（400）；前端只发字符串，不受影响 | 扫描测试曾复现；`security.test.ts`、`query-shape.test.ts` |
| F2 | 登录时账号不存在会跳过口令哈希比较 | 靠响应耗时可以枚举哪些邮箱已注册 | 无论账号是否存在、是否可登录，都做一次同成本的哈希比较（`modules/auth/password-check.ts`） | `password-check.test.ts` 断言各条路径都发生比较 |
| F3 | 4 处图表提示框把商品或词条名称直接拼进 HTML | 名称来自亚马逊数据或用户输入，含标签时会在提示框里执行 | 统一转义；规则 S10 阻止新增未转义的拼接 | `src/erp/security/chart-tooltip-xss.test.ts` |
| F4 | 多处 `window.open` 与 `href` 直接使用接口返回的地址 | 地址若是 `javascript:` 等协议会在点击时执行脚本；新窗口缺 `noopener` | 统一经 `safeHttpUrl` / `openSignedUrl`，只放行 http、https 与站内相对路径，并带 `noopener,noreferrer`；规则 S3、S4 | `safe-url.test.ts`、`my-pages.test.tsx` |
| F5 | 登录页登录后按 `redirect` 参数跳转，未限定目标 | 钓鱼链接可在登录后跳到外站（开放重定向） | 只允许 `/app` 及其子路径（`safeRedirectPath`） | `safe-url.test.ts` |
| F6 | 后台任务下载报告、标签、上传图片时直接请求接口返回的地址 | 返回地址被篡改或上游异常时，可能请求内网或元数据地址 | 请求前校验：只允许 https、无账号口令、不是回环、私网、链路本地、元数据与保留地址（含 IPv6 与 IPv4 映射写法） | `remote-url.test.ts`；规则 S8 |
| F7 | 生产启动只检查 JWT 密钥长度，示例文件里的占位值（`REPLACE_…`、`local-development-secret-change-me-…`）与开发主密钥（`0123456789abcdef…`）都能通过 | 示例值公开，原样带进生产等于没有设密码：可伪造登录令牌、解开已加密的授权数据 | 启动时拒绝示例值与过于简单的值，覆盖 JWT、签名密钥、主密钥与数据库、队列、缓存连接串里的密码；接口与后台任务都生效，提示里只写变量名 | `packages/crypto/src/secret-config.test.ts` |
| F8 | 网关内容安全策略的 `img-src` 只有 `'self' data: blob:` | 商品主图来自亚马逊图片域名，生产环境会被浏览器拦截，商品图全部不显示 | 只增加三个亚马逊图片域名（`*.media-amazon.com`、`*.ssl-images-amazon.com`、`*.images-amazon.com`），不放开任意 https | `src/workspace-headers.test.ts`；真实浏览器里的显示待部署验收 |

## 三、逐项核查记录

### 3.1 越权

- 全部 531 个接口登记在 `pentest/route-inventory.md`（自动生成，与代码不一致时测试失败）。其中公开 19 个、仅需登录 29 个，均在 `testing/route-registry.ts` 写明原因；其余 468 个企业接口与 15 个平台接口。
- 无凭证、伪造令牌（乱码、结构合法但签名错误、`alg=none`）一律 401，且不区分失败原因。
- 数据层：租户连接受行级安全约束，系统连接只能出现在白名单文件（`scripts/check-tenant-isolation.mjs`）。
- 扫描测试：两个企业各自种入数据与“秘密值”，以企业 A 的超级管理员访问全部无参数读接口，响应中不得出现企业 B 的标记；对写接口发送畸形请求体后，企业 B 的全部租户表快照（行数与摘要）不得变化。
- 带路径参数的接口没有对“接口 × 表”做穷举：这类接口的跨租户保护依赖行级安全与既有的 `cross-tenant.db.test.ts`，扫描测试只用未知编号、注入值与路径穿越写法探测其不会 500。第三方渗透测试应重点补这一块（见 `pentest/README.md` 用例 A4）。

### 3.2 注入

- 数据库：业务代码使用 Prisma 的参数化接口；原始 SQL 只在白名单文件里，语句文本不得拼接变量（规则 S6）。唯一的标识符拼接在 `apps/worker/src/lifecycle/close-sql.ts`，表名来自数据库目录并逐个校验为安全标识符。
- 查询参数形状见 F1。请求体由数据校验管道与 zod 校验，多余字段被丢弃。
- 表格导出的公式注入（以 `=`、`+`、`-`、`@` 开头的单元格）已有防护，既有测试覆盖。
- 命令与表达式执行：业务代码里没有 `eval`、`new Function`、`child_process`（规则 S1，仅 Redis 脚本调用登记在册）。

### 3.3 跨站脚本

- 全站没有 `dangerouslySetInnerHTML`、`innerHTML` 赋值、`document.write`（规则 S1）。
- 图表提示框（ECharts 的自定义格式化会按 HTML 渲染）见 F3；其余图表使用默认提示框，默认实现会转义。
- 链接与新窗口见 F4、F5。
- 工作台页面（`/app`、`/login`、`/platform/`、`/invite/`）由网关下发内容安全策略：脚本只允许同源、不允许内联与动态执行，禁止被嵌入，对象与基础地址收紧。

### 3.4 跨站请求伪造

- 接口只认请求头里的访问令牌，浏览器不会自动附带，伪造的跨站请求带不上；只带 Cookie 访问业务接口一律 401（`security.test.ts`）。
- 唯一依赖 Cookie 的是刷新接口：Cookie 为 HttpOnly、SameSite=Strict（生产再加 Secure）、路径限定在 `/api/v1/auth`；接口再校验 `Origin` 或 `Referer`，缺失、`null`、外站一律拒绝。
- 跨域：只回显 `CORS_ORIGINS` 里登记的来源，未登记时一律不放行；不使用通配（规则 S9a）。

### 3.5 敏感信息泄露

- 全路由扫描：响应里不得出现口令哈希、动态验证码密文、刷新令牌哈希、授权密文、邀请令牌等键名或植入的秘密值。
- 错误响应不含堆栈、数据库语句、文件路径（`security.test.ts`）；请求编号只接受安全字符，防日志与响应头注入。
- 响应头：`nosniff`、禁止嵌入、`Referrer-Policy: no-referrer`、不暴露 `X-Powered-By`；认证接口 `Cache-Control: no-store`。
- 日志去敏（既有 `SENSITIVE_LOG_KEYS`）；仓库扫描不含私钥与云账号密钥形态的字符串（规则 S11），生产示例文件里的密钥类变量必须是 `REPLACE_` 占位。

## 四、没有证明的部分（剩余风险）

1. 没有做真实渗透测试，没有在真实浏览器里复查响应头与内容安全策略（含 F8 的商品图显示）。
2. 出站地址校验只判断地址文本：不防域名重定向到内网（DNS 重绑定）与 HTTP 重定向。需要在部署层加出站网络策略，只放行亚马逊与对象存储的域名（记入部署专项）。
3. 模糊测试只覆盖接口校验层接受的参数；全路由扫描覆盖无参数读接口与畸形写请求，不覆盖“带合法参数的深层业务分支”。
4. 带路径参数接口的跨租户保护依赖行级安全与既有测试，没有穷举。
5. 网关的限流、WAF、DDoS 防护不在代码里，归部署专项；`nginx-https.conf` 的 HSTS 没有 `preload`，是否申请预加载列表由部署时决定。
6. 依赖漏洞：`pnpm audit` 在持续集成里执行；无法确认的未公开漏洞不在本核查范围。
7. 静态检查脚本只能发现“写法”层面的问题，发现不了业务逻辑上的越权。

## 五、持续保障（防止回退）

| 手段 | 位置 | 触发 |
| --- | --- | --- |
| 安全静态检查（规则 S1–S12，带自检） | `scripts/check-security.mjs` | 持续集成 typecheck 阶段 |
| 租户隔离静态检查 | `scripts/check-tenant-isolation.mjs` | 同上 |
| 越权全接口扫描 | `apps/api/src/access-control.test.ts` | 测试阶段 |
| 真实数据库全路由扫描 | `apps/api/src/testing/security-sweep.db.test.ts` | 测试阶段 |
| 安全头、跨域、来源校验、查询形状 | `apps/api/src/security.test.ts` | 测试阶段 |
| 接口清单与代码一致 | `apps/api/src/route-inventory.test.ts` | 测试阶段 |
| 生产密钥体检 | `packages/crypto/src/secret-config.ts` | 接口与后台任务启动 |
