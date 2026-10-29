# P0-02 数据模型清单（冻结稿）

依据：10 章 10.1、10.2；12 章 12.3、12.7、12.8；`importers.md`（来源与幂等键）；`permissions.md`；14 章 P0-02。
范围：10.2 的全部新增与修改模型，加上 10.1 要求的日汇总表。
本文件冻结的是"模型、关键字段与类型、唯一键、分区、乐观锁、迁移归属、行级安全"。每个工作包写迁移时，**不得增删模型、不得改唯一键与分区**；只允许在本文关键字段基础上按官方样例文件补充"报告原始列"，且补充列须在该工作包的数据库迁移检查（14.5 第 7 类）中列出。

---

## 零、通用约定

### 0.1 命名与类型

| 约定 | 内容 |
|---|---|
| 主键 | `id String @id @default(cuid())`。分区表主键为复合主键 `(id, 分区日期列)`，因为分区表的主键与所有唯一键必须包含分区列 |
| 租户 | 所有业务表带 `tenantId String`，索引第一列 |
| 店铺 | 与现有代码保持一致，店铺外键字段名为 `sellerAccountId`（下文简写 `storeId`）；店铺表为现有 `SellerAccount`。站点固定美国站 `ATVPDKIKX0DER`，不作为可选字段，只在需要核对来源时保存 `marketplaceId` |
| 类型缩写 | `Str` 文本；`Int` 整数；`Dec` 金额 `Decimal(20,6)`；`Pct` 比率 `Decimal(12,6)`；`Bool`；`Dt` 带时区时间；`D` 日期；`Json` 仅限"来源原样快照"字段，不用于可筛选、可排序的业务字段；`Enum` 以文本加数据库检查约束实现，便于以后加值 |
| 同步表来源字段 | 所有来自亚马逊或文件的同步表带 `sourceUpdatedAt Dt`、`syncedAt Dt`、`sourceReportJobId Str?`、`sourceRecordId Str?`（10.1），下文不再逐表重复 |
| 版本号 | 需要乐观锁的模型带 `version Int @default(1)`；更新语句必须带 `where version = ?`，影响行数为 0 返回冲突（P1-15）。表中"版本"列为 ✓ 的即带版本号 |
| 时间 | 一律存 UTC；业务日按企业设置的数据口径时区（默认美国太平洋时区）计算后存入 `D` 类型列 |
| 币种 | 金额列旁带 `currency Str`；美元为基准币种 |
| 软删除 | 默认不软删除；需要保留审计的对象用状态字段（如"已作废"），不物理删除 |

### 0.2 索引规范（P1-27）

1. 每张表的主要查询索引第一列为 `tenantId`，其后依次为 `storeId`、日期列；
2. 唯一键即幂等键，同时承担 upsert 冲突目标；
3. 外键列单独建索引；
4. 新增查询必须经索引评审（流程见 `freeze/index-review.md`）：慢查询超过 1 秒告警；
5. 下表"附加索引"只写在上述规则之外的额外索引。

### 0.3 分区（P1-27）

- 按月范围分区，分区列在下表"分区"列写明；
- 分区表的所有唯一键必须包含分区列；
- Prisma 不原生支持分区表，**分区表由手写迁移 SQL 创建**，Prisma 模型只作映射，迁移中写明回滚方法；
- 提前 3 个月自动创建未来分区；分区保留策略：订单、财务、库存快照等主业务表**不自动删除**，小时级与原始事件类按保留策略归档（小时事件 400 天、`AmazonNotificationEvent` 90 天）；
- 大表变更遵循"先加后删"。

### 0.4 行级安全（P1-16）

- **R**：行级安全策略，条件 `tenantId = current_setting('app.tenant_id')`，应用连接用非超级用户账号，每个请求事务设置 `app.tenant_id`；
- **P**：平台表，不属于任何租户，不开启行级安全，只允许"平台账号"访问（独立数据库角色，租户接口的连接无权限）；
- **RP**：租户表中允许平台支持账号在 `PlatformSupportAccess` 授权有效期内只读访问，策略单独写；
- 任何一个新增模型在迁移里没有对应的行级安全策略，持续集成中的"策略覆盖检查"必须失败。

### 0.5 迁移序号

迁移按工作包执行顺序命名为 `M-<工作包>`，实际目录名为 `<时间戳>_<名称>`，**时间戳必须晚于现有最新迁移 `20261021020000`**，创建时才分配。全部迁移按本文第十三节顺序执行。

### 0.6 表中字段说明

"核心字段"只列业务关键字段与类型；`id`、`tenantId`、`storeId`（如适用）、`createdAt`、`updatedAt`、同步来源 4 字段、`version`（如适用）按上文约定隐含存在。

---

## 一、权限与范围

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `MembershipScope` | 新增 | membershipId Str；legalEntityId Str?；sellerAccountId Str?（空表示该主体下全部店铺）；grantedBy Str；note Str? | `(membershipId, legalEntityId, sellerAccountId)` | 否 | — | R | M-P1-12 | P1-12 |
| `MemberInvitation` | 新增 | email Str；roleId Str；scopeSnapshot Json（邀请时的范围）；status Enum(待接受/已接受/已撤销/已过期)；tokenHash Str；expiresAt Dt；invitedBy Str；acceptedAt Dt? | `(tenantId, email, status='待接受')` 部分唯一；`tokenHash` | 否 | — | R | M-P1-13 | P1-13 |
| `FieldPermission` | 新增 | roleId Str；fieldKey Enum(cost/profit/buyerPii)；allowed Bool | `(roleId, fieldKey)` | 否 | — | R | M-P1-13 | P1-13 |
| `Role` | 修改 | 权限列表改为"模块.动作"字符串数组；新增 `isSystem Bool`（预设角色不可删）、`permissionsVersion Int` | 保持 `(tenantId, name)` | 否 | ✓（已有则沿用） | R | M-P1-13 | P1-13 |

## 二、平台能力

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `DataFreshness` | 新增 | sourceKey Str；lastAttemptAt Dt；lastSuccessAt Dt?；dataThrough Dt?；lastRowCount Int；status Enum(正常/延迟/失败/未授权/不适用/未接入/等待依赖)；lastErrorCode Str? | `(tenantId, storeId, sourceKey)` | 否 | — | R | M-P1-28 | P1-28 |
| `ExportJob` | 新增 | kind Str；sourcePage Str；filterSummary Str；filterJson Json；format Enum(CSV/XLSX)；status Enum(排队/生成中/完成/失败/已过期)；rowCount Int?；fileKey Str?；fileSize Int?；expiresAt Dt；requestedBy Str；fieldPolicySnapshot Json | `id` | 否 | — | R | M-P1-28 | P1-28 |
| `SavedView` | 新增 | pageKey Str；name Str；filterJson Json；columnsJson Json；sortJson Json；ownerId Str；shared Bool；isDefault Bool | `(ownerId, pageKey, name)` | 否 | ✓ | R | M-P1-28 | P1-28 |
| `RawReportFile` | 新增 | sourceKey Str；reportType Str?；reportId Str?；objectKey Str；sizeBytes Int；sha256 Str；rowCount Int?；periodStart D?；periodEnd D?；storedAt Dt；retentionUntil D? | `(tenantId, storeId, sha256)` | 否 | — | R | M-P1-23 | P1-23 |
| `Notification` | 新增 | userId Str；kind Str；title Str；body Str；link Str?；readAt Dt?；severity Enum(信息/警告/严重)；dedupKey Str? | `(userId, dedupKey)` 部分唯一 | 否 | — | R | M-P1-28 | P1-28 |
| `TenantSetting` | 新增 | key Str；valueJson Json；scope Enum(企业/店铺)；updatedBy Str | `(tenantId, storeId, key)` | 否 | ✓ | R | M-P1-28 | P1-28 |
| `FinancePolicyVersion` | 新增 | effectiveFrom D；inventoryCostMethod Enum(加权平均/先进先出)；fxRateRule Str；adsAllocationMode Str；feeCategoryMapJson Json；approvedBy Str；status Enum(草稿/生效/已替换) | `(tenantId, effectiveFrom)` | 否 | ✓ | R | M-P2b-15 | P2b-15 |
| `SyncJob` | 修改 | 新增 `domain Str`（数据域）、`sourceKey Str`、`priority Int`、`attempt Int`、`checkpointJson Json?`、`deadLettered Bool` | 现有 | 否 | — | R | M-P1-20 | P1-20 |

## 三、租户、认证与平台后台（12 章）

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `PlatformAdmin` | 新增 | email Str；passwordHash Str；name Str；role Enum(平台所有者/平台运营/平台支持)；mfaRequired Bool（恒为真）；status Enum(启用/停用) | `email` | 否 | — | **P** | M-P1-19 | P1-19 |
| `TenantInvitation` | 新增 | email Str；tokenHash Str；status Enum；expiresAt Dt；createdByPlatformAdminId Str；acceptedAt Dt? | `tokenHash` | 否 | — | **P** | M-P1-19 | P1-19 |
| `TenantOnboarding` | 新增 | step Enum(账号/企业/主体/店铺/授权/成员/完成)；stepStateJson Json；completedAt Dt? | `(tenantId)` | 否 | — | R | M-P1-19 | P1-19 |
| `TenantLifecycleEvent` | 新增 | fromStatus Str；toStatus Str；reason Str；actorPlatformAdminId Str? | `id` | 否 | — | RP | M-P1-19 | P1-19 |
| `TenantQuota` | 新增 | quotaKey Str；limitValue Int；usedValue Int；resetAt Dt? | `(tenantId, quotaKey)` | 否 | ✓ | RP | M-P1-19 | P1-19 |
| `PlatformSupportAccess` | 新增 | platformAdminId Str；grantedByUserId Str；reason Str；startsAt Dt；expiresAt Dt；revokedAt Dt?；scope Enum(只读) | `id`；检查 `expiresAt - startsAt ≤ 7 天` | 否 | — | R | M-P1-19 | P1-19 |
| `MfaFactor` | 新增 | userId Str；kind Enum(TOTP/恢复码)；secretCiphertext Str；keyVersion Int；verifiedAt Dt?；lastUsedAt Dt? | `(userId, kind)` | 否 | — | R | M-P1-17 | P1-17 |
| `DataEncryptionKey` | 新增 | purpose Enum(amazon-token/buyer-pii/mfa)；version Int；wrappedKey Str（被主密钥包裹）；masterKeyId Str；status Enum(ACTIVE/RETIRED)；retiredAt Dt? | `(purpose, version)`；检查 version ≥ 1；系统账号只增不删（CR-016） | 否 | — | 系统专用 | M-P1-24 | P1-24 |
| `StepUpVerification` | 新增 | userId Str；action Str；verifiedAt Dt；expiresAt Dt（10 分钟）；method Enum | `id`；索引 `(userId, action, expiresAt)` | 否 | — | R | M-P1-14 | P1-14 |
| `Tenant` | 修改 | `dataTimezone` 默认改为美国太平洋时区；`displayCurrency` 默认改为 USD；新增 `localTimezone Str`（企业本地时区）、`lifecycleStatus Enum`（试用/正常/暂停/注销中/已注销） | 现有 | 否 | — | P/R 混合（平台可读） | M-P1-19 | P1-19 |
| `Session` | 修改 | 新增 `refreshTokenHash Str`、`rotationChainId Str`、`rotatedFromId Str?`、`reuseDetectedAt Dt?`、`deviceFingerprint Str?`、`ipMasked Str?`（CR-010，会话列表展示用的脱敏地址） | 现有 | 否 | — | R | M-P1-17 | P1-17 |

## 四、流程可靠性（12 章 12.3）

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `WorkflowRun` | 新增 | kind Str；status Enum(进行中/成功/失败/已补偿/已取消)；intentJson Json（先记录意图）；resultJson Json?；startedAt Dt；finishedAt Dt?；heartbeatAt Dt；lockOwner Str? | `id`；索引 `(tenantId, kind, status)` | 否 | — | R | M-P1-20 | P1-20 |
| `WorkflowStep` | 新增 | runId Str；seq Int；name Str；status Enum；requestJson Json?；responseJson Json?；errorCode Str?；attempt Int | `(runId, seq)` | 否 | — | R | M-P1-20 | P1-20 |
| `IdempotencyRecord` | 新增 | key Str；route Str；requestHash Str；responseStatus Int?；responseJson Json?；expiresAt Dt（24 小时） | `(tenantId, key, route)` | 否 | — | R | M-P1-14 | P1-14 |
| `DeadLetterJob` | 新增 | queue Str；jobName Str；payloadRef Str（只存编号与参数）；errorCode Str；errorDetail Str；attempts Int；replayedAt Dt?；replayedBy Str? | `id` | 否 | — | R | M-P1-20 | P1-20 |
| `DistributedLock` | 新增 | lockKey Str；owner Str；leaseUntil Dt；renewedAt Dt | `(tenantId, lockKey)` | 否 | — | R | M-P1-20 | P1-20 |

## 五、写入开关与汇率

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `IntegrationSwitch` | 新增 | switchKey Str（`sw.*`，共 20 项）；enabled Bool；enabledAt Dt?；enabledBy Str?；reason Str?；autoDisabledReason Str?；consecutiveFailures Int；calls7d Int（派生缓存）| `(tenantId, storeId, switchKey)` | 否 | ✓ | R | M-P1-28 | P1-28 |
| `IntegrationSwitchLog` | 新增 | switchKey Str；action Enum(开启/关闭/自动关闭/一键只读/紧急关闭)；reason Str；actorId Str?；beforeJson Json；afterJson Json | `id`；索引 `(tenantId, storeId, switchKey, createdAt)` | 否 | — | R | M-P1-28 | P1-28 |
| `FxRate` | 新增 | baseCurrency Str（USD）；quoteCurrency Str；rateDate D；rate Pct；source Str；isFallback Bool；isManualOverride Bool；overrideReason Str?；lockedByPeriodId Str? | `(tenantId, baseCurrency, quoteCurrency, rateDate, source)`；关账锁定后禁止修改 | 否 | — | R | M-P1-28 | P1-28 |
| `FxSourceConfig` | 新增 | role Enum(主源/备源)；provider Str；pathTemplate Str；priority Int；enabled Bool | `(tenantId, role)` | 否 | ✓ | R | M-P1-28 | P1-28 |

## 六、协作与事件

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `Comment` | 新增 | entityType Str；entityId Str；body Str；mentions Str[]；authorId Str；parentId Str?；editedAt Dt? | `id`；索引 `(tenantId, entityType, entityId, createdAt)` | 否 | — | R | M-P1-28 | P1-28 |
| `Watch` | 新增 | entityType Str；entityId Str；userId Str | `(userId, entityType, entityId)` | 否 | — | R | M-P1-28 | P1-28 |
| `EntityEvent` | 新增 | entityType Str；entityId Str；kind Str（改价、改预算、改刊登、入仓确认、成本变更、预警、手工记录…）；occurredAt Dt；title Str；detailJson Json?；actorKind Enum(用户/系统/亚马逊/外部)；sourceRef Str? | `(tenantId, entityType, entityId, kind, occurredAt, sourceRef)` | 否 | — | R | M-P1-28 | P1-28 |
| `OperationLog` | 新增 | scope Enum(店铺/ASIN/广告活动)；scopeRef Str；occurredAt Dt；category Str；text Str；authorId Str；attachmentIds Str[] | `id` | 否 | — | R | M-P1-28 | P1-28 |

## 七、目标、订阅与日汇总

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `BusinessTarget` | 新增 | periodKind Enum(月/季/年)；periodStart D；dimension Enum(店铺/类目/ASIN)；dimensionRef Str；metric Enum(销售额/订单/单量/利润/广告花费)；targetValue Dec；paceMode Enum(线性/历史季节)；note Str? | `(tenantId, storeId, periodKind, periodStart, dimension, dimensionRef, metric)` | 否 | ✓ | R | M-P2a-04 | P2a-04 |
| `ReportSubscription` | 新增 | reportKind Str；frequency Enum(日/周/月)；recipientsJson Json；format Str；paused Bool；lastRunAt Dt?（邮件推送暂缓，见 14.10，本表先保存订阅，不投递） | `(ownerId, reportKind, frequency)` | 否 | — | R | M-P5-03 | P5-03 |
| `StoreDailySummary`（10.1 经营日汇总） | 新增 | summaryDate D；orders Int；units Int；salesAmount Dec；refundAmount Dec；feeAmount Dec；adsSpend Dec；adsSales Dec；profit Dec?（标注口径版本）；sessions Int?；currency Str；metricVersion Str | `(tenantId, storeId, summaryDate)` | 否 | — | R | M-P2a-01 | P2a-01 |
| `AsinDailySummary`（10.1 ASIN 日汇总） | 新增 | summaryDate D；asin Str；sku Str?；units Int；salesAmount Dec；sessions Int?；pageViews Int?；buyBoxPct Pct?；adsSpend Dec；adsSales Dec；profit Dec?；inventoryAvailable Int?；currency Str；metricVersion Str | `(tenantId, storeId, asin, summaryDate)` | 否 | — | R | M-P2a-01 | P2a-01 |
| `AdsDailySummary`（10.1 广告日汇总） | 新增 | summaryDate D；adsAccountId Str；campaignId Str?；spend Dec；sales Dec；orders Int；clicks Int；impressions Int；currency Str | `(tenantId, storeId, adsAccountId, campaignId, summaryDate)` | 否 | — | R | M-P3-04 | P3-04 |

> `ProfitDaily`（10.1 利润日表）见第十四节。以上三张日汇总表的名称由本文冻结（10.2 未命名，属补全命名，见第十四节 G-07）。

> **`AdsDailySummary` 实现说明（P3-04，CR-059，迁移 `20261111010000_ads_daily_summary`）**：与上表的出入——（1）键是 `(tenantId, adsProfileId, adProduct, campaignId, summaryDate, currency)`，不含店铺编号与账户编号：`AdsMetric` 旧行没有账户编号，店铺绑定又会变化，所以汇总存档案编号，读取方按 `AdsProfile.sellerAccountId` 过滤范围（同 `adsProfileWhere`）；`adsAccountId` 只是来源行或档案上的账户编号文本（可空、无外键）；（2）多了 `adProduct`（同一活动编号在不同广告产品下可重名）、`metricVersion`、`refreshedAt`；`campaignId` 非空，空串表示来源行没有活动编号；（3）`spend`、`sales` 可空（来源行都没给 = 空，不是 0）；（4）来源只取 `AdsMetric` 里 `entityType = CAMPAIGN` 的行，广告组、广告、投放对象、关键词的行是同一笔花费的拆分，不能一起加；（5）`summaryDate` 是广告账户自己的报告日，不换算企业时区；（6）不折算币种，同一档案同一天不同币种各一行。同一组派生任务还把已绑定店铺的美元广告花费与广告销售额写进 `StoreDailySummary.adsSpend`、`adsSales`（没有广告指标行的日子保持为空）；`AsinDailySummary` 的广告列仍为空（`AdsAdvertisedProductMetric` 还没有同步器）。

## 八、商品与刊登

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `FbaProduct` | 修改 | 新增 parentAsin Str?；imageUrl Str?；brand Str?；categoryPath Str?；ownerUserId Str?；tagIds Str[]（实现 P2a-14，CR-037：`brand` 本已存在；另加 catalogStatus Str?（`FOUND`/`NOT_FOUND`）、catalogSyncedAt Dt?；`categoryPath` 只有两级，格式“一级 > 二级”；`ownerUserId`、`tagIds` 本包只读，写入口随 `/products/meta` 后补）；**P4-03（CR-078）另加 variantAttributes Json?**（目录同步写入的变体属性，形如 `{"color":"Red","size":"L"}`，键与值都是目录给的原文；没同步过为空）与索引 `FbaProduct_parent_idx(tenantId, parentAsin)`；迁移 `20261120010000_variant_attributes`，回滚脚本同目录；**P4-07（CR-082）另加 version Int 默认 1**（负责人与标签的乐观锁版本号，只由 `PATCH /products/meta` 推进，目录同步器从不改它，也不改 ownerUserId、tagIds）与索引 `FbaProduct_owner_idx(tenantId, ownerUserId)`（按负责人筛选）；迁移 `20261123010000_product_meta`，回滚脚本同目录 | 现有 | 否 | — | R | M-P2a-14 | P2a-14 |
| `ListingSnapshot` | 新增 | sellerSku Str；asin Str；status Enum(活跃/非活跃/已取消/被抑制)；price Dec?；quantity Int?；snapshotDate D；qualityScore Int?（我方计算，标注版本） | `(storeId, sellerSku, snapshotDate)` | 否 | — | R | M-P4-09 | P4-09 |
| `ListingContentSnapshot` | 新增 | asin Str；fieldPath Str（标题、五点、描述、图片…）；contentHash Str；contentText Str?；capturedAt Dt；changedBy Enum(本人/他人/未知) | `(storeId, asin, fieldPath, contentHash)` | 否 | — | R | M-P4-09 | P4-09 |
| `ListingIssue` | 新增 | sellerSku Str；issueKind Enum(刊登问题/搜索抑制/合规)；issueCode Str；attributeName Str?；severity Str；message Str；firstSeenAt Dt；resolvedAt Dt? | `(storeId, sellerSku, issueKind, issueCode, attributeName)` | 否 | — | R | M-P4-09 | P4-09 |
| `ProductVariantRelation` | 新增 | parentAsin Str；childAsin Str；variationTheme Str?（实现 P2a-14，CR-037：多 sourceUpdatedAt Dt，表示目录接口返回的更新时间；按卖家账号 `sellerAccountId` 区分店铺） | `(storeId, parentAsin, childAsin)` | 否 | — | R | M-P2a-14 | P2a-14 |
| `PriceSnapshot` | 新增 | sellerSku Str；listingPrice Dec；shippingPrice Dec?；businessPrice Dec?；observedAt Dt；source Enum(接口/报告/修改后回读) | `(storeId, sellerSku, observedAt)` | 否 | — | R | M-P4-09 | P4-09 |
| `SalesRankSnapshot` | 新增 | asin Str；classificationId Str；classificationName Str；rank Int；snapshotDate D（实现 P2a-14，CR-037：按卖家账号 `sellerAccountId` 区分店铺；每个同步日一份快照，保留历史） | `(storeId, asin, classificationId, snapshotDate)` | 否 | — | R | M-P2a-14 | P2a-14 |
| `ListingChangeEvent` | 新增 | sellerSku Str?；asin Str?；changeKind Str；beforeJson Json?；afterJson Json?；actorKind Enum(本系统/亚马逊/他人/未知)；occurredAt Dt；writeRunId Str? | `(storeId, asin, changeKind, occurredAt)` | 否 | — | R | M-P4-09 | P4-09 |

> **P4-10 实现说明（CR-085，迁移 `20261124010000_listing_quality`，含 `rollback.sql`）**：四张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql`）：`ListingSnapshot`、`ListingIssue`、`ListingChangeEvent`、`ListingWriteRun`（刊登写入与查询的任务记录，冻结表里没有，新增）。**P4-09 没有交付这三张只读副本表（那一包只做了页面），随本包建立。** **与上表的差异**：① `ListingSnapshot` 不是“每日快照”而是**当前状态行**（一个店铺 × SKU 一行，唯一键 `(sellerAccountId, marketplaceId, sellerSku)`），状态只有 `ACTIVE`（亚马逊状态含 `BUYABLE`）与 `INACTIVE`，带 `amazonStatuses` 原值与 `statusSince`（状态切换时重置）；冻结的 `price`、`quantity`、`qualityScore` **没有存**（价格归 P4-11，库存归库存同步，质量分我方没有算法依据，页面写“尚未接入”），多了 `productType`、`conditionType`、`itemName`、`mainImageUrl`（用来发现商品类型与标题、主图的变化）。② `ListingIssue` 唯一键是 `(sellerAccountId, sellerSku, issueKind, issueCode, attributeName)`，`attributeName` 缺失存空串；冻结的 `issueKind` 取 `ISSUE`、`SEARCH_SUPPRESSED`、`COMPLIANCE`，另有 `category`（缺失属性、取值无效等）、`impact`（取亚马逊执法动作里最重的一个）、`lastSeenAt`、`handlingStatus`（`OPEN` / `IN_PROGRESS`，提交修复时标处理中）、`handlingRunId`、`version`（乐观锁）；**只存错误与警告，不存提示级**；问题消失写 `resolvedAt`，再次出现重开并把 `firstSeenAt` 重置为现在。③ `ListingChangeEvent` 的冻结字段 `beforeJson`、`afterJson` 实为文字 `beforeText`、`afterText`，唯一键加了 `sellerSku`、`fieldPath`、`sourceRef`（来源标识，保证同一次变化只记一条）；变更种类只有 `PRODUCT_TYPE_CHANGE` 与 `CONTENT_CHANGE`，**能观察到的内容字段只有标题与主图**（五点、描述、全部图片与 A+ 属于 P4-14），行为人 `SELF`（该 SKU 最近 3 天内本系统有成功的修改或批量任务，并关联任务编号）、`AMAZON`、`OTHER`、`UNKNOWN`，**每日同步只能判断“是不是本系统改的”，判断不出是谁改的一律 `UNKNOWN`**。④ `ListingContentSnapshot`、`PriceSnapshot` 本包没有建（属于 P4-14、P4-11）。⑤ `ListingWriteRun` 保存请求内容与哈希（校验令牌用）、`status`（`PENDING`、`RUNNING`、`SUBMITTED`、`PROCESSING`、`SUCCEEDED`、`PARTIAL`、`FAILED`）、校验结论、问题与逐商品结果、亚马逊的 `feedId` 与 `feedDocumentId`、轮询次数、失败码、`expiresAt`（校验预览 30 分钟、刊登限制结果 1 小时）；同一 SKU 同时只能有一个未完成的修改。⑥ 回滚只删这四张表：前三张是亚马逊数据的只读副本，下一次同步会取回；`ListingWriteRun` 里的任务记录会丢失，亚马逊侧已生效的修改不受影响。

> **P4-11 实现说明（CR-086，迁移 `20261125010000_pricing`，含 `rollback.sql`）**：八张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql` 与 `tenant-seed.ts` 的 `SEED_OVERRIDES`）：`PriceSnapshot`、`FeaturedOfferExpectedPrice`、`CompetitiveSummarySnapshot`、`CompetitiveOffer`、`BuyBoxSnapshot`（五张亚马逊数据的只读副本）与 `PriceGuardrail`、`PricingRule`、`PricingRuleRun`（我方设置与执行记录）。**与上表的差异**：① 价格类快照**不是每次同步一条**，只在价格（或结论）变化、或距上一条超过 24 小时（心跳）时才写，读取“最近一次”只看 3 天内的行，历史曲线因此是阶梯状；同一时刻重复写入靠唯一键加 `skipDuplicates` 保持幂等。② `PriceSnapshot.source` 取 `LISTING_API`（同步）或 `WRITE_SUBMITTED`（改价提交成功，下一次同步以接口为准）。③ `CompetitiveOffer.offerKey` 是卖家编号的哈希，不存别家卖家编号原文，`isOwn` 标我方；同一时刻最多留价格最低的 30 条。④ `BuyBoxSnapshot.source` 取 `SYNC`（每 2 小时同步，参与“获得/失去推荐报价”事件的判断）或 `NOTIFICATION`（N-05、N-06 推送，只补充历史；`lostReason = PRICE` 表示因价格失去推荐报价资格，详情页据此显示价格健康事件）。⑤ `PriceGuardrail` 的作用域 `STORE` / `CATEGORY` / `ASIN` / `SKU`，`STORE` 的 `scopeRef` 存空串，唯一键 `(tenantId, sellerAccountId, scope, scopeRef)`，`version` 乐观锁；四个限制（最低价、最高价、最低利润率、单次调幅上限）都可为空，同一字段多层时取最具体的一层。⑥ `PricingRule` 比冻结模型多了熔断阈值（`breakerFailures`、`breakerConversionDrop`、`breakerMinMargin`）、`breakerReason`、`breakerAt`、`dailyLimit`、`maxChangePct`，因为规则的保护必须能查询与编辑；状态 `ACTIVE` / `PAUSED` / `BREAKER`。⑦ `PricingRuleRun`：`outcome` 取 `SUGGESTED` / `QUEUED` / `APPLIED` / `FAILED` / `BLOCKED` / `SKIPPED` / `DISMISSED`，`currentPrice` 是评估时的价、`rawPrice` 是策略算出的价、`suggestedPrice` 是收窄调幅后的价，`writeRunId` 指向 `ListingWriteRun`（`PRICE_PATCH`）。⑧ 改价**没有新建任务记录表**，复用 `ListingWriteRun`（新增种类 `PRICE_VALIDATE`、`PRICE_PATCH`，请求内容是 `{ sku, asin, price, currency, previousPrice, source, ruleRunId? }`，校验令牌是价格变更文字的哈希，有效期 30 分钟）。⑨ 回滚只删这八张表：前五张下一次同步会取回；护栏、规则与执行记录会丢失，亚马逊侧已生效的改价不受影响。

> **P4-12 实现说明（CR-087，迁移 `20261126010000_competitors`，含 `rollback.sql`）**：两张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql` 与 `tenant-seed.ts` 的 `SEED_OVERRIDES`）：`WatchedAsin`（我方设置，关注清单）、`CompetitorSnapshot`（亚马逊数据的只读副本）。**与上表的差异**：① `WatchedAsin` 按 `sellerAccountId`（店铺）而不是 `storeId` 关联，加 `marketplaceId`（美国站），`ownAsin` 不为空，**没有指定对应商品时存空字符串**（唯一键 `(tenantId, sellerAccountId, asin, ownAsin)` 才能起作用），`reason` 只有 `SEARCH_TERM`、`MANUAL`，多一个 `note`（来源是搜索词时是那个词，手工添加是备注，不超过 200 字）；② `CompetitorSnapshot` 不是“每次同步一条”，**只在可见属性变化、或距上一条超过 24 小时（心跳）时才写**，读取“最近一次”只看 3 天内的；字段比上表多 `currency`、`imageCount`、`rankClassificationId`、`rankClassificationName`，时间列叫 `observedAt` 不叫 `snapshotAt`，唯一键 `(sellerAccountId, marketplaceId, asin, observedAt)`；**字段为空表示这次没取到，不是 0，也不是“没有”**；③ `rank` 取展示组排名（没有就取第一个分类排名），分类名放在 `rankClassification*`，名次差只在两边是同一个分类时才算；④ `featuredStatus` 只有 `HAS_FEATURED`、`NONE`；⑤ 关注的竞品被移除且该店铺该 ASIN 不再有任何关注时，快照随之删除（没有关注就没有留存理由）；⑥ **标题、品牌、图片数量等“属性变化”的历史就是快照序列本身**，没有单独的变更表。

> **P4-13 实现说明（CR-088，迁移 `20261127010000_reviews_feedback`，含 `rollback.sql`）**：五张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql` 与 `tenant-seed.ts` 的 `SEED_OVERRIDES`）：`ReviewMetricSnapshot`（文件导入的评分与评分数）、`ReviewTopic`、`BrowseNodeReviewTrend`、`BrowseNodeReturnTrend`（客户反馈接口的只读副本）、`SolicitationRequest`（请求评价记录）。**与下表的差异**：① 五张表都按 `sellerAccountId`（店铺）关联，不是 `storeId`；② `ReviewMetricSnapshot` 的 `avgRating` 是 `Decimal(4,2)`（1 到 5 的星级，不是百分比），`sourceKind` 现在只有 `FILE_IMPORT`，`sourceFileId` **存的是导入批次编号**（评分文件本身不入库，只留 `sourceFileName` 文件名），同店铺同 ASIN 同采集日重复导入**覆盖**旧值；`avgRating`、`ratingCount` 都可为空，空是“这次文件没给”，不是 0；③ `ReviewTopic` 多 `rank`（该情感下名次 1 到 10）、`browseNodeId`、`browseNodeName`，`mentionRange`、`reviewCountBucket` 原样存接口给的区间文字，不估算；④ `BrowseNodeReviewTrend` / `BrowseNodeReturnTrend` 的 `rate` 是 0 到 1 的小数（接口给百分数时除以 100，超出 0 到 100 的丢弃不夹取），多 `browseNodeName`、`syncedAt`，`scope` 取 `ALL`（类目全部商品）、`TOP25`（前 25% 商品），**退货主题只到类目级，没有商品级退货主题**；⑤ `SolicitationRequest` 的状态多一个 `QUEUED`（已受理、还没发给亚马逊）：**受理时就先插入这一行，靠唯一键 `(sellerAccountId, amazonOrderId)` 保证“每单只请求一次”**，状态取 `QUEUED`、`REQUESTED`、`UNAVAILABLE`、`WINDOW_CLOSED`、`FAILED`，**只有 `FAILED` 可以再次受理**；另有 `marketplaceId`、`asins`（受理时订单里的 ASIN，用来算“请求后评分数增长”）、`sentAt`、`batchId`、`failureCode`、`updatedAt`。

> **P4-14 实现说明（CR-089，迁移 `20261128010000_aplus`，含 `rollback.sql`）**：四张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql` 与 `tenant-seed.ts` 的 `SEED_OVERRIDES`）：`AplusContent`、`AplusAsinRelation`、`AplusReviewEvent`（亚马逊数据的只读副本，加本地草稿）与 `AplusWriteRun`（写入记录，冻结表里没有，新增）。**与上表的差异**：① 三张表按 `sellerAccountId`（店铺）加 `marketplaceId` 关联，不是 `storeId`；`AplusContent` 唯一键 `(sellerAccountId, marketplaceId, contentReferenceKey)`，**本地新建、亚马逊还没创建成功的草稿 `contentReferenceKey` 为空**；`type` 叫 `contentType`（`EBC`、`EMC`），多 `locale`、`marketplaceId`、`amazonUpdatedAt`、`publishedAt`、`lastSyncedAt`、`createdBy`，`version` 是乐观锁（每次受理写入 +1，同步不改），`draftJson` 是 `{ contentModuleList }`（亚马逊返回或我方提交的模块结构原样）。② `AplusAsinRelation` 用 `contentId` 关联内容，唯一键 `(contentId, asin)`，多 `publishedAt`（发布记录里该 ASIN 的上线时间）与 `lastSeenAt`。③ `AplusReviewEvent` 用 `contentId`，唯一键 `(contentId, status, occurredAt)`，`source` 为 `SYNC` 或 `LOCAL`。④ `AplusWriteRun`：`kind`（`CREATE`、`UPDATE`、`ASSOCIATE`、`UPLOAD`、`SUBMIT`）、`status`（`QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`）、请求与结果快照、亚马逊返回的警告、失败码（只留“来源 + 状态码”，亚马逊原文不入库）；除上传外必须有 `contentId`（检查约束）。⑤ 回滚只删这四张表：前三张下一次同步会取回（本地未创建成功的草稿会丢失），写入记录会丢失，亚马逊侧已生效的修改不受影响。

## 九、定价、竞品、评价与内容

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `FeaturedOfferExpectedPrice` | 新增 | sellerSku Str；expectedPrice Dec；currency Str；resultStatus Str；observedAt Dt | `(storeId, sellerSku, observedAt)` | 否 | — | R | M-P4-11 | P4-11 |
| `CompetitiveSummarySnapshot` | 新增 | asin Str；featuredOfferBuyOption Json（推荐购买选项）；viewWeightMember Pct?；viewWeightNonMember Pct?；referencePrice Dec?；referencePriceType Str?；lowestPrice Dec?；observedAt Dt | `(storeId, asin, observedAt)` | 否 | — | R | M-P4-11 | P4-11 |
| `CompetitiveOffer` | 新增 | asin Str；offerKey Str（卖家编号哈希）；isOwn Bool；price Dec；shipping Dec?；condition Str；fulfillment Str；isFeatured Bool；observedAt Dt | `(storeId, asin, offerKey, observedAt)` | 否 | — | R | M-P4-11 | P4-11 |
| `BuyBoxSnapshot` | 新增 | asin Str；hasFeaturedOffer Bool；ownIsFeatured Bool；featuredPrice Dec?；lostReason Str?（价格不具竞争力）；observedAt Dt | `(storeId, asin, observedAt)` | 否 | — | R | M-P4-11 | P4-11 |
| `PriceGuardrail` | 新增 | scope Enum(店铺/类目/ASIN/SKU)；scopeRef Str；minPrice Dec?；maxPrice Dec?；minMarginPct Pct?；maxChangePct Pct?；enabled Bool | `(tenantId, storeId, scope, scopeRef)` | 否 | ✓ | R | M-P4-11 | P4-11 |
| `PricingRule` | 新增 | name Str；mode Enum(手动/自动)；strategy Enum(跟随推荐报价/目标毛利/竞品差额/…)；paramsJson Json；targetScopeJson Json；status Enum；lastEvaluatedAt Dt? | `(tenantId, storeId, name)` | 否 | ✓ | R | M-P4-11 | P4-11 |
| `PricingRuleRun` | 新增 | ruleId Str；sku Str；currentPrice Dec；suggestedPrice Dec；guardrailResult Str；executed Bool；writeRunId Str?；runAt Dt | `(ruleId, sku, runAt)` | 否 | — | R | M-P4-11 | P4-11 |
| `WatchedAsin` | 新增 | asin Str；ownAsin Str?；reason Str?；addedBy Str | `(tenantId, storeId, asin, ownAsin)` | 否 | — | R | M-P4-12 | P4-12 |
| `CompetitorSnapshot` | 新增 | asin Str；title Str?；brand Str?；price Dec?；featuredStatus Str?；fulfillment Str?；memberEligible Bool?；rank Int?；snapshotAt Dt | `(storeId, asin, snapshotAt)` | 否 | — | R | M-P4-12 | P4-12 |
| `ReviewMetricSnapshot` | 新增 | asin Str；avgRating Pct?；ratingCount Int?；distributionJson Json?；captureDate D；sourceKind Enum(文件导入)；sourceFileId Str；importedBy Str（字段级标注来源） | `(storeId, asin, captureDate)` | 否 | — | R | M-P4-13 | P4-13 |
| `ReviewTopic` | 新增 | asin Str；topicKey Str；sentiment Enum(正面/负面)；mentionRange Str?；reviewCountBucket Str?；snapshotDate D | `(storeId, asin, topicKey, snapshotDate)` | 否 | — | R | M-P4-13 | P4-13 |
| `BrowseNodeReviewTrend` | 新增 | browseNodeId Str；scope Enum(全部商品/前25%)；month D；topicKey Str；sentiment Str；rate Pct | `(storeId, browseNodeId, scope, month, topicKey)` | 否 | — | R | M-P4-13 | P4-13 |
| `BrowseNodeReturnTrend` | 新增 | browseNodeId Str；scope Str；month D；returnTopicKey Str；rate Pct | `(storeId, browseNodeId, scope, month, returnTopicKey)` | 否 | — | R | M-P4-13 | P4-13 |
| `SolicitationRequest` | 新增 | amazonOrderId Str；status Enum(已请求/不可用/窗口已过/失败)；requestedAt Dt；requestedBy Str；writeRunId Str? | `(storeId, amazonOrderId)`（每单一次） | 否 | — | R | M-P4-13 | P4-13 |
| `AplusContent` | 新增 | contentReferenceKey Str；name Str；type Str；status Enum(草稿/已提交/已批准/被拒/已发布)；asinCount Int；rejectionReason Str?；draftJson Json | `(storeId, contentReferenceKey)` | 否 | ✓ | R | M-P4-14 | P4-14 |
| `AplusAsinRelation` | 新增 | contentReferenceKey Str；asin Str | `(storeId, contentReferenceKey, asin)` | 否 | — | R | M-P4-14 | P4-14 |
| `AplusReviewEvent` | 新增 | contentReferenceKey Str；status Str；message Str?；occurredAt Dt | `(storeId, contentReferenceKey, status, occurredAt)` | 否 | — | R | M-P4-14 | P4-14 |

## 十、业务报告、品牌分析、近实时、促销与订阅省

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `SalesTrafficDaily` | 新增 | date D；granularity Enum(日/周/月)；orderedSales Dec；unitsOrdered Int；ordersCount Int；sessions Int；pageViews Int；buyBoxPct Pct；unitSessionPct Pct；refundRate Pct；claimsGranted Int；currency Str；source Enum(数据中心/报告补充) | `(storeId, date, granularity, source)` | **按月 `date`** | — | R | M-P4-01 | P4-01 |
| `SalesTrafficAsinDaily` | 新增 | date D；asin Str；asinGranularity Enum(父体/子体/SKU)；sku Str?；orderedSales Dec；units Int；sessions Int；pageViews Int；buyBoxPct Pct；unitSessionPct Pct；b2bSales Dec?；currency Str；source Enum | `(storeId, asin, asinGranularity, date, source)` | **按月 `date`** | — | R | M-P4-01 | P4-01 |
| `SalesTrafficDiff` | 新增（CR-076） | level Enum(日/父体/子体/SKU)；date D；asin Str（日级为空串）；sku Str（非 SKU 级为空串）；metric Enum(订购销售额/订购件数/会话数/页面浏览量)；kioskValue、reportValue、delta Dec；relativeDiff Dec?；detectedAt | `(tenantId, storeId, level, date, asin, sku, metric)` | 普通表 | — | R | M-P4-01 | P4-01 |
| `BrandSearchQueryPerformance` | 新增 | reportPeriod Enum(周/月/季)；periodStart D；asin Str；searchQuery Str；impressions/clicks/cartAdds/purchases 及各自份额（Int/Pct）；价格与配送中位数对比字段 | `(storeId, reportPeriod, periodStart, asin, searchQuery)` | 否 | — | R | M-P4-04 | P4-04 |
| `BrandSearchCatalogPerformance` | 新增 | reportPeriod；periodStart D；asin Str；impressions/clicks/cartAdds/purchases（Int）；点击、加购、购买份额（Pct） | `(storeId, reportPeriod, periodStart, asin)` | 否 | — | R | M-P4-04 | P4-04 |
| `BrandSearchTerm` | 新增 | reportPeriod；periodStart D；searchTerm Str；searchFrequencyRank Int；top3 点击 ASIN 与份额（Str/Pct）；top3 转化份额 | `(storeId, reportPeriod, periodStart, searchTerm, searchFrequencyRank)` | 否 | — | R | M-P4-04 | P4-04 |
| `BrandMarketBasket` | 新增 | reportPeriod；periodStart D；asin Str；pairedAsin Str；combinationPct Pct；purchaseRank Int | `(storeId, reportPeriod, periodStart, asin, pairedAsin)` | 否 | — | R | M-P4-04 | P4-04 |
| `BrandRepeatPurchase` | 新增 | reportPeriod；periodStart D；asin Str；orders Int；uniqueCustomers Int；repeatCustomersPct Pct；repeatRevenue Dec；repeatRevenuePct Pct | `(storeId, reportPeriod, periodStart, asin)` | 否 | — | R | M-P4-04 | P4-04 |
| `HourlySalesEvent` | 新增 | asin Str；hourStart Dt；units Int；salesAmount Dec；currency Str；orders Int；isLateArrival Bool | `(storeId, asin, hourStart)` | **按月 `hourStart`** | — | R | M-P2a-03 | P2a-03 |
| `HourlyTrafficEvent` | 新增 | asin Str；hourStart Dt；pageViews Int；sessions Int；buyBoxPct Pct? | `(storeId, asin, hourStart)` | **按月 `hourStart`** | — | R | M-P2a-03 | P2a-03 |
| `HourlyInventoryEvent` | 新增 | asin Str；hourStart Dt；availableQty Int | `(storeId, asin, hourStart)` | **按月 `hourStart`** | — | R | M-P2a-03 | P2a-03 |
| `AmazonNotificationEvent` | 新增 | notificationId Str；notificationType Str；receivedAt Dt；payloadObjectKey Str（消息体存对象存储，库内只存引用）；status Enum(已接收/处理中/已处理/失败/死信)；processedAt Dt?；errorCode Str? | `(tenantId, notificationId, receivedAt)` | **按月 `receivedAt`**（唯一键含分区列，只能在同一分区内去重；跨月去重见第二十节 G-08） | — | R | M-P1-28 | P1-28 |
| `NotificationSubscription` | 新增 | destinationId Str；notificationType Str；subscriptionId Str；filterJson Json?；status Enum(有效/失效/未创建)；lastReceivedAt Dt?；events24h Int；failures24h Int | `(storeId, destinationId, notificationType)` | 否 | — | R | M-P1-28 | P1-28 |
| `Promotion` | 新增 | promotionId Str；type Enum(秒杀/优惠券/价格折扣/满减)；name Str；status Str；startAt Dt；endAt Dt；validationIssuesJson Json；mappingId Str?（与表现报告关联） | `(storeId, promotionId)` | 否 | — | R | M-P4-05 | P4-05 |
| `PromotionItem` | 新增 | promotionId Str；asin Str；sku Str?；discountValue Dec?；status Str | `(storeId, promotionId, asin)` | 否 | — | R | M-P4-05 | P4-05 |
| `PromotionMetric` | 新增 | promotionId Str；asin Str；metricDate D；units Int；sales Dec；redemptions Int | `(storeId, promotionId, asin, metricDate)` | 否 | — | R | M-P4-05 | P4-05 |
| `CouponMetric` | 新增 | couponId Str；metricDate D；clips Int；redemptions Int；budgetSpent Dec；sales Dec | `(storeId, couponId, metricDate)` | 否 | — | R | M-P4-05 | P4-05 |
| `SubscribeSaveMetric` | 新增 | metricDate D；granularity Str；activeSubscribers Int；scheduledUnits Int；revenue Dec；shippedUnits Int；cancellationRate Pct | `(storeId, granularity, metricDate)` | 否 | — | R | M-P2a-07 | P2a-07 |
| `SubscribeSaveOffer` | 新增 | offerId Str；asin Str；sku Str；discountPct Pct；activeSubscribers Int；scheduledUnits30d Int；snapshotDate D | `(storeId, offerId, snapshotDate)` | 否 | — | R | M-P2a-07 | P2a-07 |

> **P4-05 实现说明（CR-080，迁移 `20261122010000_promotions`，含 `rollback.sql`）**：四张新表，不分区，行级安全与授权同其他租户表（已登记 `database/ops/regrant.sql`）。**与上表的差异**：① `Promotion` 的主键是系统 `id`，对应冻结键 `(storeId, promotionId)` 的唯一键是 `(sellerAccountId, promotionId)`；冻结的 `name` 实为 `title`，`validationIssuesJson` 实为 `issuesJson`（只存前 50 条，`errorCount`、`warningCount` 照常计全部）；促销类型、状态、`couponType`、`revisionStatus` 原样保存亚马逊的取值，不加检查约束（亚马逊新增取值时同步不能失败）；另有 `budgetType/Value/Currency`、`benefitJson`（促销级折扣力度与阶梯）、`feeJson`（亚马逊预览费率）、`selectionType/Id/Revision`、`itemCount`、`itemsForUpdatedAt`（取清单时的促销更新时间，与当前不一致才重取）、`itemsTruncated`；`startAt` 非空（亚马逊没给开始日期时依次退回创建时间、更新时间）；`itemCount` 为空表示“清单还没取回”，不是 0。② `PromotionItem` 唯一键是 `(promotionRowId, asin, sku)`（`asin`、`sku` 缺失时存空串，保证唯一键可用）；冻结的 `discountValue`、`status` 拆成 `benefitType`、`discountType`、`percentOff`、`amountOff`、`fixedPrice`、`perCustomerUses`、预算与 `issuesJson`；每次重取清单先删后写。③ `PromotionMetric` 唯一键是 `(tenantId, sellerAccountId, mappingId, asin, metricDate)`：冻结写 `promotionId`，实际存报告里的映射编号（对应促销的 `trackingId`），因为报告里没有可靠的促销编号；`CouponMetric` 同理，`mappingId` 代替 `couponId`。数量与金额列可空：报告没给的列是空，不是 0；检查约束保证计数非负。④ 回滚只删这四张表，下一次同步与报告导入会重新取回，不丢失我方录入的任何内容。

## 十一、库存与上游仓储

> **P2a-05 实施补充（CR-028）**：① 库存数量列（`sellable` 等）与规划/库龄各数值列一律**可空**：报告没给的列保持空，不写 0（硬规则「没有数据不显示成 0」）；② 所有表另带来源字段 `sourceUpdatedAt`、`syncedAt`、`sourceReportJobId`、`sourceRecordId`（G-08）；③ `InventoryDailySnapshot.source` 取值 `MYI_ALL / MYI_UNSUPPRESSED / AFN / RESERVED / STRANDED / API`（CHECK 约束），`fnsku` 缺省存空串；④ `InventoryPlanningSnapshot` 另有 `removalReportQty / removalReportReason / removalReportUpdatedAt` 三列专存 R-17，不覆盖 R-08 自带的建议移除量；⑤ `RemovalShipment.shipmentId` 官方报告没有此列，取运单号，无运单号取 `NOTRACK-发货日期`；⑥ `StorageCapacitySnapshot` 的 `limitQty / usedQty` 暂不写（报告只给利用率），保持空；⑦ `FbaInventoryRecord.source` 取值 `API / NOTIFICATION`；⑧ 旧表 `InventorySnapshot` 已迁入 `InventoryDailySnapshot`（`source=API`），旧表保留到 P5-12，**已于 P5-12 删除**（迁移 `20261207010000_drop_inventory_snapshot`，删除前再补迁一遍未迁过的行，回滚只重建空表，见 CR-103）。

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `FbaInventoryRecord` | 修改 | 去掉固定阈值判断列；新增 `source`、`realtimeSyncedAt` | 现有 | 否 | — | R | M-P2a-05 | P2a-05 |
| `InventoryDailySnapshot` | 新增 | snapshotDate D；sku Str；fnsku Str；asin Str；sellable/inbound/reserved/unsellable/researching Int；reserved 拆分（预留客户订单/转运/处理中）Int；stranded Int；strandedReason Str?；source Enum(MYI全部/MYI未抑制/AFN/预留/滞留/接口) | `(storeId, sku, fnsku, snapshotDate, source)` | **按月 `snapshotDate`** | — | R | M-P2a-05 | P2a-05 |
| `InventoryLedgerEntry` | 新增 | eventDate D；fnsku Str；asin Str；sku Str；fulfillmentCenter Str；disposition Str；reasonCode Str；referenceId Str?；quantity Int；rowHash Str | `(storeId, rowHash)` | 否（按月分区列表中未列，量大时评估；见 G-09） | — | R | M-P2a-05 | P2a-05 |
| `InventoryLedgerSummary` | 新增 | date D；fnsku Str；fulfillmentCenter Str；disposition Str；startingQty Int；receipts Int；customerShipments Int；customerReturns Int；vendorReturns Int；transfers Int；found Int；lost Int；damaged Int；disposed Int；other Int；endingQty Int；unknownEvents Int | `(storeId, date, fnsku, fulfillmentCenter, disposition, aggregation)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `InventoryAgeSnapshot` | 新增 | snapshotDate D；sku Str；fnsku Str；age0to90/91to180/181to270/271to365/365plus Int；ageSurchargeEstimate Dec? | `(storeId, sku, fnsku, snapshotDate)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `InventoryPlanningSnapshot` | 新增 | snapshotDate D；sku/fnsku/asin Str；库龄分段、超额、7/30/60/90 天销量、建议动作、建议售价与促销天数、建议移除量（含来自 R-17 的推荐移除列）、低库存水平费、最低库存水平、历史可售天数、季节性、建议发货量与日期、库龄附加费分段预估、长期仓储费、预留拆分（共 02 章 2.3 所列全部字段；报告原始列按样例文件补齐） | `(storeId, sku, fnsku, snapshotDate)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `StorageCapacitySnapshot` | 新增 | snapshotDate D；storageType Str；limitQty Dec?；usedQty Dec?；utilizationPct Pct?；sourceKind Enum(报告/文件导入)；sourceFileId Str? | `(storeId, snapshotDate, storageType)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `StorageFeeRecord` | 新增 | chargeMonth D；feeKind Enum(月度仓储/超限/长期仓储/利用率附加)；fnsku Str；fulfillmentCenter Str?；amount Dec；currency Str；volume Dec?；rate Dec? | `(storeId, chargeMonth, fnsku, fulfillmentCenter, feeKind)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `RemovalOrder` | 新增 | orderId Str；type Enum(退回/弃置)；status Str；requestDate D；sku/fnsku Str；requestedQty/shippedQty/disposedQty/cancelledQty Int；fee Dec? | `(storeId, orderId, sku, fnsku, disposition)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `RemovalShipment` | 新增 | orderId Str；shipmentId Str；sku/fnsku Str；carrier Str?；trackingNumber Str?；shippedQty Int；shipDate D? | `(storeId, orderId, shipmentId, sku, fnsku)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `RemovalReceipt` | 新增 | removalOrderId Str；sku Str；receivedQty Int；sellableQty Int；damagedQty Int；note Str?；receivedAt D；receivedBy Str | `(storeId, removalOrderId, sku, receivedAt)`（`tenantId` 为第一列，CHECK：数量非负且良品 + 损坏 ≤ 实收；迁移 `20261023030000_removal_receipt`） | 否 | — | R | M-P2a-09 | P2a-09 |
| `AmazonRestockRecommendation` | 新增 | snapshotDate D；sku/fnsku/asin Str；recommendedQty Int；recommendedShipDate D?；alertReason Str?；daysOfSupply Int? | `(storeId, sku, fnsku, snapshotDate)` | 否 | — | R | M-P2a-05 | P2a-05 |
| `AwdInventory` | 新增 | snapshotDate D；sku Str；onhandQty Int；availableQty Int；reservedForReplenishment Int；inboundToAwdQty Int；outboundToFbaInTransit Int；expiryDate D? | `(storeId, sku, snapshotDate)` | 否 | — | R | M-P2a-08 | P2a-08 |
| `AwdInboundOrder` | 新增 | orderId Str；status Str；createdAt Dt；expectedUnits Int；receivedUnits Int；packageDeliveryMode Str?；draftJson Json?（我方草稿） | `(storeId, orderId)` | 否 | ✓（草稿编辑） | R | M-P2a-08 | P2a-08 |
| `AwdInboundShipment` | 新增 | shipmentId Str；orderId Str；status Str；carrier Str?；trackingNumber Str?；destination Str | `(storeId, shipmentId)` | 否 | — | R | M-P2a-08 | P2a-08 |
| `AwdShipmentItem` | 新增 | shipmentId Str；sku Str；expectedQty Int；receivedQty Int；expiryDate D?；prepInfoJson Json? | `(storeId, shipmentId, sku)` | 否 | — | R | M-P2a-08 | P2a-08 |

## 十二、补货、采购、成本与头程

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `Forecast` | 新增 | sku Str；forecastDate D；horizonDays Int；method Str；p10/p50/p90 Pct 或 Dec；modelVersion Str；inputsHash Str | `(storeId, sku, forecastDate, horizonDays, modelVersion)` | 否 | — | R | M-P2a-07 | P2a-07 |
| `ReplenishmentPolicy` | 新增 | level Enum(企业/品类/SKU)；levelRef Str；leadTimeDays Int；safetyDays Int；coverageDays Int；moq Int?；minOrderValue Dec?；channelSplitJson Json；effectiveFrom D | `(tenantId, storeId, level, levelRef, effectiveFrom)` | 否 | ✓ | R | M-P2a-07 | P2a-07 |
| `ReplenishmentBatch` | 新增 | batchNo Str；status Enum(计算中/待审/已确认/已生成草稿/已结束)；snapshotJson Json（计算快照）；policyVersions Json；computedAt Dt | `(tenantId, storeId, batchNo)` | 否 | — | R | M-P2a-07 | P2a-07 |
| `ReplenishmentRecommendation` | 新增 | batchId Str；sku Str；recommendedQty Int；channel Enum(采购/入仓/上游仓储)；dueDate D；confidence Pct；calcStepsJson Json（8 步公式展开）；amazonRestockQty Int?；diffReason Str? | `(batchId, sku, channel)` | 否 | — | R | M-P2a-07 | P2a-07 |
| `ReplenishmentAction` | 新增 | recommendationId Str；action Enum(采纳/调整/忽略/生成采购单草稿/生成入仓计划草稿/生成上游仓储订单草稿)；finalQty Int?；targetDocType Str?；targetDocId Str?；reason Str?；actorId Str | `id` | 否 | — | R | M-P2a-07 | P2a-07 |
| `ReplenishmentOutcome` | 新增 | recommendationId Str；evaluatedAt D；forecastQty Int；actualQty Int；errorPct Pct；stockoutDays Int；excessUnits Int | `(recommendationId, evaluatedAt)` | 否 | — | R | M-P2a-07 | P2a-07 |
| `PurchaseOrder` | 修改 | 新增 approvalStatus Enum；paymentStatus Enum；receivedQtyTotal Int；`version Int` | 现有 | 否 | ✓（P1-15 先加版本列） | R | M-P1-15、M-P2a-10 | P1-15、P2a-10 |
| `PurchaseReceipt` | 新增 | purchaseOrderId Str；receiptNo Str；receivedAt Dt；lines Json（SKU、数量、批次）；receivedBy Str | `(tenantId, receiptNo)` | 否 | — | R | M-P2a-10 | P2a-10 |
| `QualityInspection` | 新增 | purchaseOrderId Str；receiptId Str?；result Enum(合格/让步/不合格)；sampleQty Int；defectQty Int；note Str?；inspectorId Str | `id` | 否 | — | R | M-P2a-10 | P2a-10 |
| `PurchasePayment` | 新增 | purchaseOrderId Str；kind Enum(定金/尾款/其他)；amount Dec；currency Str；paidAt D?；status Enum；voucherAttachmentId Str? | `id` | 否 | — | R | M-P2a-10 | P2a-10 |
| `PurchaseApproval` | 新增 | purchaseOrderId Str；step Int；approverId Str；decision Enum(待审/通过/驳回)；comment Str?；decidedAt Dt? | `(purchaseOrderId, step)` | 否 | — | R | M-P2a-10 | P2a-10 |
| `Attachment` | 新增 | entityType Str；entityId Str；fileName Str；contentType Str；objectKey Str；sizeBytes Int；sha256 Str；uploadedBy Str | `(tenantId, entityType, entityId, sha256)` | 否 | — | R | M-P2a-10 | P2a-10 |
| `StockCount` | 新增 | warehouseId Str；status Enum(盘点中/待审/已过账)；countedAt D；linesJson Json；approvedBy Str? | `(tenantId, warehouseId, countedAt)` | 否 | ✓ | R | M-P2a-10 | P2a-10 |
| `Supplier` | 修改 | 新增 onTimeRate Pct；qualityPassRate Pct；avgLeadDays Int；rating Str（由系统计算，标注口径） | 现有 | 否 | — | R | M-P2a-10 | P2a-10 |
| `Warehouse` | 修改 | 新增 kind Enum(国内仓/头程中转仓)；costMethod Enum | 现有 | 否 | — | R | M-P2a-10 | P2a-10 |
| `InventoryMovement` | 修改 | 新增 lockedForShipment Int；reasonCode Str；refDocType Str；refDocId Str | 现有 | 否 | — | R | M-P2a-10 | P2a-10 |
| `CostVersion` | 新增 | sku Str；versionNo Int；effectiveFrom D；currency Str；unitProductCost Dec；unitFirstMileCost Dec；unitOtherCost Dec；source Enum(采购收货/头程分摊/手工/文件导入)；status Enum(草稿/生效/已替换)；sourceDocId Str? | `(tenantId, storeId, sku, versionNo)`；生效期不重叠 | 否 | ✓ | R | M-P2a-10 | P2a-10 |
| `LandedCostAllocation` | 新增 | firstMileShipmentId Str；sku Str；allocatedAmount Dec；method Enum(体积/重量/货值/件数)；costVersionId Str? | `(firstMileShipmentId, sku, method)` | 否 | — | R | M-P2a-11 | P2a-11 |
| `FreightForwarder` | 新增 | name Str；contact Str?；defaultMode Str?；status Str | `(tenantId, name)` | 否 | — | R | M-P2a-11 | P2a-11 |
| `FirstMileShipment` | 新增 | forwarderId Str；waybillNo Str；mode Enum(海运/空运/快递)；containerNo Str?；shipDate D?；etaPort D?；ataPort D?；customsStatus Str；etaDelivery D?；ataDelivery D?；estimatedCost Dec；actualCost Dec?；linkedInboundShipmentIds Str[] | `(tenantId, forwarderId, waybillNo)` | 否 | ✓ | R | M-P2a-11 | P2a-11 |
| `FirstMileCost` | 新增 | shipmentId Str；item Str（运费/关税/清关/附加）；amount Dec；currency Str；incurredAt D；invoiceAttachmentId Str? | `id` | 否 | — | R | M-P2a-11 | P2a-11 |
| `FirstMileMilestone` | 新增 | shipmentId Str；milestone Str；occurredAt Dt；location Str?；source Enum(手工/文件导入/接口) | `(shipmentId, milestone, occurredAt)` | 否 | — | R | M-P2a-11 | P2a-11 |
| `TransitTimeStat` | 新增 | forwarderId Str；mode Str；periodMonth D；sampleCount Int；p50Days Int；p90Days Int | `(tenantId, forwarderId, mode, periodMonth)` | 否 | — | R | M-P2a-11 | P2a-11 |

> **P2a-06 提前建表（CR-029）**：`ReplenishmentPolicy` 由 P2a-06 先建（追加式版本表：`(tenantId, level, levelRef, versionNo)` 唯一，旧版本不改写，`expectedVersionNo` 乐观并发），P2a-07 已在其上扩展（CR-030，见下方说明）。

> **P2a-07 实现说明（CR-030，迁移 `20261023010000_replenishment_engine`，含 `rollback.sql`、RLS）**：本节上表为冻结时的设想，实际落地如下，以代码（`schema.prisma`）为准。
> - `ReplenishmentPolicy`：在 P2a-06 的表上新增 9 列（全部可空，旧版本为空 → 该范围内 SKU 提示“补货参数尚未配置”）：`productionDays`、`domesticDays`、`receivingDays`、`serviceLevel`、`transportPreference`、`transportOptionsJson`（`[{mode, transitDays, unitCost}]`）、`casePackQty`、`moq`、`minOrderValue`。三级（`TENANT/ALL`、`CATEGORY/<productType>`、`SKU/<sku>`），下级整行覆盖上级；**没有按店铺维度**；唯一键沿用 `(tenantId, level, levelRef, versionNo)`，没有 `channelSplitJson`、`storeId`。
> - `ReplenishmentBatch`：`batchNo`、`status`、`today`、`storeIdsJson`、`policyVersionsJson`、`snapshotJson`（冻结的输入与数据时间）、`skuTotal`、`recommendedCount`、`computedAt`、`computedBy`；唯一键 `(tenantId, batchNo)`。
> - `ReplenishmentRecommendation`：唯一键 `(batchId, sellerAccountId, sku, channel)`；`calcStepsJson`（8 步）、`shipmentsJson`（按运输方式拆分的发运批次）、`capitalAmount`（恒为空：商品成本未接入）、`amazonRestockQty/amazonShipDate/diffReason`。
> - `ReplenishmentAction`：追加式；`status` 取 `DONE / PENDING_TARGET`（入仓计划、上游仓储草稿的目标模块未上线，只登记，不伪造单据编号）。
> - `ReplenishmentOutcome`：`(recommendationId, evaluatedAt)` 唯一；`errorPct`、`excessUnits` 可空（实际为 0、没有库存记录时不当 0）。
> - 新增 `SubscribeSaveMetric`（`(tenantId, sellerAccountId, granularity, metricDate)`）、`SubscribeSaveOffer`（`(tenantId, sellerAccountId, sku, snapshotDate)`）、`EconomicsSimulationRun`（每次模拟一条，`resultJson` 累计行结果）。
> - **没有建 `Forecast` 表**：需求预测按需计算并冻结在批次快照里，没有独立落表（见 CR-030）。

> **P2a-08 实现说明（CR-031，迁移 `20261023020000_awd`，含 `rollback.sql`、RLS、`regrant.sql`、`tenant-seed.ts`）**：上表 4 张 AWD 表实际落地如下，以代码（`schema.prisma`）为准。
> - 全部带 `tenantId`、`sellerAccountId`（上表写的 `storeId` 即此列），唯一键含租户：`AwdInventory (tenantId, sellerAccountId, sku, snapshotDate)`、`AwdInboundShipment (tenantId, sellerAccountId, shipmentId)`、`AwdShipmentItem (tenantId, sellerAccountId, shipmentId, sku)`；`AwdInboundOrder` 的 `(tenantId, sellerAccountId, orderId)` 与 `(tenantId, sellerAccountId, externalReferenceId)` 各有唯一索引（Postgres 的空值互不冲突，所以多条本地草稿可以并存），另有 CHECK：`orderId` 为空时状态只能是 `LOCAL_DRAFT / CREATE_FAILED / CANCELLED`。
> - **`AwdInboundOrder.orderId` 可空**：本地草稿与提交中的订单还没有亚马逊编号；`status` 取 `LOCAL_DRAFT / CREATE_FAILED / DRAFT / VALIDATING / CONFIRMED / CLOSED / EXPIRED / CANCELLED`（有 CHECK），`pendingAction` 取 `CREATE / UPDATE / CONFIRM / CANCEL / TRANSPORT`（后台操作在途标记，在途时不接受新操作）。另有 `externalReferenceId`（我方参考号 `NOVA-<12 位>`）、`originAddressJson`、`packagesJson`、`preferredRegion`、`destinationRegion`、`note`、`lastErrorCode/Message`、`version`（乐观锁）、`createdBy`。
> - `AwdInventory` 的各数量列、`AwdShipmentItem` 的预计与接收数量**全部可空**（亚马逊没返回就是空，不当 0）；`expirationJson` 存多个到期批次。`AwdInboundShipment` 增 `labelStatus`、`labelObjectKey`、`labelFetchedAt`（标签 PDF 存文件存储，只存对象键）。
> - 队列与新鲜度：任务类型 `AWD_SYNC`（来源键 `awd.api`，每 2 小时，阈值 120 分钟）、`AWD_ORDER_WRITE`、`AWD_LABELS`；新增队列域 `awd`（`packages/workflow` 拓扑与种类已登记）；写入开关 `sw.awd.order.write`。
> - 补货侧：`to-awd-draft` 现在建真实的 `LOCAL_DRAFT` 订单（`draftJson` 记来源批次与建议），`ReplenishmentAction.targetDocType = AWD_ORDER`、`targetDocId` 指向订单行；`to-inbound-draft`（入仓计划，P2a-12）当时仍只登记（`PENDING_TARGET`）；P6-08 起该路由移除，由批次级 `to-inbound-drafts` 生成真实草稿（`targetDocType = INBOUND_PLAN`、`DONE`），旧的 `PENDING_TARGET` 记录被同一建议后来的 `DONE` 动作取代（`effectiveActions`）。

> **P2a-09 实现说明（CR-032，迁移 `20261023030000_removal_receipt`，含 `rollback.sql`、RLS、`regrant.sql`）**：
> - 新表 `RemovalReceipt`：`tenantId`、`sellerAccountId`、`removalOrderId`、`sku`、三个数量、`note`、`receivedAt`（日期）、`receivedBy`；唯一键 `(tenantId, sellerAccountId, removalOrderId, sku, receivedAt)`，同一天同一 SKU 再登记即更正；CHECK `RemovalReceipt_qty_check`（数量非负、良品 + 损坏 ≤ 实收）。**没有 `expectedQty` 列**：应收取 `RemovalOrder` 上该 SKU 的已发货数量，避免两份数字对不上。
> - `StorageCapacitySnapshot` 加 `sourceFileName`、`importedBy`（文件导入时填，报告来源为空），用来逐项标注限额来源；原设计的 `sourceFileId` 仍未启用（P2a-09 没有文件库，按文件名标注）。导入只写 `sourceKind = FILE_IMPORT` 的行，与 `REPORT` 行同日同类型冲突时拒绝，不覆盖。
> - `InventoryLedgerEntry` 仍不分区，没有做压测（G-09 保持开放）。
> **P2a-10 实现说明（CR-033，迁移 `20261024010000_procurement`，含 `rollback.sql`、RLS）**：上表为冻结时的设想，实际落地以 `schema.prisma` 为准，差异如下。
> - `Supplier` 加 `version`、`metricsAt`（指标重算时间）与四个指标列（空值表示“样本不足”，不是 0）；`PurchaseOrder` 加 `submittedAt`、`orderedAt`、`completedAt`，状态、审批状态、付款状态都有 CHECK；
> - `Warehouse` 只加 `costMethod`（`WEIGHTED_AVERAGE`、`FIFO`），没有新增 `kind` 取值：国内仓沿用 `kind = DOMESTIC`，头程中转仓留给 P2a-11；
> - `InventoryMovement` 加 `reasonCode`、`lockedForShipment`、`unitCost`、`currency`、`createdBy`；关联单据沿用已有的 `referenceType`、`referenceId`，没有新增 `refDocType`、`refDocId`；
> - 新表 `PurchaseReceipt`（收货单，`(tenantId, receiptNo)` 唯一）、`QualityInspection`、`PurchasePayment`（计划与已付同一张表，`PAID` 必须有 `paidAt`）、`PurchaseApproval`（`(purchaseOrderId, step)` 唯一）、`Attachment`（`(tenantId, entityType, entityId, sha256)` 唯一，同一对象内容去重）、`StockCount`（`(tenantId, warehouseId, countedAt)` 唯一，同仓同日一张）、`CostVersion`（`(tenantId, sku, versionNo)` 与 `(tenantId, source, sourceDocId, sku)` 唯一，收货生成的草稿同一采购单同一 SKU 只有一条）；
> - `LandedCostAllocation` 及头程相关表仍归 P2a-11，本包没有建。

> **P2a-11 实现说明（CR-034，迁移 `20261024020000_first_mile`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`）**：上表 M-P2a-11 的 5 张表加 1 张冻结时没有的明细表，共 7 张，差异如下。
> - **新增 `FirstMileShipmentItem`**（运单明细：`sku`、`purchaseOrderId?`、`quantity`、`cartons?`、`volumeCbm?`、`weightKg?`、`goodsValue?`，`(shipmentId, sku)` 唯一）：冻结的运单表没有 SKU 明细，而“关联 SKU”“按体积、重量、货值分摊”“出库”都需要它；缺体积、重量或货值的口径不能用于分摊（页面写明缺什么），不补零。
> - `FirstMileShipment`：`estimatedCost` 改为**可空**（没填就是没有，不当 0）；**没有 `actualCost` 列**，实际费用是 `FirstMileCost` 的合计（单一事实来源）；加 `currency`（默认 USD，同一运单的费用必须同币种，已有费用后不能改币种）、`warehouseId?`（出库的国内仓）、`outboundAt?`（出库时间，非空即已出库）、`note`、`version`（乐观锁）、`createdBy`；阶段（待发运、运输中、已到港、已交付）按实际日期推出，不存列；`customsStatus` 取 `NOT_STARTED / IN_PROGRESS / CLEARED / HELD`；`linkedInboundShipmentIds` 创建与修改时校验这些货件已在入仓货件同步数据里。
> - `FirstMileCost`：**没有 `invoiceAttachmentId`**，发票走通用 `Attachment`（`entityType = FIRST_MILE`）；`item` 取 `FREIGHT / CLEARANCE / DUTY / DELIVERY / SURCHARGE`，金额必须大于 0（CHECK）。
> - `FirstMileMilestone`：加 `note`、`createdBy?`（文件导入的为空）；`source` 取 `MANUAL / FILE_IMPORT / API`，`API` 为 Tracking API 预留，本包不写。
> - `LandedCostAllocation`：加 `quantity`、`currency`、`createdBy`；`method` 增加 `QTY`（按件数，不需要任何额外数据）；唯一键仍是 `(firstMileShipmentId, sku, method)`，“一张运单同一时间只有一种口径”由服务层保证（已有分摊时拒绝再分摊，要换口径先撤销）。分摊同时为每个 SKU 生成一条 `CostVersion` 草稿（`source = FIRST_MILE_ALLOCATION`，`unitFirstMileCost` = 分摊额 ÷ 数量，`sourceDocId` = 运单编号），撤销时删除；已生效的版本不能撤销。
> - `TransitTimeStat`：按“货代 × 运输方式 × 交付月份”存样本数与 p50、p90，在运单创建或修改的同一事务里按该货代与运输方式删除重建（派生缓存，不是事实来源；页面上的总体 p50、p90 每次读取时直接由运单现算，月度点读这张表）；统计口径与最少样本数（3 单）在契约 `TRANSIT_BASIS`、`TRANSIT_MIN_SAMPLES`。
> - `Warehouse.kind` 仍没有新增“头程中转仓”取值（本包不涉及中转仓）；`InventoryMovement` 新增流水类型取值 `FIRST_MILE_OUT`（`referenceType = FIRST_MILE`）；`Attachment.entityType` 新增 `FIRST_MILE`。

> **P2b-14 实现说明（CR-052，迁移 `20261107010000_cost_versions`，含 `rollback.sql`）**：
> - `CostVersion` 加 `unitDutyCost`（单位关税，可空）、`note`、`version`（乐观锁，默认 1）、`createdBy`、`activatedBy`、`activatedAt`、`replacedById`、`replacedAt`；加索引 `CostVersion_sku_status_idx(tenantId, sku, status)`；**没有店铺归属列**（冻结表里写的 `storeId` 实际没有，成本版本是租户内按 SKU 的，唯一键是 `(tenantId, sku, versionNo)` 与 `(tenantId, source, sourceDocId, sku)`）；
> - 检查约束：`version >= 1`、四项成本不能为负、至少有一项成本（`CostVersion_version_check`、`CostVersion_amount_check`、`CostVersion_any_cost_check`）；
> - 状态 `DRAFT`、`ACTIVE`、`REPLACED`：**“生效期不重叠”没有实现为约束**——不同生效日期的 `ACTIVE` 版本并存（利润按销售日取不晚于当天的最新一层），只有同一生效日、同一成本项的旧版本被标 `REPLACED` 并写 `replacedById`、`replacedAt`；
> - 来源 `PURCHASE_RECEIPT`、`FIRST_MILE_ALLOCATION`（系统草稿，只能改关税、其他成本、生效日与备注，不能丢弃）、`MANUAL`、`FILE_IMPORT`（文件导入的 `sourceDocId` 是 `IMP<8 位十六进制>:<行号>`）；
> - 回滚会丢掉关税、备注与生效留痕；回滚前请先导出，只有关税而没有其他成本的版本回滚后四项成本全为空，重新升级会违反 CostVersion_any_cost_check，要先处理这些行。

> **P2b-15 实现说明（CR-053，迁移 `20261108010000_finance_policy`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`）**：`FinancePolicyVersion` 与冻结表（本文件第 77 行）的差异——
> - 列：`versionNo`（租户内递增，唯一键 `(tenantId, versionNo)`，**不是**冻结的 `(tenantId, effectiveFrom)`：同一生效日可以有多个版本）、`effectiveFrom`、`revenueRecognition`（`ORDERED`/`SHIPPED`/`SETTLED`）、`inventoryCostMethod`（`FIFO`/`MOVING_AVG`/`MONTH_AVG`，**三种**，冻结只写加权平均与先进先出，沿用利润模块已有的三种）、`fxRateRule`（目前只有 `SALE_DAY`）、`adsAllocationMode` 与 `storeFeeAllocation`（`BY_SALES`/`BY_UNITS`）、`status`、`reason`、`version`（乐观锁）、`createdBy`、`decidedBy`（冻结的 `approvedBy`）、`decidedAt`、`decisionComment`、`replacedAt`；
> - 状态 `PENDING` 待审批、`ACTIVE` 生效中、`REPLACED` 已替换、`REJECTED` 已驳回或撤回（冻结只有草稿、生效、已替换）；同一租户同一时间至多一个 `PENDING`，由服务层保证；
> - **没有 `feeCategoryMapJson`**：费用类别映射本包没有消费方，没有建这一列；
> - 检查约束：状态与各口径取值在枚举内、`version >= 1`、`versionNo >= 1`；索引 `(tenantId, status)`；
> - 回滚直接删表，**会丢掉全部口径版本与审批留痕**；企业设置 `finance.inventoryCosting` 不受影响（它是另一张表里的值，审批通过时被同步写入）。

## 十三、入仓与差异

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `FbaInboundPlan` | 修改 | 新增 stage Enum(草稿/资格预检/装箱/分仓/运输/已确认/已发货/接收中/完成/已取消)；prepOwner 固定 `卖家`；labelOwner 固定 `卖家`（检查约束：只允许卖家） | 现有 | 否 | — | R | M-P2a-12 | P2a-12 |
| `FbaInboundShipment` | 修改 | 明细拆出到 `ShipmentItem`；新增 receivedFirstAt Dt?；receivedDoneAt Dt?；carrier Str?；trackingNumber Str? | 现有 | 否 | — | R | M-P2a-12 | P2a-12 |
| `InboundPlanItem` | 新增 | planId Str；sku Str；fnsku Str；asin Str；quantity Int；expiry D?；prepInstruction Str?（固定卖家处理） | `(planId, sku)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `InboundEligibilityCheck` | 新增 | planId Str；sku Str；program Str；eligible Bool；reasonCodes Str[]；checkedAt Dt | `(planId, sku, program, checkedAt)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `PackingOption` | 新增 | planId Str；packingOptionId Str；status Str；fees Dec?；discounts Dec?；expiresAt Dt?；confirmed Bool | `(planId, packingOptionId)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `PackingGroup` | 新增 | packingOptionId Str；packingGroupId Str；itemsJson Json | `(packingOptionId, packingGroupId)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `Box` | 新增 | planId Str；boxId Str；packingGroupId Str?；weight Dec；lengthW/H Dec；contentJson Json；labelStatus Str | `(planId, boxId)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `PlacementOption` | 新增 | planId Str；placementOptionId Str；shipmentCount Int；fees Dec；discounts Dec；totalCost Dec（含仓间成本推荐）；expiresAt Dt；status Str；confirmed Bool | `(planId, placementOptionId)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `TransportOption` | 新增 | shipmentId Str；transportOptionId Str；carrier Str；mode Str；cost Dec；etaJson Json；status Str；confirmed Bool | `(shipmentId, transportOptionId)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `DeliveryWindow` | 新增 | shipmentId Str；windowStart Dt；windowEnd Dt；availabilityExpiresAt Dt；confirmed Bool | `(shipmentId, windowStart)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `ShipmentItem` | 新增 | shipmentId Str；sku Str；fnsku Str；shippedQty Int；receivedQty Int；discrepancyQty Int | `(shipmentId, sku)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `TrackingEvent` | 新增 | shipmentRef Str；trackingNumber Str；milestone Str；occurredAt Dt；location Str?；source Enum(接口/推送/文件导入/手工) | `(tenantId, trackingNumber, milestone, occurredAt)` | 否 | — | R | M-P2a-12 | P2a-12 |
| `ReceivingDiscrepancy` | 新增 | shipmentId Str；sku Str；kind Enum(少收/多收/损坏/不合规)；qty Int；problemType Str?；firstSeenAt Dt；resolvedAt Dt?；evidenceAttachmentIds Str[] | `(shipmentId, sku, kind, problemType)` | 否 | — | R | M-P2a-13 | P2a-13 |
| `LabelPrintJob` | 新增 | planId Str；kind Enum(箱标签/商品标签)；status Enum；objectKey Str?；requestedBy Str | `id` | 否 | — | R | M-P2a-12 | P2a-12 |
| `InboundOperation` | 新增 | planId Str；operationId Str；operation Str；status Enum(进行中/成功/失败)；problemsJson Json?；startedAt Dt；finishedAt Dt?；writeRunId Str? | `(storeId, operationId)` | 否 | — | R | M-P2a-12 | P2a-12 |

> **P2a-12 实现说明（CR-035，迁移 `20261024030000_inbound_plan`）**：与上表的差异——`Box` 实际表名 `InboundBox`（避免与其它“箱”概念混淆），装箱方案与分仓方案多 `currency`、`shippingConfigs`、`status` 等亚马逊原样字段；`PlacementOption` 不存 `totalCost`（总成本由费用、折扣与计划上的估算参数现算，不存列，见 `placementTotalCost`）；`PlacementOption`、`TransportOption`、`DeliveryWindow` 多 `planId`（便于按计划查询与 RLS），`TransportOption` 的唯一键为 `(planId, shipmentId, transportOptionId)`；`InboundOperation` 多 `tenantId`、`sellerAccountId`、`paramsJson`（操作期间的提交参数，运输联系人在操作结束后清除）、`errorCode`、`syncJobId`，唯一键 `(sellerAccountId, operationId)`；`FbaInboundPlan` 多 `pendingOp`（有操作在途）、`version`（乐观锁）、`voidDeadlineAt`、`shippingMode`、`prepCost`、`labelCost`（卖家自理费用，选填）、`estimateJson`（分仓总成本的估算参数）、`sourceType/sourceRefId`、`lastErrorCode/Message`，`stage` 为 13 个取值（草稿、资格预检通过、已创建、装箱已确认、箱内物品已提交、分仓已确认、运输已确认、标签已打印、已发货、接收中、有差异、已完成、已取消），而不是冻结里的 10 个；`prepOwner`、`labelOwner` 有 CHECK 约束只允许 `SELLER`。`FbaInboundShipment` 多 `shipmentConfirmationId`、`boxCount`、`trackingJson`、`selectedTransportOptionId`、`selectedWindowId`。`ReceivingDiscrepancy` 仍属 P2a-13，未建。

> **P2a-13 实现说明（CR-036，迁移 `20261024040000_receiving_discrepancy`）**：新增 `ReceivingDiscrepancy` 与 `ReimbursementOpportunity`（均为租户表，RLS、`regrant.sql`、`SEED_OVERRIDES` 已补）。与上表的差异——`ReceivingDiscrepancy`：`kind` 只有 `SHORT`、`OVER`、`NONCOMPLIANCE`（“损坏”没有可靠来源，本包不产出）；多 `tenantId`、`sellerAccountId`、`planId?`、`source`（`RECEIPT` 接收数量派生 / `REPORT` 不合规报告，CHECK 保证 `NONCOMPLIANCE` 与 `REPORT` 一一对应）、`problemKey`（`problemType` 的非空形态，进唯一键，接收差异为空串）、`lastSeenAt`；`shipmentId` 改名 `shipmentRef`（不合规报告给的可能是 FBA 确认号，读取时两个编号都匹配）；唯一键 `(tenantId, sellerAccountId, shipmentRef, sku, kind, problemKey)`；**没有 `evidenceAttachmentIds`**，证据是货件级附件（`Attachment`，`entityType = INBOUND_SHIPMENT`）；差异消除后不删除，写 `resolvedAt`。`ReimbursementOpportunity`：`storeId` 实为 `sellerAccountId`；`status` 比冻结多一个 `RESOLVED`（差异后来消除，待处理的机会自动转入）；多 `currency`、`detectedAt`、`updatedAt`；`deadlineAt` 为日期；`ruleCode` 的 7 类全部建在 CHECK 里，本包只产出 `INBOUND_DISCREPANCY`，其余 6 类由 P2b-03 与 P2a-15 接入。**没有 `ReceivingTimeStat` 表**：接收时长按已关闭货件现算（量级小，不缓存），统计窗口 365 天。

> **P2b-01 实现说明（CR-039，迁移 `20261026010000_order_page`）**：`Order` 增加 `programs` TEXT[]（默认空数组，订单项目标记）与 `salesChannel` TEXT?（销售渠道名称），既有订单这两列下次订单同步才会补上，不编造值；新增 3 个索引 `FbaFinancialTransaction(tenantId, amazonOrderId)`、`FbaFeeEvent(tenantId, amazonOrderId)`、`Order(tenantId, replacedOrderId)`（都建在分区父表上，自动覆盖全部分区），支撑订单页按订单号取财务交易、费用与替换订单。没有新表，不涉及 RLS 与授权脚本。`Order.isReplacement`、`replacedOrderId`、`replacementReason` 由 R-05 报告写入，订单接口同步不再把它们重置（`v2026-write.ts` 只在接口自己判断为替换订单时才写这三列）。

## 十四、订单、售后与财务

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `Order` | 修改 | 迁移到订单接口新版字段：新增 fulfillmentStatus、latestShipDate、earliestDelivery/latestDelivery（配送承诺）、cancelledBy、isReplacement Bool、replacedOrderId Str?、replacementReason Str?、refundStatus Str | `(storeId, amazonOrderId, purchaseDate)` | **按月 `purchaseDate`** | — | R | M-P1-27、M-P1-26 | P1-27、P1-26 |
| `OrderItem` | 修改 | 冗余存放 `marketplaceId`；新增 orderPurchaseDate D（分区列）、promotionDiscount Dec、taxAmount Dec、itemStatus Str | `(storeId, orderItemId, orderPurchaseDate)` | **按月 `orderPurchaseDate`** | — | R | M-P1-27、M-P1-26 | P1-27、P1-26 |
| `OrderCharge` | 新增 | orderItemId Str；purchaseDate D；chargeKind Enum(商品/配送/促销/税/费用/其他)；componentKey Str；amount Dec；currency Str；feeCategory Str? | `(storeId, orderItemId, chargeKind, componentKey, purchaseDate)` | **按月 `purchaseDate`** | — | R | M-P1-26 | P1-26 |
| `OrderStatusHistory` | 新增 | orderId Str；status Str；occurredAt Dt；source Enum(接口/推送/报告) | `(orderId, status, sourceUpdatedAt)` | 否 | — | R | M-P1-26 | P1-26 |
| `OrderPackage` | 新增 | orderId Str；packageId Str；carrier Str；trackingNumber Str；shipDate D?；deliveredAt Dt?；fulfillmentCenter Str? | `(storeId, orderId, packageId, trackingNumber)` | 否 | — | R | M-P1-26 | P1-26 |
| `OrderCancellation` | 新增 | orderId Str；cancelledBy Enum(买家/卖家/亚马逊/未知)；reasonCode Str；requestedAt Dt?；cancelledAt Dt? | `(storeId, orderId)` | 否 | — | R | M-P1-26 | P1-26 |
| `ConnectorChannelState`（补，CR-021） | 新增 | domain Enum(订单/财务)；legacyEnabled Bool（旧通道是否仍在对照）；consecutivePasses Int；requiredPasses Int（默认 7）；lastRunAt Dt?；closedAt Dt?；closedReason Str? | `(storeId, domain)` | 否 | — | R | M-P1-26 | P1-26 |
| `ConnectorParityRun`（补，CR-021） | 新增 | domain；windowStart/windowEnd Dt；legacyCount/newCount/matchedCount/unexplainedCount Int；status Enum(通过/有差异/旧接口不可用)；syncJobId Str?；startedAt/finishedAt Dt | `id`（索引 `(tenantId, storeId, domain, startedAt)`） | 否 | — | R | M-P1-26 | P1-26 |
| `ConnectorParityDiff`（补，CR-021） | 新增 | runId Str；category Enum(时间口径/归因口径/范围/未解释)；entityKey Str；field Str；legacyValue Str?；newValue Str?；explanation Str | `id`（索引 `(runId, category)`） | 否 | — | R | M-P1-26 | P1-26 |
| `FbaReturnCase` | 修改 | 新增 reimbursementCaseId Str?；licensePlateNumber Str；disposition Str；detailedDisposition Str；reason Str | 现有 | 否 | — | R | M-P2b-02 | P2b-02 |

> **P2b-03 实现说明（CR-041，迁移 `20261028010000_reimbursement_center`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`）**：新增 `ReimbursementCase`、`ReimbursementRecord`（CR-002）、`EvidencePack` 三张租户表，并给 `ReimbursementOpportunity` 加 `sku`、`qty`、`note`（忽略原因）、`version`（乐观锁）四列（入仓差异机会的既有行用 `dedupKey` 与接收差异回填 `sku`、`qty`）。与上表的差异——`storeId` 实为 `sellerAccountId`；`ReimbursementCase`：`status` 取 `OPPORTUNITY`/`SUBMITTED`/`IN_PROGRESS`/`APPROVED`/`PARTIAL`/`REJECTED`/`PAID`（冻结写“机会”指案件刚建立、待提交），多 `ruleCode`、`sku`、`qty`、`approvedAmount`、`currency`、`decidedAt`、`paidAt`、`deadlineAt`、`evidenceRefsJson`（立案时固化的证据引用）、`note`、`version`、`createdBy`，`opportunityId` 唯一（一条机会只能立一个案件），`receivedAmount` 默认 0 且只由赔付明细匹配累加；`ReimbursementRecord`：唯一键 `(sellerAccountId, reimbursementId, sku, fnsku)`（多一列 `fnsku` 默认空串以便进唯一键），多 `matchBasis`（`CASE_ID`/`ORDER_SKU`/`SKU_REASON`，CHECK：匹配了案件就必须有依据）、`matchedAt`、`amazonCaseId`、`sourceReportJobId`，**金额允许为负**（赔付冲回），数量不能为负；`EvidencePack`：保存证据清单快照 `contentManifestJson` 与 `exportJobId`，唯一键 `(caseId, generatedAt)`。机会与案件的外键列都单独建了索引。**没有 `Evidence`、`CaseTimeline` 之类的独立表**：证据引用存 JSON，附件复用 `Attachment`（`entityType = REIMBURSEMENT_CASE`），状态变化写 `EntityEvent`。

> **P2b-04 实现说明（CR-042，迁移 `20261029010000_support_cases`，含 `rollback.sql`、RLS、`regrant.sql`）**：新增 `SupportCase`、`SupportContact` 两张租户表（`SEED_OVERRIDES` 无需登记：约束只有 `contactCount >= 0` 与沟通方向取值，自动造数的默认值都合法）。与上表的差异——`storeId` 实为 `sellerAccountId`；**没有 `linkedReimbursementCaseId`、`linkedShipmentId` 两列**：关联在读取时现算（赔付案件里回填的亚马逊案件编号与本案件一致；货件来自赔付案件的货件证据，或案件主题里写的 FBA 货件编号且在我方货件里存在），存下来的关联会在赔付案件回填或改编号后过期；`SupportCase`：`createdAt`、`updatedAt` 改名 `amazonCreatedAt`、`amazonUpdatedAt`（与行的建立与更新时间区分），多 `amazonResolvedAt`、`lastOutboundAt`、`appointmentsJson`（预约回电：编号、状态、时间窗、接听方，**不存电话号码**）、`contactsForUpdatedAt`（取沟通记录时案件的更新时间，与 `amazonUpdatedAt` 不一致说明案件有新沟通还没取）、`contactCount`（`contactsForUpdatedAt` 为空时不可信，接口返回 null，页面写“尚未同步”）、`syncedAt`；`status` 不加检查约束（亚马逊以后新增状态不能让同步写不进去，页面显示“其他状态（原值）”）；唯一键 `(sellerAccountId, caseId)`，索引 `(tenantId, amazonUpdatedAt)`、`(tenantId, amazonCreatedAt)`。`SupportContact`：`caseId` 实为外键 `supportCaseId`，唯一键 `(supportCaseId, contactId)`；`direction` 取 `FROM_AMAZON`、`FROM_SELLER`、`UNKNOWN`（CHECK；电话备注与聊天记录没有发送方，标未标明）；多 `channel`、`senderName`、`attachmentsJson`（**只存附件名称**，亚马逊给的下载链接 15 分钟失效）；**不存主邮箱、抄送邮箱、电话号码**；`body` 超过 20000 字截断。沟通记录不可变，只追加。

> **P2b-05 实现说明（CR-043，迁移 `20261030010000_fee_events`，含 `rollback.sql`）**：没有新表，`FbaFeeEvent`（分区父表，加列自动覆盖全部分区）新增 8 列：`feeCategory`（默认 `OTHER`，取值 9 类外加 `NON_FEE`，CHECK）、`feeSubtype`（明细路径最后一段）、`transactionStatus`（来源交易状态的冗余，递延转释放时同步刷新）、`reconciliationStatus`（默认 `UNRECONCILED`，CHECK）、`reconciliationNote`、`reconciledBy`、`reconciledAt`、`version`（乐观锁，CHECK ≥ 1）；新增索引 `(tenantId, feeCategory, postedAt)`。与上表的差异——冻结写“feeCategory Enum(9 类)”，实际多一个 `NON_FEE`（销售收入、税、运费收入、促销折扣这类不是费用的明细，仍留在表里供财务汇总使用，但不属于 9 个页签，接口从不返回）；用文本加 CHECK 而不是数据库枚举（与全库一致）；冻结写的分区列 `postedDate` 实为既有的 `postedAt`。默认值 `OTHER` 是故意的：漏分类的写入点会落在“其他调整”页签里被看见，而不是消失。历史数据回填在迁移里完成（按名称关键字，与契约 `FEE_RULES` 同一串关键字，真实库测试逐条核对两边一致）；**分类是按名称关键字的启发式，不是亚马逊的官方分类**。行级安全与授权沿用 `FbaFeeEvent` 既有的，不改 `regrant.sql`。回滚会丢失人工录入的对账状态、备注与版本，回滚前先导出。

> **P2b-02 实现说明（CR-040）**：FbaReturnCase 实际新增 7 列：nsku Str 默认空串、licensePlateNumber Str 默认空串（退货件编号，进唯一键所以不可空）、detailedDisposition Str?（报告原值）、ulfillmentCenterId Str?、
eportStatus Str?（报告里的处理状态）、customerComments Str?（P6-14 起不再写入，旧明文由回填任务加密后清空；买家备注改存 customerCommentsCipher 等三列，见第二十一节）、
eimbursementCaseId Str?（P2b-03 回填，本包只建列）。disposition 改存我方归并后的处置分组（SELLABLE、DAMAGED、CARRIER_DAMAGED、WAREHOUSE_DAMAGED、DEFECTIVE、EXPIRED；报告没给处置时保持空），
eason 仍存报告原因代码。唯一键由 (sellerAccountId, amazonOrderId, asin, returnDate) 改为 (sellerAccountId, amazonOrderId, asin, sellerSku, fnsku, licensePlateNumber, returnDate)（FbaReturnCase_report_uq，旧键的超集，既有数据不会冲突）；新增索引 (tenantId, amazonOrderId)、(tenantId, returnDate)。迁移 20261027010000_returns_page 把既有行的 detailedDisposition 用原 disposition 回填；回滚同一订单同一时间有多个退货件时只保留最早一行。
| `ReimbursementOpportunity` | 新增 | ruleCode Enum(7 类机会)；evidenceRefsJson Json；estimatedAmount Dec；deadlineAt D；status Enum(待处理/已生成案件/已忽略/已过期)；dedupKey Str | `(tenantId, storeId, ruleCode, dedupKey)` | 否 | — | R | M-P2a-13 | P2a-13 |
| `ReimbursementCase` | 新增 | caseNo Str；opportunityId Str?；status Enum(机会/已提交/处理中/已批准/部分批准/拒绝/已到账)；expectedAmount Dec；receivedAmount Dec；ownerId Str；amazonCaseId Str?（手工回填）；submittedAt Dt? | `(tenantId, caseNo)` | 否 | ✓ | R | M-P2b-03 | P2b-03 |
| `ReimbursementRecord`（CR-002 已确认） | 新增 | reimbursementId Str；sku/fnsku/asin Str；reason Str；quantity Int；amount Dec；currency Str；approvedAt D；originalOrderId Str?；matchedCaseId Str? | `(storeId, reimbursementId, sku, fnsku)` | 否 | — | R | M-P2b-03 | P2b-03 |
| `EvidencePack` | 新增 | caseId Str；objectKey Str；contentManifestJson Json；generatedAt Dt；generatedBy Str | `(caseId, generatedAt)` | 否 | — | R | M-P2b-03 | P2b-03 |
| `SupportCase` | 新增 | caseId Str；subject Str；status Str；createdAt Dt；updatedAt Dt；linkedReimbursementCaseId Str?；linkedShipmentId Str? | `(storeId, caseId)` | 否 | — | R | M-P2b-04 | P2b-04 |
| `SupportContact` | 新增 | caseId Str；contactId Str；direction Str；body Str；occurredAt Dt | `(storeId, caseId, contactId)` | 否 | — | R | M-P2b-04 | P2b-04 |
| `FbaFinancialTransaction` | 修改 | 新增 transactionStatus Enum(递延/已释放/递延后释放)；relatedIdentifiers Json；settlementId Str?；reconciliationStatus Enum；`postedDate`为分区列 | `(storeId, sourceTransactionId, postedDate)` | **按月 `postedDate`** | — | R | M-P1-27、M-P1-26 | P1-27、P1-26 |
| `FbaFeeEvent` | 修改 | 新增 feeCategory Enum(9 类)；reconciliationStatus Enum；`postedDate` 分区列 | `(storeId, sourceRecordId, postedDate)` | **按月 `postedDate`** | — | R | M-P1-27、M-P2b-05 | P1-27、P2b-05 |
| `FbaSettlement` | 沿用并补列 | 新增 openingBalance Dec；disbursementAmount Dec；txnCount Int；reconciliationStatus Enum；diffAmount Dec | 现有 | 否 | — | R | M-P2b-07 | P2b-07 |
| `Reconciliation` | 新增 | scopeKind Enum(日期/结算)；rangeStart D；rangeEnd D；officialAmount Dec；systemAmount Dec；diffAmount Dec；status Enum | `(storeId, scopeKind, rangeStart, rangeEnd)` | 否 | — | R | M-P2b-07 | P2b-07 |
| `ReconciliationException` | 新增 | reconciliationId Str；category Enum(时间口径/归因口径/范围/未解释)；amount Dec；note Str?；status Enum；resolvedBy Str? | `id` | 否 | — | R | M-P2b-07 | P2b-07 |
| `SettlementLine` | 新增（冻结没有，P2b-07 补，CR-045；结算报告明细不写 `FbaFinancialTransaction`，两边要分开才能三方核对） | settlementId Str；lineNo Int（报告里数据行的位置，固定）；transactionType/amountType/amountDescription Str；category Text+CHECK(INCOME/FEE/REFUND/REIMBURSEMENT/ADJUSTMENT/RESERVE)；amazonOrderId?、shipmentId?、sku?、quantity?；postedAt?；amount Dec；currency；sourceReportJobId? | `(settlementId, lineNo)`；索引 `(tenantId, amazonOrderId)` | 否 | — | R | M-P2b-07 | P2b-07 |
| P2b-07 对上面三行的实际形态（CR-045） | 说明 | `FbaSettlement` 另有 `sortAt`（列表排序：打款日，没有则周期结束日，再没有则建立时间；旧行回填）、`summaryJson`（各类别合计）、`reconciliationStatus` Text+CHECK(PENDING/MATCHED/DISCREPANCY)；`Reconciliation` 的 `settlementId` 唯一（一张结算单一份结果），`scopeKind` 取值 DATE/SETTLEMENT 但只产出 SETTLEMENT，`detailJson` 存三项核对与计数，只在结算单有周期日期时写；`ReconciliationException` 的 `refKey` 在同一核对结果内唯一，消除用 `status=RESOLVED`，系统消除记 `resolvedBy=system:settlement` | — | — | — | — | M-P2b-07 | P2b-07 |
| `FeeAudit` | 新增 | **P2b-06 实现（CR-044）**：subjectKey Str（SKU 或入仓计划编号）；feeKind Text+CHECK(FULFILLMENT/COMMISSION/STORAGE/INBOUND_PLACEMENT，冻结的“其他”类没做)；sku?、asin?、shipmentRef?；currency；expectedAmount Dec（应收）；actualAmount Dec（实收）；diffAmount Dec；overchargeAmount Dec（累计差额，只累计多收的行）；occurrences Int（多收次数）；checkedCount Int（核对行数）；firstSeenAt?、lastSeenAt?；snapshotDate D（核查日）；status Text+CHECK(NORMAL/SUSPECTED/APPEALED)；basisJson Json（依据：说明、多收明细、尺寸对比、限制）；opportunityId?（不建外键） | `(sellerAccountId, feeKind, subjectKey, snapshotDate)`；索引 `(tenantId, snapshotDate, feeKind)` | 否 | 保留 60 天 | R | M-P2b-06 | P2b-06 |
| `FeeBaseline` | 新增（冻结没有，P2b-06 补，CR-044） | sku Str；asin Str；snapshotDate D；currency；sizeTier?、prevSizeTier?（前一次快照的分段，用来发现尺寸分段变化）；lengthCm/widthCm/heightCm/weightKg?（亚马逊测量，已换算成厘米与千克，三边从长到短）；salesPrice?、expectedFulfillmentFee?、expectedReferralFee?；sourceReportJobId? | `(sellerAccountId, sku, snapshotDate)`；索引 `(tenantId, snapshotDate)` | 否 | 保留 90 天 | R | — | P2b-06 |
| `AccountBalanceSnapshot` | 新增 | snapshotDate D；balanceType Str（目前只有 `DEFERRED` 递延余额，见 CR-021）；accountType Str（补，CR-021：同一余额类型在不同账户类型下并存）；currency Str；amount Dec | `(storeId, snapshotDate, currency, balanceType, accountType)` | 否 | — | R | M-P1-26 | P1-26 |
| `Disbursement` | 新增 | settlementId Str；disbursedAt D；amount Dec；currency Str；bankLast4 Str?；**实现另有 note Str?、version Int（乐观锁）、createdBy、updatedBy**（CR-046）；**另给 `FbaFinancialTransaction` 加 `maturityAt`（递延交易的预计释放日）** | `settlementId`（一张结算单一条，实现里是单列唯一键）| 否 | — | R | M-P2b-08 | P2b-08 |
| `CashflowForecast` | 新增 | forecastDate D；horizonDays Int；inflow Dec；outflow Dec；netCash Dec；assumptionsJson Json；modelVersion Str | `(storeId, forecastDate, horizonDays, modelVersion)` | 否 | — | R | M-P2b-08 | **未建（CR-046）**：预测按请求现算，不保存；采购付款与头程费用没有店铺归属，存成按店铺的快照没有意义；模型版本号 `run-rate-v1` 写在响应里 |
| `SalesTaxSummary` | 新增 | taxPeriod D；state Str；jurisdictionKey Str；taxKind Str；taxableSales Dec；taxCollected Dec；source Enum(税务文档库报告/订单接口/发货报告) | `(storeId, taxPeriod, state, jurisdictionKey, taxKind, source)` | 否 | — | R | M-P2b-12 | P2b-12（**实现，CR-050，迁移 `20261105010000_sales_tax`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`**：`storeId` 实为 `sellerAccountId`；`taxPeriod` 存**日**（报告可分段生成，页面按月汇总）；`state`、`jurisdictionKey`（默认空串，州一级）、`taxKind`（默认 `SALES_TAX`）都存报告里的大写原值；`taxableSales` 可空（报告没给应税销售额列时为空，不是 0）；另有 `lineCount`、`currency`（默认 USD）、`sourceReportJobId`、`syncedAt`；`source` 用文本加 CHECK（三个取值），**实际只写 `TAX_LIBRARY`**，订单接口的税读取时从 `OrderCharge` 现算，发货报告未接入；检查约束：来源取值、行数不为负、州不为空；索引 `(tenantId, taxPeriod)`、`(sellerAccountId)`）|
| `AccountingPeriod` | 新增 | periodStart D；periodEnd D；status Enum(开放/关账中/已关账/重新开账)；checklistJson Json；closedBy Str?；closedAt Dt?；reopenReason Str? | `(tenantId, storeId, periodStart)` | 否 | ✓ | R | M-P2b-13 | P2b-13（**实现，CR-051，迁移 `20261106010000_period_close`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`**：`storeId` 实为 `sellerAccountId`；`status` 用文本加 CHECK（`OPEN`、`CLOSING`、`CLOSED`、`REOPENED`）；另有 `version`（乐观锁）、`checkedBy`、`checkedAt`、`approvalDecision`、`approvedBy`、`approvedAt`、`approvalComment`、`closeCount`、`reopenedBy`、`reopenedAt`、`createdBy`；`checklistJson` 存最近一次检查清单；`closedBy` 存成员编号；`periodStart`、`periodEnd` 是企业数据口径时区的自然月首尾日；唯一键 `(tenantId, sellerAccountId, periodStart)`，索引 `(sellerAccountId)`）|
| `PeriodSnapshot` | 新增 | periodId Str；profitSnapshotJson Json；fxSnapshotJson Json；costVersionSnapshotJson Json；lockedAt Dt | `(periodId)` | 否 | — | R | M-P2b-13 | P2b-13（**实现，CR-051**：另有 `tenantId`、`revision`（第几次关账，`(periodId, revision)` 唯一）、`diffJson`（与上一份快照的差异报告，第一次关账为空）、`lockedBy`；`profitSnapshotJson` 存三种收入确认口径各一份合计与逐 SKU 汇总（每口径最多 3000 个 SKU，超过标记不完整），`fxSnapshotJson` 存期间内汇率，`costVersionSnapshotJson` 存期间内生效中的成本版本（最多 19,999 条）；只追加、不修改，表上没有触发器强制，靠代码保证）|
| `ProfitDaily`（10.1 利润日表） | 新增 | **实际形态（CR-047）**：profitDate D；sku Str（店铺级行为 `__STORE__`）；asin Str?；basis Enum(ORDERED/SHIPPED/SETTLED)；costing Enum(FIFO/MOVING_AVG/MONTH_AVG)；currency Str（USD）；units Int；costedUnits Int；revenue Dec；refunds Dec；feeCommission/feeFulfillment/feeStorage/feeAged/feeInbound/feeOther Dec（取代 amazonFees）；promotion Dec；adsSpendAllocated Dec?；adsUnallocated Dec?；productCost Dec?；firstMileCost Dec?；otherCost Dec?；reimbursement Dec；profit Dec?；costCoverage Pct?；costCurrency Str?；productCostOriginal Dec?；firstMileCostOriginal Dec?；fxRate Dec?；fxSource Str?；fxFallback Bool；flags Str[]；metricVersion Str；refreshedAt Dt | `(tenantId, sellerAccountId, sku, profitDate, basis)` | 否 | — | R | M-P2b-09 | P2b-09 |
| `AdsAllocationRule` | **未建（CR-071：由 `FinancePolicyVersion.adsAllocationMode` 取代）** | mode Enum(按销售额/按订单/按直接归因)；effectiveFrom D；paramsJson Json；status Enum | `(tenantId, storeId, effectiveFrom)` | 否 | ✓ | R | M-P3-16 | P3-16 |
| `EconomicsDaily` | 新增 | date D；msku Str；asin Str?；aggregation Str；sales Dec；feesJson Json（费用分项）；adsSpend Dec；sellerCostPerUnit Dec?；netProceeds Dec；currency Str | `(storeId, msku, date, aggregation)` | ~~按月 `date`~~ **实现为普通表（CR-049，P2b-11）**：另有 `unitsOrdered`、`unitsRefunded`、`netUnits`、`orderedSales`、`refundedSales`、`feesTotal`、`costJson`、`syncedAt`；`sales` 为净销售额；`netProceeds` 可空（官方没给） | — | R | M-P2b-11 | P2b-11 |
| `EconomicsPreview` | 新增 | msku Str；feeType Str；rangeStart D；rangeEnd D；estimatedAmount Dec；currency Str；queriedAt Dt；**实现另有 `asin`、`quantity`、`amountPerUnit`、`amountPerUnitDelta`（CR-049）** | `(storeId, msku, feeType, rangeStart, rangeEnd)` | 否 | — | R | M-P2b-11 | P2b-11 |
| `EconomicsSimulationRun` | 新增 | actionTypes Str[]；productsJson Json；rangeStart D；rangeEnd D；resultJson Json；createdBy Str；createdAt Dt（**实现（P2a-07 建表，P2b-11 扩展，CR-049）：每次只模拟一个 SKU，用 `actionType`（AWD 或 SIPP）、`startDate`、`endDate`、`inputJson`、`syncJobId`，没有 `actionTypes[]`、`productsJson`**） | `id` | 否 | — | R | M-P2b-11 | P2b-11 |

## 十五、广告

广告账户编号与店铺的关系：`AdsProfile` 绑定店铺（`sellerAccountId`），同时保存统一接口账户编号与旧接口作用域编号。

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `AdsProfile` | 修改 | 新增 sellerAccountId Str?（绑定店铺）；adsAccountId Str（统一接口 `Amazon-Ads-AccountId`）；legacyScopeId Str?（旧接口 `Amazon-Advertising-API-Scope`）；bindingStatus Enum(已自动匹配/人工绑定/未绑定)；boundBy Str? | 现有 + `(tenantId, adsAccountId)` | 否 | — | R | M-P1-12、M-P3-02 | P1-12、P3-02 |
| `AdsAccount` | 新增 | adsAccountId Str；name Str；entityId Str?；status Str；currency Str；timezone Str | `(tenantId, adsAccountId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsPortfolio` | 新增 | portfolioId Str；name Str；budgetCap Dec?；budgetPeriod Enum；spent Dec；status Str | `(adsAccountId, portfolioId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsCampaign` | 修改 | 新增 portfolioId Str?；targetingType Enum(自动/手动)；bidStrategy Str；servingStatus Str；budgetType Str；startDate D?；endDate D?；adProduct Str | 现有 | 否 | — | R | M-P3-02 | P3-02 |
| `AdsAdGroup` | 新增 | adGroupId Str；campaignId Str；name Str；state Str；defaultBid Dec? | `(adsAccountId, adGroupId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsAd` | 新增 | adId Str；adGroupId Str；asin Str?；sku Str?；state Str | `(adsAccountId, adId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsTarget` | 新增 | targetId Str；adGroupId Str；kind Enum(关键词/商品/类目/受众)；expression Str；matchType Str?；bid Dec?；state Str | `(adsAccountId, targetId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsKeyword` | 新增 | keywordId Str；campaignId Str；adGroupId Str；text Str；matchType Str；bid Dec?；state Str | `(adsAccountId, keywordId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsNegativeTarget` | 新增 | negativeId Str；level Enum(活动/广告组)；campaignId Str；adGroupId Str?；expression Str；matchType Str | `(adsAccountId, negativeId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsCreative` | 新增 | creativeId Str；adId Str；kind Str；assetsJson Json | `(adsAccountId, creativeId)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsMetric` | 修改 | 迁移为 `(adsAccountId, entityType, entityId, date)` 日指标；新增 impressions/clicks/spend/sales/orders/units；按流量日期归因；警告信号字段 `warningSignals Json?` | `(adsAccountId, entityType, entityId, date)` | **按月 `date`** | — | R | M-P1-27、M-P3-02 | P1-27、P3-02 |
| `AdsTermMetric` | 修改 | 关联 targetId 与 keywordId；新增 matchedTargetExpression Str?、`otherBucket Bool`（低于阈值归为"其他"） | `(adsAccountId, campaignId, targetId, searchTerm, date)` | **按月 `date`** | — | R | M-P1-27、M-P3-02 | P1-27、P3-02 |
| `AdsPlacementMetric` | 新增 | campaignId Str；placement Str；date D；impressions/clicks/spend/sales/orders | `(adsAccountId, campaignId, placement, date)` | 否 | — | R | M-P3-02 | P3-02 |
| `AdsAdvertisedProductMetric` | 新增 | campaignId Str；advertisedAsin Str；date D；impressions/clicks/spend/sales/orders/units | `(adsAccountId, campaignId, advertisedAsin, date)` | **按月 `date`** | — | R | M-P3-02 | P3-02 |
| `AdsConvertedProductDaily` | 新增 | campaignId Str；advertisedAsin Str；purchasedAsin Str；date D；units Int；sales Dec；isHalo Bool | `(adsAccountId, campaignId, advertisedAsin, purchasedAsin, date)` | **按月 `date`** | — | R | M-P3-02 | P3-02 |
| `AdsPerformanceHourly` | 新增 | entityType Str；entityId Str；hourStart Dt；impressions/clicks/spend/sales/orders；其余按需指标放 `extraJson Json`（营销数据流约 400 项指标，只落业务页用到的指标列，其余保留原始文件） | `(adsAccountId, entityType, entityId, hourStart)` | **按月 `hourStart`** | — | R | M-P3-02 | P3-02 |
| `AdsEntitySnapshot` | 新增 | entityType Str；entityId Str；snapshotAt Dt；stateJson Json；hash Str | `(adsAccountId, entityType, entityId, snapshotAt)` | 否 | — | R | M-P3-14 | P3-14 |
| `AdsChangeLog` | 新增 | entityType Str；entityId Str；changedField Str；beforeValue Str?；afterValue Str?；actorKind Enum(本系统/外部/自动规则/分时)；occurredAt Dt；writeRunId Str? | `(adsAccountId, entityType, entityId, changedField, occurredAt)` | 否 | — | R | M-P3-14 | P3-14 |
| `AdsRecommendation` | 新增 | recommendationId Str；type Str；entityType Str；entityId Str；payloadJson Json；status Enum；receivedAt Dt | `(adsAccountId, recommendationId)` | 否 | — | R | M-P3-01 | P3-01 |
| `AdsForecastRun` | 新增 | campaignId Str；requestedBudget Dec；forecastJson Json；requestedAt Dt | `id` | 否 | — | R | M-P3-01 | P3-01 |
| `AdsBudgetRule` | 新增 | campaignId Str；ruleType Str；paramsJson Json；status Str | `(adsAccountId, campaignId, ruleType)` | 否 | ✓ | R | M-P3-11 | P3-11 |
| `AdsAutomationRule` | 新增 | name Str；scopeJson Json；conditionJson Json；actionJson Json；mode Enum(仅建议/自动)；status Enum；lastRunAt Dt? | `(tenantId, storeId, name)` | 否 | ✓ | R | M-P3-13 | P3-13 |
| `AdsAutomationRun` | 新增 | ruleId Str；entityId Str；beforeValue Str；afterValue Str；executed Bool；writeRunId Str?；runAt Dt | `(ruleId, entityId, runAt)` | 否 | — | R | M-P3-13 | P3-13 |
| `DaypartingStrategy` | 新增 | name Str；scopeJson Json；hourlyMultipliersJson Json；timezone Str；status Enum | `(tenantId, storeId, name)` | 否 | ✓ | R | M-P3-12 | P3-12 |
| `DaypartingRun` | 新增 | strategyId Str；campaignId Str；hour Int；appliedMultiplier Pct；executed Bool；runAt Dt | `(strategyId, campaignId, runAt)` | 否 | — | R | M-P3-12 | P3-12 |

> **P3-01 与 P3-02 实现说明（CR-056、CR-057，迁移 `20261109010000_ads_connector`、`20261110010000_ads_data_model`，含 `rollback.sql`、RLS、`regrant.sql`、`SEED_OVERRIDES`）**：
> 与上表的差异——（1）**全部唯一键都加了 `tenantId`**（同一个亚马逊广告账户被两个企业连接时互不覆盖），实体与指标表同时带 `adsProfileId`（范围过滤）与 `(tenantId, adsAccountId)` 指向 `AdsAccount` 的外键（删除账户级联删除全部子数据，P3-01 的 `AdsRecommendation`、`AdsForecastRun` 也已补上这个外键）；
> （2）`AdsProfile.adsAccountId` **可空**（冻结写必填：旧档案推不出统一接口的账户编号，只能等统一接口发现账户后再填；迁移只在“档案恰好对应一个账户”时回填），`legacyScopeId` 回填为 `profileId`；`AdsAccount.timezone` 可空；
> （3）**`AdsMetric` 的 `spend`、`orders` 沿用原列名 `cost`、`purchases`，日期列沿用 `reportDate`**（不改名，不动全部读写方），新增 `adsAccountId?`、`entityType`（默认 `CAMPAIGN`）、`entityId?`（旧数据回填为活动编号，空串不回填）、`units?`、`warningSignals?`，新唯一键 `AdsMetric_entity_uq (tenantId, adsAccountId, entityType, entityId, reportDate, adProduct)`（旧行没有账户编号，不进这条唯一键；旧唯一键保留）；`AdsTermMetric` 新增 `adsAccountId?`、`targetId?`（回填为 `keywordId`）、`matchedTargetExpression?`、`otherBucket`，原唯一键不变；`AdsCampaign` 新增 `adsAccountId?`、`portfolioId?`、`targetingType?`（`AUTO`/`MANUAL`）、`bidStrategy?`、`servingStatus?`、`budgetType?`，`startDate`、`endDate` 沿用原有的时间戳列；
> （4）新表的金额与订单数按冻结叫 `spend`、`orders`（金额没数据为空不是 0），日期列统一叫 `reportDate`（小时表 `hourStart`）；`AdsPortfolio` 多 `currency`，`budgetPeriod` 不加检查约束（取值以亚马逊返回为准）；新表都带同步表统一字段 `sourceUpdatedAt`、`syncedAt`、`sourceReportJobId`、`sourceRecordId`；
> （5）`AdsAdvertisedProductMetric`、`AdsConvertedProductDaily`、`AdsPerformanceHourly` 是按月分区表（主键与唯一键含分区列），`AdsPlacementMetric` 与 7 张实体表不分区；`AdsTarget.kind`、`AdsNegativeTarget.level`（广告组级必须有 `adGroupId`）、指标 `entityType`、`AdsCampaign.targetingType` 有检查约束，取值在契约 `ads-model.ts`；
> （6）**P3-07（CR-062）**：`AdsCampaign` 再新增 `tags String[]`（默认空数组）、`ownerId String?`、`version Int`（默认 1，乐观锁），迁移 `20261112010000_ads_campaign_meta`；这三列是**本系统自己的数据**（批量设置标签与负责人 `PATCH /ads/campaigns/meta` 写入），广告同步器从不写，所以重复同步不会覆盖；`ownerId` 不加外键（成员离开后保留历史，页面显示“已离开的成员”）。
> （6）冻结归后续包的 `AdsEntitySnapshot`、`AdsChangeLog`（P3-14）、`AdsBudgetRule`（P3-11）、`AdsAutomationRule`、`AdsAutomationRun`（P3-13）、`DaypartingStrategy`、`DaypartingRun`（P3-12）本次不建（`AdsDailySummary` 已在 P3-04 建，见第七节末尾的实现说明）；**现在没有任何同步器写实体表与新指标表**（只有旧版报告导入器写 `AdsMetric`、`AdsTermMetric` 的新列）。
>
> **P3-03 补充（CR-058，无新迁移）**：广告账户与店铺的绑定**写在 `AdsProfile`**（`sellerAccountId`、`bindingStatus`：`UNBOUND`/`AUTO_MATCHED`/`MANUAL`、`boundBy`）上，不写 `AdsAccount`：范围过滤本来就经 `AdsProfile.sellerAccountId`，且 `AdsAccount` 现在没有同步器写入。待统一接口发现账户后，若要把绑定下沉到 `AdsAccount`，另走变更。
>
> **P3-11 补充（CR-066，迁移 `20261113010000_ads_portfolio_budget`，含 `rollback.sql`、RLS、`regrant.sql`）**：（1）`AdsPortfolio` 新增可空的 `budgetStart`、`budgetEnd`（`DATE`）：冻结只有 `budgetPeriod`，指定日期范围的预算需要起止日才能算节奏；检查约束 `AdsPortfolio_budget_range_check`：两列要么都空、要么都有且起不晚于止；（2）新建 `AdsBudgetRule`（冻结 M-P3-11）：唯一键 `(tenantId, adsAccountId, campaignId, ruleType)`（比冻结多 `tenantId`），带 `adsProfileId`（范围过滤）与指向 `AdsAccount` 的级联外键，`paramsJson` 原样保存接口返回的规则参数，`status` 取值以亚马逊为准；**该资源是测试版，没有任何同步器写这张表**，页面只在功能开关 `ADS_BUDGET_RULES_BETA` 打开时读它（见 `verification-log.md` 第 10 节）。

> **P3-12 补充（CR-067，迁移 `20261114010000_dayparting`，含 `rollback.sql`、RLS、`regrant.sql`）**：（1）`DaypartingStrategy` 与冻结的差异：冻结按 `(tenantId, storeId, name)` 唯一，实际按**广告档案**唯一 `(tenantId, adsProfileId, name)`（`adsProfileId` 指向 `AdsProfile`，级联外键、单独建索引），因为广告数据的范围过滤都经广告档案绑定的店铺；新增 `kind`（`BID_MULTIPLIER`/`ON_OFF`）、`targetLevel`（`CAMPAIGN`/`AD_GROUP`，**没有投放对象粒度**）、`baseBid`（可空，只属于倍率策略，目前不参与计算）、`version`（乐观锁）、`createdBy`/`updatedBy`；`scopeJson` 固定为 `{ "ids": [活动或广告组的系统编号] }`（不是亚马逊外部编号，对象被同步删除后编号仍留在策略里，页面显示“已不存在的对象”）；`hourlyMultipliersJson` 是 168 个数（周一 0 点为第 0 格，按 `timezone` 对应星期与小时）。检查约束：类型、层级、状态取值；`version >= 1`；`hourlyMultipliersJson` 必须是 168 个元素的数组、`scopeJson` 必须是对象；`baseBid` 为空或（大于 0 且类型是倍率策略）。**取值范围（倍率 0.1 至 3、启停只能 0 或 1、不能全部为 1）与对象是否同档案同层级只在服务里校验，数据库不检查。**（2）`DaypartingRun` 与冻结的差异：冻结用 `campaignId`，实际用 `entityId`（对象的系统编号，按策略层级是活动或广告组），`strategyId` 级联外键，唯一键 `(strategyId, entityId, runAt)`；新增 `outcome`（`APPLIED`/`SKIPPED`/`FAILED`）与 `message`；检查约束 `hour` 在 0 至 23、已执行（`executed` 为真）时 `outcome` 必须是 `APPLIED`。**没有任何程序写 `DaypartingRun`（调度执行器随 P3-17）**，页面读它，没有记录显示“尚未接入”。

> **P3-13 补充（CR-068，迁移 `20261115010000_ads_automation_rules`，含 `rollback.sql`、RLS、`regrant.sql`、`tenant-seed.ts` 的 `SEED_OVERRIDES`）**：（1）`AdsAutomationRule` 与冻结的差异：冻结按 `(tenantId, storeId, name)` 唯一，实际按**广告档案**唯一 `(tenantId, adsProfileId, name)`（`adsProfileId` 指向 `AdsProfile`，级联外键、单独建索引，范围过滤经广告档案绑定的店铺）；新增 `level`（`CAMPAIGN`/`TARGET`/`SEARCH_TERM`）、`frequency`（`DAILY`/`EVERY_3_DAYS`/`WEEKLY`）、`guardrailJson`（最低最高值、单次幅度上限、每日处理上限）、`lastEvaluated`、`lastMatched`（定时评估回写，成对出现且 `lastMatched <= lastEvaluated`）、`version`（乐观锁）、`createdBy`/`updatedBy`；`mode` 取 `SUGGEST`/`AUTO`（冻结写“仅建议/自动”），`status` 取 `ACTIVE`/`PAUSED`；四个 JSON 列都必须是对象。**取值范围、动作与层级相配、护栏与动作相配只在服务里校验，数据库不检查。**（2）`AdsAutomationRun` 与冻结的差异：冻结的 `entityId` 实际叫 `entityKey`（搜索词没有系统编号，用“活动编号|词”），`beforeValue`、`afterValue` 可空；新增 `ruleVersion`、`entityLabel`、`actionType`、`outcome`（`SUGGESTED`/`APPLIED`/`SKIPPED`/`FAILED`）、`message`、`workItemId`、`evidenceJson`（触发时的指标取值，键是“指标:窗口天数”）；唯一键 `(ruleId, entityKey, runAt)`，索引 `(tenantId, runAt)`、`(ruleId, runAt)`；已执行（`executed` 为真）时 `outcome` 必须是 `APPLIED`。**没有任何程序写 `executed = true` 或 `APPLIED` 的记录（随 P3-17）。**（3）评估统计（`lastRunAt`、`lastEvaluated`、`lastMatched`）由 worker 用 `updateMany` 写，**不增加 `version`、不改 `updatedAt`**（`updatedAt` 表示“上次有人改规则”，不是“上次评估”）。（4）协作的对象类型新增 `ADS_RULE`（`collab.ts` 的 `ENTITY_LABEL` 与 `entityDetailPath`，待办与通知链接到规则详情）。

> **P3-14 补充（CR-069，迁移 `20261116010000_ads_changes`，含 `rollback.sql`、RLS、`regrant.sql`、`tenant-seed.ts` 的 `SEED_OVERRIDES`）**：（1）`AdsEntitySnapshot` 与冻结的差异：冻结按 `(adsAccountId, entityType, entityId, snapshotAt)` 唯一，实际按**广告档案**唯一 `(tenantId, adsProfileId, entityType, entityId, snapshotAt)`（`adsProfileId` 指向 `AdsProfile`，级联外键、单独建索引，范围过滤经广告档案绑定的店铺，与 P3-12、P3-13 一致）；`entityType` 取 `CAMPAIGN`/`AD_GROUP`/`TARGET`/`KEYWORD`/`PORTFOLIO`，`entityId` 是对象的**系统编号**（不是亚马逊外部编号），没有指向实体表的外键（对象被删后快照仍留作对照）；`stateJson` 必须是对象，内容是规整后的“字段 → 文字”（金额取至多 6 位小数并去掉末尾 0、状态转大写、日期取年月日、空值为 `null`，字段表见 `ADS_CHANGE_FIELDS`），`hash` 是它的 sha256 且不能为空。**只在哈希变化时新增一行**；每个对象最多留 30 份，被新快照取代且超过 180 天的删除（最新一份总是保留）。（2）`AdsChangeLog` 与冻结的差异：同样按档案；新增 `entityLabel`（变更当时的对象名称）、`actorId`（仅手动变更才有，数据库约束 `actorKind = 'MANUAL'`）、`sinceAt`（仅外部变更才有，上一份快照的时间，约束不晚于 `occurredAt`）；`actorKind` 取 `MANUAL`/`AUTO_RULE`/`DAYPARTING`/`EXTERNAL`（冻结写“本系统/外部/自动规则/分时”，这里把“本系统”拆成手动）；唯一键 `(tenantId, adsProfileId, entityType, entityId, changedField, occurredAt)`（**同一时刻同一字段只能记一次，与来源无关，写入方要避开同一时间戳**）；索引 `(tenantId, occurredAt)`、`(adsProfileId)`。对象新出现的 `changedField` 是 `__created`（`afterValue` 放名称）。（3）**只有 worker 写 `EXTERNAL` 行与快照；`MANUAL`、`AUTO_RULE`、`DAYPARTING` 行没有任何程序写入（随 P3-17）。P3-17 写亚马逊时要同时写 `AdsChangeLog`（带 `actorId`、`writeRunId`）与 `EntityEvent`（P3-08 的调价记录读它）；如果不写 `AdsChangeLog`，本系统自己的改动会在下一次对比时被当成外部变更。**（4）不记的内容：快照字段表之外的内容（指标、标签、负责人、投放状态），以及对象从库里消失（亚马逊上删除是归档状态，行还在）。
> **P3-15 补充（CR-070，迁移 `20261117010000_ads_reports`，含 `rollback.sql`；没有新表，所以没有新的行级安全与授权）**：（1）`AdsReportJob` 新增列（旧任务全部是 `LEGACY`，不动）：`source`（`LEGACY` 旧版报告接口 / `V1` 新报告接口，缺省 `LEGACY`）、`templateKey`、`granularity`（`HOURLY`/`DAILY`/`MONTHLY`）、`dimensions`、`metricKeys`（任务实际请求的维度与指标）、`importedRows`、`skippedRows`（没完成时为空，**不是 0**）、`warningSignals`（报告返回的警告原样保存，数据照常入库）、`failureMessage`（中文失败原因；`failureCode` 沿用原列）、`retryOfId`、`attempt`（重试建新任务指向被重试的任务，缺省 1）、`requestedBy`、`startedAt`、`finishedAt`。检查约束：`source` 与 `granularity` 取值；`V1` 任务必须带模板、粒度与起止日期；`attempt >= 1`；行数不为负。索引 `(tenantId, source, createdAt)`。**`retryOfId` 没有外键**（被重试的任务不会因为删除而牵连新任务）。冻结的 `AdsReportJob` 没有这些列，是为页面展示与重试补的。（2）`AdsProfile` 新增 `historyFrom`（`DATE`，已取得日级数据的最早日期）与 `historyProbedAt`（最近一次登记的时间）：**只由成功导入的日粒度报告任务登记，只往前推不往后退**，是实测值不是承诺值（保留期官方有 15 与 24 个月两种说法，CR-001）；没取过数据是空，页面写“尚未取得数据”。（3）`AdsParityState`、`AdsParityRun`、`AdsParityDiff` 在 P3-01 的迁移 `20261109010000_ads_connector` 里已建，核对引擎（`apps/worker/src/parity/compare-ads.ts`、`ads-run.ts`，CR-056）也已有；这次补上任务派发（`ADS_PARITY`）、6 小时定时排任务与只读接口，表结构不变。差异类别取 `TIME_BASIS`、`ATTRIBUTION_BASIS`、`SCOPE`、`UNEXPLAINED`；**每个档案 24 小时核对一次的间隔是我定的**。（4）广告指标页没有新表：直接读 `AdsMetric`、`AdsTermMetric` 等已入库的数据集（8 个，见 `ADS_METRICS_DATASETS`），在数据库里分组汇总，最多读 19,999 个分组。

> **P3-16 补充（CR-071，没有迁移）**：（1）`AdsAllocationRule`（冻结的广告分摊规则表，含“按订单”“按直接归因”模式）**没有建**，规则改由 P2b-15 的 `FinancePolicyVersion.adsAllocationMode`（`BY_SALES` / `BY_UNITS`）承载，按天取生效中与已被替换的版本里生效日不晚于当天的最新一个。（2）`ProfitDaily.adsSpendAllocated`（商品行）与 `adsUnallocated`（店铺级行 `__STORE__`）自 P3-16 起有值：同一店铺同一天同一口径下，各 SKU 的分摊额之和加店铺级未分摊额等于账户当天的活动级总花费（`AdsMetric`，美元）；空值仍是“尚未接入”（当天没有任何广告花费记录），不是 0。（3）`flags` 新增 `ADS_ATTRIBUTION_EXCEEDS`、`ADS_ASIN_UNMAPPED`；`metricVersion` 为 `p3-16@1`。归属数据来自 `AdsAdvertisedProductMetric`（按档案 × ASIN × 日汇总）与 `FbaProduct`（ASIN → SKU）。

> **P3-17 补充（CR-072，迁移 `20261118010000_ads_write`，含 `rollback.sql`、RLS、`regrant.sql`、`tenant-seed.ts` 的 `SEED_OVERRIDES`）**：（1）新表 `AdsWriteRun`（冻结没有）：一行 = 一次对一个广告对象的写入，手动、自动规则、分时策略共用。列：`adsProfileId`（级联外键）、`kind`（十种写入类别）、`source`（`MANUAL`/`AUTO_RULE`/`DAYPARTING`）、`entityType`（`CAMPAIGN`/`AD_GROUP`/`TARGET`，新增类写入是父对象）、`entityId`（系统编号）、`externalId`（亚马逊侧编号）、`entityLabel`、`requestJson`（取值与自动来源信息，不含令牌与个人信息）、`beforeValue`、`afterValue`、`status`（`PENDING`/`RUNNING`/`SUCCEEDED`/`FAILED`）、`failureCode`（只存短码，亚马逊原文不入库）、`syncJobId`、`requestId`、`requestedBy`、`createdAt`、`finishedAt`；索引 `(tenantId, createdAt)`、`(adsProfileId)`、`(tenantId, entityId, createdAt)`；检查约束覆盖取值与状态。`AdsChangeLog.writeRunId`、`AdsAutomationRun.writeRunId` 存这张表的 `id`（审计里的 `writeRunId` 是流程编号，两者不同）。（2）`AdsAutomationRun.outcome` 与 `DaypartingRun.outcome` 的检查约束新增 `QUEUED`（已提交写入、等亚马逊确认；确认后改 `APPLIED` 并置 `executed = true`，失败改 `FAILED`）；`executed = true` 仍必须是 `APPLIED`。`DaypartingRun` 新增 `writeRunId`（可空，无外键），两张执行记录表各加 `writeRunId` 索引。（3）**修了一个既有缺陷**：`IntegrationSwitchLog_action_check` 只认 `ENABLE`/`DISABLE`/`AUTO_DISABLE`，而代码实际写入 `ENABLED`/`DISABLED`/`AUTO_DISABLED`，真实库上开关变更记录写不进去；迁移里重建约束，新旧两套取值都接受（回滚把已写入的新取值转回旧取值再恢复原约束）。（4）**新增类写入（否定投放、关键词）不写本地行**——本系统没有否定投放与关键词的同步器，写入成功后本地不出现新行，要等同步器落库；广告位调整没有本地列，所以没有修改前的值。

## 十六、风险与待办

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `AlertRule` | 新增 | code Str；domain Str；name Str；conditionJson Json；severity Enum；cooldownMinutes Int；enabled Bool；scopeJson Json | `(tenantId, code)` | 否 | ✓ | R | M-P1-28 | P1-28 |
| `AlertRuleVersion` | 新增 | ruleId Str；versionNo Int；conditionJson Json；changedBy Str；changeReason Str | `(ruleId, versionNo)` | 否 | — | R | M-P1-28 | P1-28 |
| `AlertInstance` | 新增 | ruleId Str；ruleVersionNo Int；entityType Str；entityId Str；severity Enum；status Enum(新/已确认/已处理/已忽略/自动关闭)；firstTriggeredAt Dt；lastTriggeredAt Dt；evidenceJson Json；dedupKey Str；**P5-01 增列**：title Str?；entityLabel Str?；suggestedAction Str?；impactMin/impactMax Decimal?；currency Str?；closeConclusion Str?（HANDLED、NOT_NEEDED、FALSE_POSITIVE、IGNORED，CHECK 约束；自动恢复为空）；closeNote Str?；closedBy Str?；索引 `(tenantId, ruleId, firstTriggeredAt)` 供规则质量统计 | `(tenantId, storeId, ruleId, dedupKey, status='新')` 部分唯一 | 否 | — | R | M-P1-28 | P1-28 |
| `WorkItem` | 新增 | title Str；kind Str；status Enum(待处理/进行中/已完成/已关闭)；priority Enum；dueAt Dt?；slaBreachedAt Dt?；sourceAlertId Str?；entityType Str?；entityId Str?；closeConclusion Str?；ownerId Str | `id` | 否 | ✓ | R | M-P1-28 | P1-28 |
| `Assignment` | 新增 | workItemId Str；assigneeId Str；assignedBy Str；assignedAt Dt；acceptedAt Dt? | `(workItemId, assigneeId)` | 否 | — | R | M-P1-28 | P1-28 |
| `AccountHealthSnapshot` | 新增 | snapshotDate D；metricKey Str；value Dec?；target Dec?；status Str；accountStatus Enum(正常/有风险/停用)；**P5-02 增列**：metricGroup（STATUS、RATING、ORDER_DEFECT、POLICY、OTHER）；targetCondition（LT、LTE、GT、GTE、EQ）?；unit（RATIO、COUNT）?；windowDays Int?；detailJson；source（REPORT、PUSH）；sourceReportJobId?；sourceUpdatedAt；syncedAt；`status` 取 MET、NOT_MET、UNKNOWN（报告自带目标才判定）；`accountStatus` 只在 `metricKey = ACCOUNT_STATUS` 的行上有意义 | `(tenantId, sellerAccountId, snapshotDate, metricKey)` | 否 | — | R | M-P5-02 | P5-02 |
| `PolicyIssue` | 新增 | issueId Str；kind Str；title Str；status Str；firstSeenAt Dt；resolvedAt Dt?；affectedAsinsJson Json；**P5-02 增列**：lastSeenAt；impactText?；detailJson；ownerUserId?、handlingStatus（OPEN、IN_PROGRESS、DONE）、handlingNote?、amazonCaseId?（人工处理信息，同步不覆盖）；`version`（乐观锁）；sourceReportJobId?；sourceUpdatedAt；syncedAt；`kind` 八类；`status` 取 OPEN、RESOLVED（RESOLVED 必须有 resolvedAt）；再次出现的已解决问题重开并回到 OPEN | `(tenantId, sellerAccountId, issueId)` | 否 | ✓ | R | M-P5-02 | P5-02 |

## 十七、审计

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `AuditEvent` | 修改 | 新增 beforeJson Json?；afterJson Json?；ip Str?；userAgent Str?；writeRunId Str?；stepUpId Str?；reason Str?；`occurredAt` 作为分区列 | `(id, occurredAt)` | **按月 `occurredAt`** | — | R | M-P1-27、M-P1-14 | P1-27、P1-14 |

---

## 十八、迁移顺序（按执行顺序）

| 序 | 迁移 | 内容 | 依赖 |
|---|---|---|---|
| 1 | M-P1-27 | 分区框架；将 `Order`、`OrderItem`、`FbaFinancialTransaction`、`FbaFeeEvent`、`AdsMetric`、`AdsTermMetric`、`AuditEvent` 改为按月分区（先加新表、回填、切换、后删旧表） | — |
| 2 | M-P1-12 | `MembershipScope`；`AdsProfile` 绑定字段 | 1 |
| 3 | M-P1-13 | `Role` 升级、`FieldPermission`、`MemberInvitation` | 2 |
| 4 | M-P1-14 | `IdempotencyRecord`、`StepUpVerification`；`AuditEvent` 扩展 | 1 |
| 5 | M-P1-15 | 现有 `PurchaseOrder` 增加 `version` | — |
| 6 | M-P1-16 | 现有全部租户表的行级安全策略；策略覆盖检查 | 以上 |
| 7 | M-P1-17 | `MfaFactor`；`Session` 扩展 | 6 |
| 8 | M-P1-20 | `WorkflowRun`、`WorkflowStep`、`DeadLetterJob`、`DistributedLock`；`SyncJob` 扩展 | 6 |
| 9 | M-P1-23 | `RawReportFile` | 6 |
| 9a | M-P1-24 | `DataEncryptionKey`（系统专用，租户账号无权限，系统账号不可删除） | 6 |
| 10 | M-P1-19 | 平台与租户生命周期 8 个模型；`Tenant` 修改 | 6、7 |
| 11 | M-P1-26 | `OrderCharge`、`OrderPackage`、`OrderCancellation`、`OrderStatusHistory`、`AccountBalanceSnapshot`、`ConnectorChannelState`、`ConnectorParityRun`、`ConnectorParityDiff`（后三张见 CR-021）；`Order`、`OrderItem`、`FbaFinancialTransaction` 字段迁移 | 1、6 |
| 12 | M-P1-28 | 平台能力全部模型（见第二、五、六、十、十六节） | 6、8 |
| 13 | M-P2a-01 … | 阶段 2a、2b、3、4、5 各工作包迁移，序号与第一至十七节"迁移"列一致，按工作包编号顺序执行 | 12 |

规则：**每个迁移都带"回滚方法"说明；创建新模型的迁移必须同时创建行级安全策略与分区（如适用）；持续集成的"策略覆盖检查"与"分区唯一键检查"必须通过。**

---

## 十九、覆盖核对

已用脚本核对：10.2 中出现的 188 个模型名，在本文每个都有定义行，无缺失、无重复。本文共 200 行，比 10.2 多出的 12 行是：10.1 要求的 3 张日汇总表（`StoreDailySummary`、`AsinDailySummary`、`AdsDailySummary`）、品牌分析 5 张表的命名（10.2 只写"5 张表"）、`ReimbursementRecord`（CR-002 已确认）、`AdsMetric` 与 `AuditEvent`（10.1 要求这两张表分区，但 10.2 的"修改的现有模型"没有列，属于 10.1 与 10.2 之间的漏列，在此补列）、`FbaSettlement`（07 章 7.7 结算列表需要补列，10.2 未列，见第二十节 G-11）。
P4-01 实现说明（CR-076）：`SalesTrafficDaily`、`SalesTrafficAsinDaily` 的比率列（购物车获得率、单位会话转化率、退款率）一律存 0 到 1 的小数（官方给百分数，导入时除以 100）；`SalesTrafficAsinDaily.sku` 非 SKU 粒度存空串（唯一键用，不能为空）；新增 `parentAsin`、`b2bUnits`、`ordersCount` 等列，见迁移 `20261119010000_sales_traffic`。

分区表共 19 张（`SalesTrafficDaily`、`SalesTrafficAsinDaily`、`HourlySalesEvent`、`HourlyTrafficEvent`、`HourlyInventoryEvent`、`AmazonNotificationEvent`、`InventoryDailySnapshot`、`Order`、`OrderItem`、`OrderCharge`、`FbaFinancialTransaction`、`FbaFeeEvent`、`EconomicsDaily`（P2b-11 实现为普通表，不分区，见 CR-049）、`AdsMetric`、`AdsTermMetric`、`AdsAdvertisedProductMetric`、`AdsConvertedProductDaily`、`AdsPerformanceHourly`、`AuditEvent`），唯一键均已包含分区列；10.1 乐观锁清单的 13 类对象均带版本号（另有 `Role` 等 12 个需要多人编辑的对象也带版本号）。

## 二十、需要你确认的事项（P0-02 产生）

| 编号 | 事项 | 我的处理 |
|---|---|---|
| G-07 | 10.1 要求的"经营日汇总、ASIN 日汇总、广告日汇总"3 张表，10.2 没有命名 | 命名为 `StoreDailySummary`、`AsinDailySummary`、`AdsDailySummary`（见第七节）；属补全命名，已确认 |
| G-08 | `AmazonNotificationEvent` 按月分区后唯一键必须带分区列，无法跨月去重通知编号 | **已确认选 B（CR-008）**：不新增表，同一月内去重，跨月靠小时事件业务幂等键 `(asin, hourStart)` 兜底 |
| G-09 | `InventoryLedgerEntry`（台账明细）数据量可能很大，10.1 的分区清单没有列它 | 按 10.1 原文不分区，P2a-09 用压测结果评估；若超过阈值提变更单，不自行改 |
| G-10 | 现有 `InventorySnapshot` 与新模型 `InventoryDailySnapshot` 重复 | 保留旧表直至 P2a-05 完成数据迁移（**已于 P2a-05 迁移**，见 CR-028），之后**已在 P5-12 删除**（迁移 `20261207010000_drop_inventory_snapshot`，CR-103）；删除前未用于任何新页面 |
| G-11 | `FbaSettlement` 需补列（期初余额、打款金额、交易数、对账状态、差异金额）以支撑 07 章 7.7 结算列表，10.2 的"修改的现有模型"未列该表 | 按补列处理，属于 10.2 漏列；你确认本文即视为确认 |
| CR-002 | 新增 `ReimbursementRecord`（官方赔付明细） | 见 `importers.md` 第九节 G-01；CR-002 已于 2026-10-21 确认 |
| 说明 | `Tenant` 的行级安全 | 平台能读取、租户只能读取自身行，策略单独写在 M-P1-19 |
| P5-07 | `LegalEntity` 补 `version`（乐观锁）与状态约束 | 迁移 `20261203010000_legal_entity_version`（含 `rollback.sql`）：`version Int @default(1)`；既有非 `ACTIVE`/`INACTIVE` 的状态值先归一为 `ACTIVE`，再加 CHECK `LegalEntity_status_check`（只允许 `ACTIVE`、`INACTIVE`）与 `LegalEntity_version_check`（`version >= 1`）；已有表、RLS 与授权不变，故不动 `regrant.sql` 与 `SEED_OVERRIDES` |
| P5-08 | `FieldPermission` 补 `ownerOnly`（“仅负责人可见”）；`Role` 补 `description`；`Membership` 补停用信息与状态约束 | 迁移 `20261204010000_members_roles`（含 `rollback.sql`）：`FieldPermission.ownerOnly Boolean @default(false)`（`allowed` 与 `ownerOnly` 同为真表示只有商品负责人能看到该商品的成本或利润）；`Role.description Text?`；`Membership.disabledAt`、`disabledReason`、`disabledBy`（可空）；既有非 `ACTIVE`/`DISABLED` 的状态值先按“已停用”归一，再加 CHECK `Membership_status_check`；没有新表，预设角色保护触发器只拦 UPDATE 与 DELETE 不受影响，故不动 `regrant.sql` 与 `SEED_OVERRIDES` |
| P5-09 | `AuditEvent` 补 `source`（`PAGE`/`API`/`SYSTEM`）与 `page`（页面路径模板），均可空；索引 `(tenantId, action, occurredAt)` | 迁移 `20261205010000_audit_center`（含 `rollback.sql`）：`source TEXT?`、`page TEXT?`、CHECK `AuditEvent_source_check`（空或 `PAGE`、`API`、`SYSTEM`）、索引 `AuditEvent_tenantId_action_occurredAt_idx`（供“个人信息明文查看”视图与大量查看预警按动作取数）；分区父表加列与索引自动应用到全部分区；旧记录不回填（应用角色对审计表只有 SELECT 与 INSERT）；没有新表，不动 `regrant.sql` 与 `SEED_OVERRIDES` |
| P5-11 | 新增 `UserPreference`（每个成员在每个企业一份通知偏好与免打扰）；`Notification` 补 `domain`、`silencedAt`、`summarizedAt` | 迁移 `20261206010000_personal_account`（含 `rollback.sql`）：`UserPreference(id, tenantId, userId, notifyJson Json, version Int @default(1), createdAt, updatedAt)`，唯一 `UserPreference_uq(tenantId, userId)`，CHECK `UserPreference_check`（`version >= 1`），租户行级安全 `tenant_isolation` 与应用角色授权；`Notification.domain TEXT?`（业务域，CHECK `Notification_domain_check`，按 `kind` 回填，`ALERT_RULE` 的旧行留空）、`silencedAt`（免打扰期间收到）、`summarizedAt`（已并入免打扰结束汇总），索引 `(tenantId, userId, silencedAt, summarizedAt)`；`regrant.sql` 的授权清单加入 `UserPreference`；没有行时视为默认偏好（全部接收、免打扰关闭），所以不需要为已有成员回填 |

---

## 二十一、阶段 6 新增与修改模型（CR-107，P6-00 登记；均未建表）

依据：14 章阶段 6 各工作包的“数据模型”一项，16 章；现有模型名与列名已对照 `database/prisma/schema.prisma`。**登记的是模型、关键字段与取舍，字段细节在各包的迁移里定稿**；约束沿用本文第零节：新表带 `tenantId`、行级安全、回滚方法，外键列单独建索引，新增 CHECK 的表要同步 `SEED_OVERRIDES`，新建租户表要同步 `regrant.sql`，每个迁移的时间戳晚于现有最新迁移 `20261207010000`（创建时才分配）。

对 14 章原文的三处校正（以本节为准）：

1. P6-15 原文写“`AlertInstance` 增加 `occurrenceCount` 与 `lastOccurredAt`”，但表里**已经有** `triggerCount`（默认 1）与 `lastTriggeredAt`，同一含义，**不再新增列**，直接复用；
2. P6-08 原文写“`InboundPlan` 增加 `sourceType` 与 `sourceId`”，实际模型是 `FbaInboundPlan`，**已有** `sourceType`（默认 `MANUAL`）与 `sourceRefId`，复用，只增加取值 `REPLENISHMENT_BATCH`；
3. P6-00 任务里举例的 `UserGridView`，以 P6-03 的名字 `GridView` 为准。

| 模型 | 状态 | 核心字段 | 唯一键 | 分区 | 版本 | RLS | 迁移 | 包 |
|---|---|---|---|---|---|---|---|---|
| `UserPreference` | 修改 | 新增 favoriteRoutes Str[]（收藏的路由模板，上限 30，P6-01 定稿，CHECK `UserPreference_favorites_check`）；density 文本 `COMPACT`/`STANDARD` 默认 `STANDARD`（CHECK `UserPreference_density_check`，迁移 `20261208010000_shell_preferences`，含 `rollback.sql`）。已有 `notifyJson`，P5-11 的通知偏好不动 | 保持 `(tenantId, userId)` | 否 | ✓（已有） | R | M-P6-01 | P6-01 |
| `GridView` | 新增 | gridId Str；kind Enum(VIEW/FILTER)（P6-04 的筛选方案共用本表）；scope Enum(SYSTEM/USER/TEAM)；ownerUserId Str?（TEAM、SYSTEM 为空）；name Str；config Json（列显示、顺序、列宽、固定、筛选、排序、维度；视图来源原样快照）；isDefault Bool。SYSTEM 行由迁移或系统任务写入，租户成员只读 | USER：`(tenantId, gridId, kind, ownerUserId, name)`；TEAM 与 SYSTEM：`(tenantId, gridId, kind, scope, name)`；同一 `(tenantId, gridId, kind, ownerUserId)` 至多一个默认（部分唯一）。**P6-03 已定稿（CR-111，迁移 `20261209010000_grid_view`，含 `rollback.sql`）**：另有 `createdBy Str?`（创建人，团队视图显示“谁建的”）、`version Int`（乐观锁，起始 1）、`createdAt`、`updatedAt`；索引 `GridView_tenantId_gridId_kind_idx`，部分唯一索引 `GridView_user_name_key`、`GridView_shared_name_key`（同名）、`GridView_user_default_key`、`GridView_shared_default_key`（同组至多一个默认，这四个不在 Prisma 模型里）；CHECK：kind、scope、owner（USER 必有 owner，其余必无）、name 1–40 字、version ≥ 1；启用 RLS。每个 `gridId` 个人 20 条、团队 30 条由服务层限制。**P6-04 启用 `kind = FILTER`（CR-112）**：筛选方案只用 `config.filters` 与 `config.dimension`，其余列版式字段取 `emptyViewConfig()` 的空值；筛选方案没有默认（前端保存时 `isDefault` 恒传 false，不提供“设为默认”入口，默认进入哪组筛选由 `VIEW` 的默认决定）；表结构与索引不变，无迁移 | 否 | ✓ | R | M-P6-03 | P6-03、P6-04 |
| `ShipFromAddress` | 新增 | sellerAccountId Str；name Str；addressLine1 Str；addressLine2 Str?；city Str；stateOrProvince Str；postalCode Str；countryCode Str；phone Str；isDefault Bool；status Enum(ACTIVE/INACTIVE)。被入仓计划用过的地址不能删除，只能停用 | `(tenantId, sellerAccountId, name)`；每个店铺至多一个默认（部分唯一） | 否 | ✓ | R | M-P6-08 | P6-08 |
| `FbaInboundPlan` | 修改 | 复用 `sourceType`、`sourceRefId`，`sourceType` 增加 `REPLENISHMENT_BATCH`（`sourceRefId` 存批次 id，P6-08 实现时定为 id 而不是批次号：批次号可以从批次反查，id 才是稳定外键；批次号写在草稿名称里）；新增 shipFromAddressId Str?（外键，`ON DELETE RESTRICT`） | 不变 | 否 | ✓（已有） | R | M-P6-08 | P6-08 |
| `ForecastOverride` | 新增 | scopeType Enum(SKU/CATEGORY)；scopeId Str；from D；to D；mode Enum(FIXED/YOY_FACTOR)（固定日销 / 去年同期乘系数）；value Dec；createdBy Str。**P6-09 定稿（CR-117）**：同一天 SKU 规则 > 品类规则 > 模型；同一对象时间段不允许重叠（保存时 409）；另有 note Str?、version Int（乐观锁）、createdAt/updatedAt；起止含首尾、最长 366 天；全企业未结束规则最多 300 条；已启用行级安全 | `id`；`(tenantId, scopeType, scopeId, from)` 建索引 | 否 | ✓ | R | M-P6-09 | P6-09 |
| `ReplenishmentPolicy` | 修改 | 新增 includeUnavoidableShortage Bool 默认 false（“计入必断货量”，属于策略版本）。批次计算快照增加 `supplyInLeadTime`、`supplyBeyondLeadTime`、`unavoidableShortage`、`unavoidableIncluded`、`appliedOverride` 五个键（写在 `ReplenishmentRecommendation.calcStepsJson`，沿用现有 Json 列，不新增列；批次冻结后不随规则修改而变；P6-09 之前的旧批次没有这些键，页面写“旧批次没有记录”） | 不变 | 否 | ✓（已有） | R | M-P6-09 | P6-09 |
| `SkuAlias` | 新增（P6-11 已定稿，迁移 `20261213010000_sku_alias`） | supplierId Str?；externalCode Str；sku Str；source Enum(MANUAL/IMPORT)；version Int（乐观锁）；createdBy Str | `(tenantId, supplierId, externalCode)` 唯一（`SkuAlias_uq`），`supplierId` 为空时部分唯一索引 `SkuAlias_global_key`（`WHERE supplierId IS NULL`）兜底；有行级安全与检查约束；每个企业最多 50000 条 | 否 | — | R | M-P6-11 | P6-11 |
| `PackingListMapping` | 新增（P6-11 已定稿，同一迁移） | supplierId Str；columns Json（标准列 → 该供应商装箱单里的**表头文字**，不是列序号）；units Json?（`{ length?, weight? }`）；version Int（乐观锁）；updatedBy Str | `(tenantId, supplierId)` 唯一 | 否 | ✓ | R | M-P6-11 | P6-11 |
| `LabelTemplate` | 新增（P6-12 已定稿，迁移 `20261214010000_label_template`） | name Str；options Json（勾选项：原产地与文字、SKU、品名、FNSKU、箱内件数、我方箱号、任务名称页、追加到原标签、标签顺序 AMAZON/OURS）；paper Str（CHECK：THERMAL_4X6/A4_2UP/A4_4UP）；boxNoRule Json（前缀、是否带计划号、递增位数、起始序号、后缀、连接符）；isDefault Bool；version Int（乐观锁）；createdBy；createdAt；updatedAt | `(tenantId, name)` 唯一；全企业至多一个默认（部分唯一索引 `isDefault`）；CHECK：名称 1-40 字、options 与 boxNoRule 是对象 | 否 | ✓ | R | M-P6-12 | P6-12 |
| `LabelPrintLog` | 新增（P6-12 已定稿） | planId Str（外键，计划删除级联）；shipmentId Str?（我方货件行编号；整个计划的商品标签为空）；templateId Str?（模板删除后置空，记录保留）；kind Str（CHECK：BOX_CUSTOM/ITEM）；labelCount Int；exportJobId Str?；printedBy Str；printedAt Dt。只记成功生成的文件（worker 在导出任务完成的同一事务里写） | `id`；索引 `(tenantId, shipmentId, printedAt)`、`planId`、`shipmentId`、`templateId` | 否 | ✓ | R | M-P6-12 | P6-12 |`n| `ExportJob.format` | 改约束（P6-12） | CHECK 由 `CSV/XLSX` 扩为 `CSV/XLSX/PDF`：自定义箱标签、商品标签走导出中心，结果是 PDF；PDF 任务类型 `inbound-box-labels`、`inbound-item-labels` 不在通用导出的 `EXPORT_KINDS` 里（通用 `POST /exports` 不能创建），只能由入仓标签接口创建 | — | — | — | — | M-P6-12 | P6-12 |
| `ReturnReasonMap` | 新增 | code Str（亚马逊退货原因代码）；labelZh Str；category Str（约 12 个大类）；isSystem Bool；未映射的新代码自动加一行并标“未分类” | `(tenantId, code)` | 否 | ✓ | R | M-P6-13 | P6-13（P6-13 已实现：主键 `id`（与其他租户表一致，通用的导出与隔离测试按 id 取行）、`(tenantId, code)` 唯一，迁移 `20261215010000_return_reason_map`，带行级隔离与回滚脚本；预置的 22 个代码在代码里，表里只存企业改过的预置项、自己加的项与导入时自动发现的新代码，`isSystem` 表示由导入自动加入；每企业最多 500 行） |
| `FbaReturnCase` | 修改 | **P6-13（已实现）**：新增 orderPurchasedAt Dt? 与 orderShippedAt Dt?（冗余列：同步退货报告时按订单回填，缺订单保持为空，每次导入顺带回填最多 2000 条仍为空的存量；迁移里也回填一次；索引 `FbaReturnCase_orderdate_idx`）；**P6-14（已实现，迁移 `20261216010000_return_comment_cipher`，带 `rollback.sql`）**：新增 customerCommentsCipher Str?（买家备注密文，密钥用途 `buyer-pii`，与订单买家信息同一套密钥）、customerCommentsExpiresAt Dt?（保留期截止：发货日，未知时用退货日，加 min(企业设置, 30) 天；订单发货日回填后只会提前；索引 `FbaReturnCase_commentexp_idx`）、customerCommentsKinds Str?（识别出的个人信息类别，逗号串，不含内容）；**明文列 `customerComments` 本迁移保留**（先加后删）：代码不再读写它，存量由 worker 的回填任务加密并清空，确认清空后运行 `database/ops/drop-return-comment-plaintext.sql`（带检查，还有明文就拒绝；不在 `migrations` 里，待后续发布配合删除 schema 字段与回填代码时执行） | 不变 | 否 | — | R | M-P6-13、M-P6-14 | P6-13、P6-14 |
| `AlertRead` | 新增 | alertId Str；userId Str；readAt Dt（按用户记录已读，处理状态仍在 `AlertInstance.status`，两套状态互不影响） | `(tenantId, alertId, userId)` | 否 | — | R | M-P6-15 | P6-15（**已实现，CR-123**：迁移 `20261217010000_alert_read`，带 `rollback.sql`、行级隔离与授权；主键 `id`，`(alertId, userId)` 唯一，`(tenantId, userId)` 索引，`userId` 非空字符串的 CHECK；预警删除时级联删除；没有 `readAt` 以外的状态，取消已读就是删行（本包只在“冷却期外再次触发”时由 worker 批量删） ） |
| `AlertInstance` | 修改 | **不新增列**：合并后的触发次数用既有 `triggerCount`，最近触发时间用既有 `lastTriggeredAt`（见上面的校正 1）。合并只发生在上一条尚未处理、且冷却期之外再次触发时；处理之后再触发生成新的一条 | 不变 | 否 | — | R | — | P6-15（**已实现，CR-123**：上一条仍在新/已确认状态时，再次命中一律并入（次数加一、刷新最近触发时间与证据，这是 P1-28-5 起的既有行为）；距上次命中超过冷却期时，并入之后额外清掉所有人的已读并提醒待办负责人一次；处理之后冷却期内不新建、冷却期外新建一条，见 `apps/worker/src/platform/alert-evaluate.ts` 的 `mergeIntoOpen`） |
| `AlertRule` | 修改 | **P6-16 已实现（CR-125，迁移 `20261218010000_alert_rule_notify`；notifyFrequency 用 Str + 数据库 CHECK；escalation 只存各级时限 `[{ afterMinutes }]`，通知对象固定为待办负责人、规则通知对象、预警管理员）**：新增 conditionGroups Json?（P6-07 的 `ConditionGroups`，评估器类型 `CUSTOM_METRIC` 读它）；notifyFrequency Enum(IMMEDIATE/HOURLY/DAILY) 默认 IMMEDIATE；escalation Json?（逐级时限与对象）；每家企业自定义规则默认上限 50 条 | 不变 | 否 | ✓（已有） | R | M-P6-16 | P6-16 |
| `AlertDigest` | 新增 | **P6-16 已实现（CR-125），与冻结稿不同（已回写）**：ruleId Str；kind Str（`FREQUENCY` 频率批次 / `QUIET` 静默批次 / `ESCALATION` 升级幂等记录；冻结稿的 `QUIET_END` 改名 `QUIET`）；dedupKey Str（频率批次 `freq:规则:时段`，静默批次 `quiet:规则:pending`、发送后改成带时间的键，升级 `esc:预警:级别`）；status Str（`PENDING`/`SENT`，CHECK 要求 `status=SENT` 与 `sentAt` 非空同真假）；alertIds Json（并入的预警编号，最多 500）；itemCount Int；sentAt Dt?；**没有** windowStart、windowEnd、alertCount、notificationId（时段在 dedupKey 里，计数是 itemCount，通知的 `dedupKey` 为 `alert-digest:批次编号`） | `(tenantId, dedupKey)` | 否 | — | R | M-P6-16 | P6-16 |
| `OfferCompetitor` | 新增 | sellerAccountId Str；sku Str；sellerId Str（对方卖家编号）；firstSeenAt Dt；lastSeenAt Dt；price Dec；currency Str；isFba Bool；hasBuybox Bool。数据只来自官方竞争摘要，不抓前台 | `(tenantId, sellerAccountId, sku, sellerId)` | 否 | — | R | M-P6-17 | P6-17 |
| `HijackWhitelist` | 新增 | sellerId Str；note Str?；createdBy Str（企业级白名单，例如自己的其他店铺） | `(tenantId, sellerId)` | 否 | — | R | M-P6-17 | P6-17 |
| `PricingRule` | 修改 | 新增 scenarioMatrix Json?（“情形 × 动作”矩阵；目标价超出护栏时不执行并记录原因，执行结果仍写 `PricingRuleRun`） | 不变 | 否 | ✓（已有） | R | M-P6-17 | P6-17 |
| `ProfitItem` | 新增 | parentId Str?；level Int（1 至 3）；name Str；group Enum(REVENUE/PLATFORM_FEE/LOGISTICS_FEE/ADS/PRODUCT_COST/OTHER)；sign Int（+1 或 −1）；isSystem Bool（系统项目不能删除、可改名）；**systemKey Str?**（P6-18 实施时新增：系统项目的稳定键，一级是 G_ 开头，二级是利润桥项目键或 EXCLUDED；(tenantId, systemKey) 唯一，库里有触发器拦截直接删除系统项目）；sort Int | `(tenantId, parentId, name)` | 否 | ✓ | R | M-P6-18 | P6-18 |
| `ProfitItemMapping` | 新增 | transactionType Str（原始交易类型，格式 分类/子类型，没有子类型只有分类）；itemId Str（外键 `ProfitItem`）。没有映射的交易类型单独列出，不丢失 | `(tenantId, transactionType)` | 否 | ✓ | R | M-P6-18 | P6-18 |
| `MetricVersion` | 新增 | kind Enum(PROFIT_FORMULA/BUSINESS_RULES/PROFIT_DICTIONARY/ALLOCATION_RULES)；**versionNo Int**（版本号，**不叫 `version`**：本文约定里 `version` 是乐观锁列，14 章原文的字段名 `version` 在此改为 `versionNo`，与 `CostVersion` 一致）；config Json；status Enum(DRAFT/PENDING_APPROVAL/ACTIVE/RETIRED)；effectiveFrom Dt?；approvedBy Str?。每家企业每种 kind 同一时刻至多一个 ACTIVE（部分唯一） | `(tenantId, kind, versionNo)` | 否 | ✓（乐观锁，另设 `version`） | R | M-P6-18（建表）、M-P6-31（接入） | P6-18、P6-31 |
| `AllocationRule` | 新增（**P6-19 已建，CR-128**：另有 `version` 乐观锁、`createdBy`、数据库 CHECK） | feeItemId Str（外键 `ProfitItem`）；basis Enum(SALES_AMOUNT/SALES_UNITS/SHIPMENT_RECEIVED_UNITS/REMOVAL_ORDER_SKU/MANUAL)；manualWeights Json?；effectiveMonth D（当月第一天） | `(tenantId, feeItemId, effectiveMonth)` | 否 | ✓ | R | M-P6-19 | P6-19 |
| `PeriodSnapshot` | 修改 | 新增 metricVersionSnapshotJson Json?（关账时各类口径版本：分摊规则、利润公式、业务口径、利润项目字典；旧快照为空，表示关账时还没有口径版本）。已关账月份不受之后的修改影响；按新口径重算时生成差异报告，不改动快照 | 不变 | 否 | — | R | M-P6-19（先加列，写分摊规则版本）、M-P6-31（写其余类型） | P6-19、P6-31 |
| `EstimatedFee` | 新增 | itemId Str（外键 `ProfitItem`，自定义项目挂在字典上）；scopeType Enum(STORE/SKU/CATEGORY)；scopeId Str；mode Enum(FIXED/PERCENT_OF_SALES)；value Dec；currency Str；period Enum(DAILY/MONTHLY)；from D；to D?；status Enum(ACTIVE/INACTIVE)。**P6-20 已定稿（CR-129）**：冲销不存储——利润重算时按实际费用事件（同店铺、同费用项）的入账日现算，按日规则看当天、按月规则看当月，撤销实际费用后下次重算自动恢复；生效区间：同费用项同范围、状态为生效的规则两端含、不得重叠（相邻可，409），停用不参与；币种只接受 USD；比例规则周期固定按日；另给 `ProfitDaily` 加列 `estimatedFee`（该行含的估算金额，≥0）与标记 `ESTIMATE_INCLUDED` | `id`；索引 `(tenantId, scopeType, scopeId, from)` | 否 | ✓ | R | M-P6-20 | P6-20 |
| `Carrier` | 新增 | name Str；code Str（大写）；status Enum(ACTIVE/INACTIVE)；version Int（乐观锁）；createdBy | `(tenantId, code)` | 否 | ✓ | R | M-P6-26（`20261224010000_carrier_rates`） | P6-26 |
| `CarrierChannel` | 新增 | carrierId Str；name Str；code Str；volumetricDivisor Dec（材积除数，默认 6000，大于 0）；splitFactor Dec（分抛系数，(0,1]，默认 1）；status Enum(ACTIVE/INACTIVE)；version Int | `(tenantId, carrierId, code)` | 否 | ✓ | R | M-P6-26 | P6-26 |
| `ChannelRate` | 新增 | channelId Str；region Str（目的地区）；weightFrom Dec；weightTo Dec?；unitPrice Dec；currency Str；billingMode Str（定稿取值 PER_KG 按计费重量每公斤 / PER_CBM 按体积每立方米 / FLAT 整票一口价，默认 PER_KG；CHECK 约束）；effectiveFrom D；effectiveTo D?；version Int；检查约束：weightTo > weightFrom、unitPrice ≥ 0、currency 三位大写字母、effectiveTo ≥ effectiveFrom | `(tenantId, channelId, region, weightFrom, effectiveFrom)` | 否 | — | R | M-P6-26 | P6-26 |
| `FirstMileShipment` | 修改 | 定稿新增 carrierChannelId Str?（外键 Restrict，带索引 `FirstMileShipment_channel_idx`）、estimatedAt Dt?（采用渠道预估时写入；预估试算本身不落库）。`estimatedCost`、币种沿用原列，不另建 estimatedCurrency。实际费用仍在 `FirstMileCost` | 不变 | 否 | ✓（已有） | R | M-P6-26 | P6-26 |
| `ApprovalRequest` | 新增 | type Enum(FINANCE_POLICY/PROFIT_FORMULA/PERIOD_CLOSE/PRICING_RULE_CONFIRM/ADS_RULE_CONFIRM/BULK_PRICE/BULK_BUDGET)；objectType Str；objectId Str；title Str；summary Json（提交时的摘要快照）；requesterId Str；approverIds Str[]；ccIds Str[]；status Enum(PENDING/APPROVED/REJECTED/CANCELLED)；decidedBy Str?；decidedAt Dt?；comment Str?。审批人不能与发起人相同；状态变化回写各模块 | `(tenantId, type, objectType, objectId)` 且 `status = PENDING` 部分唯一 | 否 | ✓ | R | M-P6-27 | P6-27（已实施：迁移 `20261225010000_approval_requests`，另有 `version`、`createdAt`、`updatedAt`，检查约束） |
| `PricingCalcRecord` | 新增 | name Str?；inputHash Str；inputJson Json（采购成本、头程方式与单价、尺寸重量、售价、品类）；resultJson Json（费用预估结果）；estimatedAt Dt；createdBy Str。同样参数 24 小时内复用结果，复用判断用 `inputHash` 与 `estimatedAt`。**P6-29 已定稿（CR-154）**：不另用 Redis；另有 `saved`（默认 false，name 可空，不能靠 name 区分缓存与用户保存的记录）、`createdAt`。列表只返回本人且 `saved=true` 的行。费率表版本常量 `US-FBA-2025-NONPEAK`，与官方实收不一致时以费用预估接口回写为准 | `id`；索引 `(tenantId, inputHash, estimatedAt)` | 否 | — | R | M-P6-29 | P6-29 |
| `CustomMetric` | 新增 | key Str；name Str；expression Json（**P6-32 已定稿（CR-155）**：`{ text, ast }`，ast 是语法树）；dimensions Str[]；format Json（`{ kind }`）；createdBy Str；version Int | `(tenantId, key)` | 否 | ✓ | R | M-P6-32（`20261227010000_custom_report`） | P6-32 |
| `CustomReport` | 新增 | ownerId Str；name Str；shared Bool；source Str（数据源编码）；config Json（维度、指标、筛选）；schedule Json?（**CR-155**：`{ frequency: DAILY/WEEKLY, hour, weekday?, lastRunAt? }`，按 UTC，定时在 API 进程）。收藏是 `starredBy Str[]`（用户编号，不另建表） | `id`；索引 `(tenantId, ownerId)` | 否 | ✓ | R | M-P6-32 | P6-32 |
| `DashboardFolder` | 新增 | parentId Str?；name Str；ownerId Str。**P6-33 已实现（CR-156）**：同级重名由服务端拒绝（唯一索引对空的 parentId 不互斥）；最多 50 个、深度 8 | `(tenantId, ownerId, parentId, name)` | 否 | ✓ | R | M-P6-33（`20261228010000_dashboard`） | P6-33 |
| `Dashboard` | 新增 | folderId Str?；ownerId Str；name Str；shared Bool；layout Json（12 列网格）；**CR-156** 另有 `refreshMinutes`（空=不自动刷新，5–1440）、`version` | `(tenantId, ownerId, folderId, name)` | 否 | ✓ | R | M-P6-33 | P6-33 |
| `DashboardWidget` | 新增 | dashboardId Str；type Enum(METRIC_CARD/LINE/BAR/HORIZONTAL_BAR/PIE/TABLE/TEXT)；query Json（绑定的 P6-32 数据源查询）；options Json。每盘最多 24 个 | `id`；索引 `(tenantId, dashboardId)` | 否 | — | R | M-P6-33 | P6-33 |

不新增模型的阶段 6 工作包：P6-02、P6-05、P6-07（纯前端或契约纯函数）；P6-06（事件接口只读合并 `OperationLog`、`EntityEvent`、`AuditEvent`、`AlertInstance`、价格与刊登变更、`AdsChangeLog`；**已实现（CR-114），只加两个读取索引、不改列**：`AlertInstance(tenantId, sellerAccountId, firstTriggeredAt)`、`ListingChangeEvent(sellerAccountId, occurredAt)`，迁移 `20261210010000_event_indexes` 带回滚）；P6-10（装箱草稿沿用既有 `InboundBox` 等表）；P6-21、P6-22、P6-23、P6-24、P6-25、P6-28、P6-30。**P6-22 如果要物化汇总表，必须先提变更单登记模型，再建表**（本文第一段约束）；P6-18 关税进利润桥要给利润日表加的列，也在 P6-18 的迁移检查里列出。

> **P6-18 补充（CR-127）**：（1）`ProfitDaily` 新增两列 `dutyCost Dec?`（关税 = 生效成本版本的单件关税 × 件数，没有关税为 null）与 `itemAmounts Json?`（按字典项目拆分的带符号净利润贡献，键为项目编号，或 `~:目标`（未映射、按内置口径））；（2）`MetricVersion` 本包只用 `PROFIT_DICTIONARY`，每次整树保存退役旧版本并新增一版，`config` 存完整快照；（3）`ProfitItem.parentId` 与 `ProfitItemMapping.itemId` 的外键都是 ON DELETE CASCADE（删项目时子项目与映射一起删）。

所有新表按 `regrant.sql` 与 `SEED_OVERRIDES` 的既有规则处理（见 `PROGRESS.md` “环境与踩过的坑”）；预计合计新增 27 张表（`GridView`、`ShipFromAddress`、`ForecastOverride`、`SkuAlias`、`PackingListMapping`、`LabelTemplate`、`LabelPrintLog`、`ReturnReasonMap`、`AlertRead`、`AlertDigest`、`OfferCompetitor`、`HijackWhitelist`、`ProfitItem`、`ProfitItemMapping`、`MetricVersion`、`AllocationRule`、`EstimatedFee`、`Carrier`、`CarrierChannel`、`ChannelRate`、`ApprovalRequest`、`PricingCalcRecord`、`CustomMetric`、`CustomReport`、`DashboardFolder`、`Dashboard`、`DashboardWidget`），给 8 张已有表加列（`UserPreference`、`FbaInboundPlan`、`ReplenishmentPolicy`、`FbaReturnCase`、`AlertRule`、`PricingRule`、`PeriodSnapshot`、`FirstMileShipment`；`AlertInstance` 只复用已有列，不加列）。
