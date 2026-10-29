// 统一错误码目录（前后端共用）：接口只能返回这里登记过的错误码；HTTP 状态与是否可重试在此统一定义。
// 新增错误码必须先在这里登记，否则接口服务的静态检查测试会失败。

export interface ErrorCodeSpec {
  /** 默认 HTTP 状态码 */
  status: number
  /** 同样的请求稍后重试是否可能成功 */
  retryable: boolean
  /** 含义（给开发与运营看，不直接展示给用户） */
  meaning: string
}

const spec = (status: number, meaning: string, retryable = false): ErrorCodeSpec => ({ status, retryable, meaning })

export const ERROR_CODES = {
  // ---- 通用 ----
  BAD_REQUEST: spec(400, '请求格式不正确'),
  VALIDATION_FAILED: spec(422, '请求参数校验失败，带字段级错误'),
  RESOURCE_NOT_FOUND: spec(404, '对象不存在，或不属于当前企业（两种情况对外不加区分）'),
  ROUTE_NOT_FOUND: spec(404, '接口路径不存在'),
  METHOD_NOT_ALLOWED: spec(405, '该路径不支持此请求方法'),
  REQUEST_BODY_TOO_LARGE: spec(413, '请求体超过上限'),
  UNSUPPORTED_MEDIA_TYPE: spec(415, '请求内容类型不受支持'),
  REQUEST_REJECTED: spec(400, '请求被拒绝'),
  RATE_LIMITED: spec(429, '请求过于频繁', true),
  INTERNAL_ERROR: spec(500, '服务内部错误；对外只给请求编号，不暴露内部细节'),
  DEPENDENCY_UNAVAILABLE: spec(503, '依赖服务尚未就绪', true),

  // ---- 认证、权限与数据范围 ----
  AUTH_REQUIRED: spec(401, '未登录或登录已失效'),
  LOGIN_LOCKED: spec(429, '连续登录失败，账号暂时锁定', true),
  TENANT_ACCESS_DENIED: spec(403, '没有执行该操作的权限'),
  SCOPE_NOT_GRANTED: spec(403, '成员尚未被授予任何店铺的数据范围'),
  SCOPE_EMPTY: spec(403, '所选范围与授权范围的交集为空'),
  SCOPE_STORE_FORBIDDEN: spec(403, '店铺不在成员的数据范围内'),
  SCOPE_TENANT_LEVEL_ONLY: spec(403, '该操作影响企业全部店铺，需要“全部店铺”数据范围'),
  SESSION_REUSE_DETECTED: spec(401, '检测到登录凭据被重复使用，该登录会话已全部吊销，请重新登录'),
  REFRESH_CONFLICT: spec(409, '登录凭据刚刚已被另一个请求更新，请携带新的凭据重试', true),
  ORIGIN_NOT_ALLOWED: spec(403, '请求来源不在允许范围内'),
  MFA_ENROLLMENT_REQUIRED: spec(403, '管理员必须先绑定多因素认证后才能继续使用'),
  MFA_ALREADY_ENROLLED: spec(409, '已经绑定并验证过多因素认证'),
  MFA_NOT_ENROLLED: spec(409, '还没有开始绑定多因素认证，请先获取绑定信息'),
  MFA_CODE_INVALID: spec(403, '验证码不正确或已使用过'),
  LOCAL_WORKSPACE_NOT_READY: spec(503, '本地开发工作区尚未初始化'),
  INTERNAL_ACCESS_NOT_CONFIGURED: spec(503, '内部访问模式绑定的企业或角色不存在'),
  INTERNAL_ACCESS_UNSUPPORTED: spec(403, '内部访问模式下不支持此操作（需要个人账号身份）'),
  PLATFORM_ADMIN_REQUIRED: spec(403, '需要平台运营身份'),
  PLATFORM_OPERATOR_TENANT_NOT_CONFIGURED: spec(503, '生产环境尚未配置平台运营租户'),

  // ---- 写操作横向规则（P1-14）----
  IDEMPOTENCY_KEY_REQUIRED: spec(400, '写接口必须携带 Idempotency-Key 请求头'),
  IDEMPOTENCY_KEY_INVALID: spec(400, 'Idempotency-Key 格式不合法'),
  IDEMPOTENCY_KEY_REUSED: spec(422, '同一个幂等键被用于内容不同的请求'),
  IDEMPOTENCY_IN_PROGRESS: spec(409, '使用该幂等键的上一次请求仍在处理中', true),
  STEP_UP_REQUIRED: spec(403, '高风险操作需要先再次验证身份'),
  STEP_UP_FAILED: spec(403, '再次验证身份未通过'),
  STEP_UP_ACTION_UNKNOWN: spec(422, '不是需要再次验证的操作'),
  CONFLICT: spec(409, '对象已被他人修改（版本号不一致），请刷新或合并后重试'),
  CONNECTION_UNAVAILABLE: spec(409, '动作所需的亚马逊连接不可用（未授权、已失效或健康检查未通过）'),
  WRITE_SWITCH_OFF: spec(409, '该类亚马逊写入的开关未开启'),
  DATA_CONDITION_FAILED: spec(409, '数据条件不满足'),
  PREVIEW_REQUIRED: spec(409, '该动作需要先完成预览或校验'),

  // ---- 业务：采购、同步、入仓、报表 ----
  PURCHASE_ORDER_INVALID: spec(400, '采购单内容不完整'),
  DATA_DOMAIN_NOT_IMPLEMENTED: spec(409, '该数据域需要通过报表任务获取'),
  DEAD_LETTER_ALREADY_REPLAYED: spec(409, '这条失败任务已经被重放过，不能重复重放'),
  FBA_CONNECTION_REQUIRED: spec(409, '需要已完成授权的卖家连接'),
  ADS_CONNECTION_REQUIRED: spec(409, '需要已完成授权的广告连接'),

  // ---- 业务：连接与授权 ----
  LEGAL_ENTITY_REQUIRED: spec(409, '授权连接需要先绑定法律主体'),
  APPROVAL_PENDING: spec(409, '亚马逊公有应用尚未完成审批'),
  OAUTH_REDIRECT_URI_NOT_ALLOWED: spec(400, '回调地址不在服务端登记的固定地址内'),
  OAUTH_CALLBACK_DENIED: spec(400, '用户在亚马逊侧拒绝了授权'),
  OAUTH_CALLBACK_INVALID: spec(400, '授权回调参数不完整'),
  OAUTH_STATE_INVALID: spec(400, '授权状态不存在、已使用或已过期'),
  LWA_CONFIG_MISSING: spec(503, '亚马逊登录授权（LWA）凭据未配置'),
  LWA_TOKEN_EXCHANGE_FAILED: spec(502, '换取亚马逊令牌失败', true),
  SP_API_REDIRECT_URI_MISSING: spec(503, '卖家 API 回调地址未配置'),
  SP_API_APPLICATION_ID_MISSING: spec(503, '卖家 API 应用编号未配置'),
  ADS_REDIRECT_URI_MISSING: spec(503, '广告 API 回调地址未配置'),
  ADS_CLIENT_ID_MISSING: spec(503, '广告 API Client ID 未配置'),
  ADS_APPROVAL_PENDING: spec(409, '广告 API 公有应用尚未完成审批'),
  ADS_LWA_CONFIG_MISSING: spec(503, '广告 API 登录授权凭据未配置'),
  ADS_OAUTH_DENIED: spec(400, '用户在亚马逊广告侧拒绝了授权'),
  ADS_OAUTH_CALLBACK_INVALID: spec(400, '广告授权回调参数不完整'),
  ADS_OAUTH_STATE_INVALID: spec(400, '广告授权状态不存在、已使用或已过期'),
  ADS_LWA_TOKEN_EXCHANGE_FAILED: spec(502, '换取广告令牌失败', true),
  ADS_PROFILE_NOT_FOUND: spec(404, '广告档案不存在或不在当前数据范围内'),
  ADS_ACCOUNT_MISSING: spec(409, '广告档案还没有发现统一接口的广告账户编号，不能使用新报告接口'),
  ADS_REPORT_NOT_FOUND: spec(404, '报告任务不存在或不在当前数据范围内'),
  ADS_REPORT_TEMPLATE_UNKNOWN: spec(422, '报告模板不存在'),
  ADS_REPORT_WINDOW: spec(422, '报告的时间范围不符合该模板的限制'),
  ADS_REPORT_NOT_RETRYABLE: spec(409, '只有新报告接口的失败任务可以重试'),
  ADS_REPORT_ALREADY_RETRIED: spec(409, '这个失败任务已经重试过了'),
  ADS_BACKFILL_RANGE: spec(422, '历史回补的月数不合法'),
  ADS_BACKFILL_RUNNING: spec(409, '这个广告档案还有没完成的活动日报任务，不能再次回补'),
  REPORT_NOT_FOUND: spec(404, '报告任务不存在或不在当前数据范围内'),
  REPORT_PERIOD_INVALID: spec(422, '报告的数据周期不符合该报告类型的要求'),
  REPORT_ALREADY_RUNNING: spec(409, '同一店铺、同一报告类型、同一周期已有没完成的任务'),
  REPORT_NOT_CANCELABLE: spec(409, '只有排队中或生成中的报告任务可以取消'),
  REPORT_NOT_RETRYABLE: spec(409, '只有失败或已取消的报告任务可以重试'),
  REPORT_ALREADY_RETRIED: spec(409, '这个任务已经重试过了'),
  REPORT_FILE_UNAVAILABLE: spec(409, '这个报告任务没有可下载的原始文件（没有留存、已过保留期或不留存文件）'),
  SYNC_JOB_NOT_RETRYABLE: spec(409, '这个同步任务现在不能重试：只有失败的任务可以重试，已作废的任务请重新发起'),
  CONNECTION_ALREADY_DISCONNECTED: spec(409, '这个连接已经断开'),
  OAUTH_SELLER_MISMATCH: spec(409, '重新授权选择的卖家账户与原连接不一致，请用原来的卖家账户授权；换卖家账户请新建连接'),
  ADS_METRICS_REQUEST: spec(422, '广告指标的维度或指标选择不合法'),
  ADS_METRICS_SORT: spec(422, '广告指标的排序字段必须是分组键或已选指标'),
  ADS_PARITY_RUN_NOT_FOUND: spec(404, '核对记录不存在或不在当前数据范围内'),
  TOKEN_VAULT_NOT_CONFIGURED: spec(503, '令牌加密密钥未配置'),
  QUERY_TIMEOUT: spec(504, '查询耗时过长被终止，请缩小筛选范围后重试', true),
  KEY_SERVICE_UNAVAILABLE: spec(503, '密钥服务暂时不可用', true),

  // ---- 文件存储（P1-23）----
  STORAGE_LINK_INVALID: spec(403, '文件链接无效（签名不符、用途不符或已被篡改）'),
  STORAGE_LINK_EXPIRED: spec(410, '文件链接已过期，需要重新获取'),
  FILE_TOO_LARGE: spec(413, '文件超过大小上限'),
  FILE_TYPE_NOT_ALLOWED: spec(415, '不支持的文件类型，或与上传凭证约定的类型不符'),
  STORAGE_NOT_CONFIGURED: spec(503, '文件存储尚未配置'),
  STORAGE_UNAVAILABLE: spec(503, '文件存储暂时不可用', true),

  // ---- 租户注册与生命周期（P1-19）----
  PLATFORM_AUTH_REQUIRED: spec(401, '平台运营账号未登录或登录已失效'),
  PLATFORM_LOGIN_FAILED: spec(401, '平台账号或密码不正确'),
  PLATFORM_MFA_CHALLENGE_INVALID: spec(401, '验证挑战无效或已过期，请重新登录'),
  PLATFORM_PERMISSION_DENIED: spec(403, '当前平台账号没有执行此操作的权限'),
  TENANT_SUSPENDED: spec(403, '企业已被暂停，当前只读，不能修改数据'),
  TENANT_INACTIVE: spec(403, '企业已停用或已注销，不能访问'),
  TENANT_SLUG_TAKEN: spec(409, '企业标识已被使用'),
  TENANT_TRANSITION_INVALID: spec(409, '当前状态不能执行该变更'),
  TENANT_CLOSE_CONFIRMATION_MISMATCH: spec(422, '确认的企业标识与当前企业不一致'),
  INVITATION_INVALID: spec(404, '邀请链接无效、已使用或已过期'),
  INVITATION_EMAIL_REGISTERED: spec(409, '该邮箱已有账号，请直接登录后由管理员加入企业'),
  PASSWORD_TOO_WEAK: spec(422, '密码强度不符合要求'),
  ONBOARDING_PREREQUISITE_MISSING: spec(409, '初始化向导的前置条件尚未满足'),
  ONBOARDING_STEP_NOT_SKIPPABLE: spec(409, '该步骤必须完成，不能跳过'),
  ONBOARDING_STEP_INVALID: spec(422, '步骤内容不符合要求'),
  SUPPORT_ACCESS_NOT_GRANTED: spec(403, '企业尚未授权支持访问，或授权已过期、已撤销'),
  SUPPORT_ACCESS_READ_ONLY: spec(403, '支持访问是只读的，不能修改数据'),
  SUPPORT_ACCESS_CLAIMED: spec(409, '该支持访问授权已被其他人员领取'),
  QUOTA_EXCEEDED: spec(409, '已超过配额'),

  // ---- 分页与样例数据 ----
  CURSOR_INVALID: spec(400, '翻页游标无效，或查询条件已变化'),
  CURSOR_KEY_NOT_CONFIGURED: spec(503, '翻页签名密钥未配置'),
  CURSOR_SORT_VALUE_UNSUPPORTED: spec(500, '排序字段的值类型不支持游标分页'),
  CURSOR_SORT_VALUE_NULL: spec(500, '游标分页的排序字段不能为空值'),
  SAMPLE_IMPORTER_MISSING: spec(409, '样例文件对应的导入器尚未注册'),
  SAMPLE_MANIFEST_INVALID: spec(500, '样例文件清单不存在或格式错误'),
  SAMPLE_FILE_MISSING: spec(500, '样例文件不存在'),
  SAMPLE_FILE_CHANGED: spec(500, '样例文件与登记的摘要不一致'),

  // ---- 业务：官网商业化（订单、支付、退款）----
  PLAN_NOT_FOUND: spec(404, '套餐不存在或已停止销售'),
  PLAN_REQUIRES_QUOTE: spec(409, '企业定制版需要先确认服务范围'),
  TAX_RATE_NOT_CONFIGURED: spec(409, '不含税价格尚未配置适用税率'),
  ORDER_NOT_FOUND: spec(404, '订单不存在'),
  ORDER_EXPIRED: spec(409, '订单已过期'),
  ORDER_NOT_PAYABLE: spec(409, '订单状态不能发起支付'),
  ORDER_NOT_REFUNDABLE: spec(409, '订单状态不能申请退款'),
  ORDER_NOT_ACTIVATABLE: spec(409, '只有已支付待开通的订单可以开通'),
  ORDER_ACCESS_TOKEN_REQUIRED: spec(401, '缺少订单访问凭据'),
  ORDER_ACCESS_DENIED: spec(403, '订单访问凭据无效'),
  REFUND_NOT_FOUND: spec(404, '退款申请不存在'),
  REFUND_WINDOW_EXPIRED: spec(409, '退款申请期已结束'),
  REFUND_ALREADY_OPEN: spec(409, '该订单已有正在处理的退款申请'),
  REFUND_ALREADY_REVIEWED: spec(409, '退款申请已处理'),
  REFUND_IN_PROGRESS: spec(409, '退款申请处理中，不能开通服务'),
  INVALID_REFUND_AMOUNT: spec(422, '退款金额超过可退款余额'),
  PAID_PAYMENT_NOT_FOUND: spec(409, '没有找到可退款的已支付流水'),
  PAYMENT_NOT_FOUND: spec(409, '退款申请没有关联支付流水'),
  TENANT_NOT_FOUND: spec(404, '企业工作区不存在'),
  ALIPAY_NOT_CONFIGURED: spec(503, '支付宝尚未完成生产配置'),
  ALIPAY_PRIVATE_KEY_UNAVAILABLE: spec(503, '支付宝应用私钥不可读取'),
  ALIPAY_PUBLIC_KEY_UNAVAILABLE: spec(503, '支付宝公钥不可读取'),
  ALIPAY_REFUND_HTTP_FAILED: spec(502, '支付宝退款请求失败', true),
  ALIPAY_REFUND_FAILED: spec(502, '支付宝未确认退款成功', true),
  INVALID_STATUS: spec(400, '不支持的状态值'),
} as const satisfies Record<string, ErrorCodeSpec>

export type ErrorCode = keyof typeof ERROR_CODES

export const isErrorCode = (value: string): value is ErrorCode => Object.prototype.hasOwnProperty.call(ERROR_CODES, value)

/** 错误响应体：所有接口的错误都是这个形状，不含堆栈与内部细节。 */
export interface ApiErrorBody {
  code: ErrorCode
  message: string
  requestId: string
  retryable: boolean
  fieldErrors?: Record<string, string[]>
  /** 仅放对前端有用且不敏感的补充信息，例如 STEP_UP_REQUIRED 的 action。 */
  details?: Record<string, string | number | boolean | null>
}
