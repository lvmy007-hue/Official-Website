-- M-P1-28 平台能力：写入开关、汇率、待办、预警、通知、导出、保存视图、协作、推送订阅、数据新鲜度、企业设置项。
-- 依据：freeze/models.md 第十一项迁移（M-P1-28）、09 章 9.4、9.5、9.13、9.14、9.15；04 章 4.3；14 章 P1-28。
--
-- 内容：
--   一、新增 20 张表（AmazonNotificationEvent 按月分区，分区列 receivedAt）。
--   二、部分唯一索引（Prisma 不能表达，手写）：预警实例“新”状态去重、通知去重、保存视图每人每页一个默认。
--   三、关账锁定：汇率行被期间关账锁定后，数据库禁止修改与删除（触发器）。
--   四、行级安全与授权。
--
-- 回滚方法：见同目录 rollback.sql（删除新增表与触发器；会丢失这些表中的全部数据，不在自动流程中执行）。
-- 本迁移只新增表与函数，不修改、不删除任何既有对象。

-- ============================================================
-- 一、新增表
-- ============================================================

CREATE TABLE "IntegrationSwitch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "switchKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "enabledAt" TIMESTAMP(3),
  "enabledBy" TEXT,
  "reason" TEXT,
  "autoDisabledReason" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "calls7d" INTEGER NOT NULL DEFAULT 0,
  "failures7d" INTEGER NOT NULL DEFAULT 0,
  "statsJson" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationSwitch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationSwitch_switchKey_check" CHECK ("switchKey" LIKE 'sw.%'),
  CONSTRAINT "IntegrationSwitch_counters_check" CHECK ("consecutiveFailures" >= 0 AND "calls7d" >= 0 AND "failures7d" >= 0)
);
-- 企业级开关的店铺列为空：空值也算同一个值（PostgreSQL 15 起支持），否则同一开关可以重复创建
CREATE UNIQUE INDEX "IntegrationSwitch_tenantId_sellerAccountId_switchKey_key" ON "IntegrationSwitch"("tenantId", "sellerAccountId", "switchKey") NULLS NOT DISTINCT;
CREATE INDEX "IntegrationSwitch_sellerAccountId_idx" ON "IntegrationSwitch"("sellerAccountId");
ALTER TABLE "IntegrationSwitch" ADD CONSTRAINT "IntegrationSwitch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationSwitch" ADD CONSTRAINT "IntegrationSwitch_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IntegrationSwitchLog" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "switchKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorId" TEXT,
  "beforeJson" JSONB NOT NULL,
  "afterJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationSwitchLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationSwitchLog_action_check" CHECK ("action" IN ('ENABLE', 'DISABLE', 'AUTO_DISABLE', 'READONLY_ALL', 'EMERGENCY_OFF'))
);
CREATE INDEX "IntegrationSwitchLog_tenantId_sellerAccountId_switchKey_cre_idx" ON "IntegrationSwitchLog"("tenantId", "sellerAccountId", "switchKey", "createdAt");
ALTER TABLE "IntegrationSwitchLog" ADD CONSTRAINT "IntegrationSwitchLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FxRate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
  "quoteCurrency" TEXT NOT NULL,
  "rateDate" DATE NOT NULL,
  "rate" DECIMAL(18,8) NOT NULL,
  "source" TEXT NOT NULL,
  "isFallback" BOOLEAN NOT NULL DEFAULT false,
  "sourceDate" DATE,
  "isManualOverride" BOOLEAN NOT NULL DEFAULT false,
  "overrideReason" TEXT,
  "overriddenBy" TEXT,
  "lockedByPeriodId" TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxRate_rate_check" CHECK ("rate" > 0),
  CONSTRAINT "FxRate_base_check" CHECK ("baseCurrency" = 'USD' AND "quoteCurrency" <> "baseCurrency"),
  CONSTRAINT "FxRate_override_check" CHECK (NOT "isManualOverride" OR ("overrideReason" IS NOT NULL AND "overriddenBy" IS NOT NULL))
);
CREATE UNIQUE INDEX "FxRate_tenantId_baseCurrency_quoteCurrency_rateDate_source_key" ON "FxRate"("tenantId", "baseCurrency", "quoteCurrency", "rateDate", "source");
CREATE INDEX "FxRate_tenantId_quoteCurrency_rateDate_idx" ON "FxRate"("tenantId", "quoteCurrency", "rateDate");
ALTER TABLE "FxRate" ADD CONSTRAINT "FxRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FxSourceConfig" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "pathTemplate" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastStatus" TEXT,
  "lastErrorCode" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FxSourceConfig_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxSourceConfig_role_check" CHECK ("role" IN ('PRIMARY', 'BACKUP'))
);
CREATE UNIQUE INDEX "FxSourceConfig_tenantId_role_key" ON "FxSourceConfig"("tenantId", "role");
ALTER TABLE "FxSourceConfig" ADD CONSTRAINT "FxSourceConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkItem" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "title" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "severity" TEXT NOT NULL DEFAULT 'INFO',
  "dueAt" TIMESTAMP(3),
  "slaBreachedAt" TIMESTAMP(3),
  "escalatedAt" TIMESTAMP(3),
  "sourceAlertId" TEXT,
  "ruleCode" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "entityLabel" TEXT,
  "impactMin" DECIMAL(20,6),
  "impactMax" DECIMAL(20,6),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "suggestedAction" TEXT,
  "detail" TEXT,
  "closeConclusion" TEXT,
  "closeNote" TEXT,
  "ignoreReason" TEXT,
  "deferredUntil" TIMESTAMP(3),
  "ackAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closedBy" TEXT,
  "ownerId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkItem_status_check" CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'DONE', 'CLOSED')),
  CONSTRAINT "WorkItem_source_check" CHECK ("source" IN ('ALERT', 'MANUAL', 'SYSTEM')),
  CONSTRAINT "WorkItem_priority_check" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT "WorkItem_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT "WorkItem_closeConclusion_check" CHECK ("closeConclusion" IS NULL OR "closeConclusion" IN ('HANDLED', 'NOT_NEEDED', 'FALSE_POSITIVE', 'IGNORED')),
  -- 已结束的待办必须有结论；忽略必须有原因
  CONSTRAINT "WorkItem_closed_check" CHECK (("status" IN ('DONE', 'CLOSED')) = ("closeConclusion" IS NOT NULL)),
  CONSTRAINT "WorkItem_ignore_check" CHECK ("closeConclusion" IS DISTINCT FROM 'IGNORED' OR "ignoreReason" IS NOT NULL),
  CONSTRAINT "WorkItem_impact_check" CHECK ("impactMin" IS NULL OR "impactMax" IS NULL OR "impactMin" <= "impactMax")
);
CREATE INDEX "WorkItem_tenantId_ownerId_status_idx" ON "WorkItem"("tenantId", "ownerId", "status");
CREATE INDEX "WorkItem_tenantId_status_dueAt_idx" ON "WorkItem"("tenantId", "status", "dueAt");
CREATE INDEX "WorkItem_tenantId_createdBy_idx" ON "WorkItem"("tenantId", "createdBy");
CREATE INDEX "WorkItem_tenantId_sourceAlertId_idx" ON "WorkItem"("tenantId", "sourceAlertId");
CREATE INDEX "WorkItem_tenantId_ruleCode_closedAt_idx" ON "WorkItem"("tenantId", "ruleCode", "closedAt");
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Assignment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "assigneeId" TEXT NOT NULL,
  "assignedBy" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Assignment_workItemId_assigneeId_key" ON "Assignment"("workItemId", "assigneeId");
CREATE INDEX "Assignment_tenantId_assigneeId_idx" ON "Assignment"("tenantId", "assigneeId");
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "conditionJson" JSONB NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'WARNING',
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "scopeJson" JSONB NOT NULL,
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlertRule_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT "AlertRule_cooldown_check" CHECK ("cooldownMinutes" BETWEEN 0 AND 10080)
);
CREATE UNIQUE INDEX "AlertRule_tenantId_code_key" ON "AlertRule"("tenantId", "code");
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertRuleVersion" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "versionNo" INTEGER NOT NULL,
  "conditionJson" JSONB NOT NULL,
  "changedBy" TEXT NOT NULL,
  "changeReason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AlertRuleVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AlertRuleVersion_ruleId_versionNo_key" ON "AlertRuleVersion"("ruleId", "versionNo");
CREATE INDEX "AlertRuleVersion_tenantId_ruleId_idx" ON "AlertRuleVersion"("tenantId", "ruleId");
ALTER TABLE "AlertRuleVersion" ADD CONSTRAINT "AlertRuleVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertRuleVersion" ADD CONSTRAINT "AlertRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertInstance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "ruleId" TEXT NOT NULL,
  "ruleVersionNo" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "firstTriggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastTriggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "triggerCount" INTEGER NOT NULL DEFAULT 1,
  "evidenceJson" JSONB NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "workItemId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AlertInstance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlertInstance_status_check" CHECK ("status" IN ('NEW', 'ACKED', 'HANDLED', 'IGNORED', 'AUTO_CLOSED')),
  CONSTRAINT "AlertInstance_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL'))
);
CREATE INDEX "AlertInstance_tenantId_ruleId_status_idx" ON "AlertInstance"("tenantId", "ruleId", "status");
CREATE INDEX "AlertInstance_tenantId_status_lastTriggeredAt_idx" ON "AlertInstance"("tenantId", "status", "lastTriggeredAt");
CREATE INDEX "AlertInstance_ruleId_idx" ON "AlertInstance"("ruleId");
ALTER TABLE "AlertInstance" ADD CONSTRAINT "AlertInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertInstance" ADD CONSTRAINT "AlertInstance_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 同一规则、同一店铺（含空）、同一去重键在“新”状态下只有一条
CREATE UNIQUE INDEX "AlertInstance_open_dedupe_key" ON "AlertInstance"("tenantId", "sellerAccountId", "ruleId", "dedupKey") NULLS NOT DISTINCT WHERE "status" = 'NEW';

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'INFO',
  "readAt" TIMESTAMP(3),
  "dedupKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_severity_check" CHECK ("severity" IN ('INFO', 'WARNING', 'CRITICAL'))
);
CREATE INDEX "Notification_tenantId_userId_createdAt_idx" ON "Notification"("tenantId", "userId", "createdAt");
CREATE INDEX "Notification_tenantId_userId_readAt_idx" ON "Notification"("tenantId", "userId", "readAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Notification_user_dedupe_key" ON "Notification"("userId", "dedupKey") WHERE "dedupKey" IS NOT NULL;

CREATE TABLE "ExportJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sourcePage" TEXT NOT NULL,
  "filterSummary" TEXT NOT NULL,
  "filterJson" JSONB NOT NULL,
  "format" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "rowCount" INTEGER,
  "fileKey" TEXT,
  "fileSize" INTEGER,
  "errorCode" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "fieldPolicySnapshot" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExportJob_format_check" CHECK ("format" IN ('CSV', 'XLSX')),
  CONSTRAINT "ExportJob_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED'))
);
CREATE INDEX "ExportJob_tenantId_requestedBy_createdAt_idx" ON "ExportJob"("tenantId", "requestedBy", "createdAt");
CREATE INDEX "ExportJob_status_expiresAt_idx" ON "ExportJob"("status", "expiresAt");
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SavedView" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pageKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "filterJson" JSONB NOT NULL,
  "columnsJson" JSONB NOT NULL,
  "sortJson" JSONB NOT NULL,
  "ownerId" TEXT NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedView_ownerId_pageKey_name_key" ON "SavedView"("ownerId", "pageKey", "name");
CREATE INDEX "SavedView_tenantId_pageKey_shared_idx" ON "SavedView"("tenantId", "pageKey", "shared");
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 每人每页最多一个默认视图
CREATE UNIQUE INDEX "SavedView_default_key" ON "SavedView"("ownerId", "pageKey") WHERE "isDefault";

CREATE TABLE "EntityEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL,
  "detailJson" JSONB,
  "actorKind" TEXT NOT NULL DEFAULT 'SYSTEM',
  "actorId" TEXT,
  "sourceRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EntityEvent_actorKind_check" CHECK ("actorKind" IN ('USER', 'SYSTEM', 'AMAZON', 'EXTERNAL'))
);
-- 来源标识为空的事件（手工记录）也要去重：同一对象、同一类型、同一时刻只能有一条
CREATE UNIQUE INDEX "EntityEvent_tenantId_entityType_entityId_kind_occurredAt_so_key" ON "EntityEvent"("tenantId", "entityType", "entityId", "kind", "occurredAt", "sourceRef") NULLS NOT DISTINCT;
CREATE INDEX "EntityEvent_tenantId_entityType_entityId_occurredAt_idx" ON "EntityEvent"("tenantId", "entityType", "entityId", "occurredAt");
ALTER TABLE "EntityEvent" ADD CONSTRAINT "EntityEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OperationLog" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "scope" TEXT NOT NULL,
  "scopeRef" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "category" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "attachmentIds" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperationLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperationLog_scope_check" CHECK ("scope" IN ('STORE', 'ASIN', 'CAMPAIGN'))
);
CREATE INDEX "OperationLog_tenantId_scope_scopeRef_occurredAt_idx" ON "OperationLog"("tenantId", "scope", "scopeRef", "occurredAt");
ALTER TABLE "OperationLog" ADD CONSTRAINT "OperationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Comment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "mentions" TEXT[],
  "authorId" TEXT NOT NULL,
  "parentId" TEXT,
  "editedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Comment_tenantId_entityType_entityId_createdAt_idx" ON "Comment"("tenantId", "entityType", "entityId", "createdAt");
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Watch" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Watch_userId_entityType_entityId_key" ON "Watch"("userId", "entityType", "entityId");
CREATE INDEX "Watch_tenantId_entityType_entityId_idx" ON "Watch"("tenantId", "entityType", "entityId");
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationSubscription" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "destinationId" TEXT NOT NULL,
  "notificationType" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "filterJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'NOT_CREATED',
  "lastReceivedAt" TIMESTAMP(3),
  "events24h" INTEGER NOT NULL DEFAULT 0,
  "failures24h" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationSubscription_status_check" CHECK ("status" IN ('ACTIVE', 'INVALID', 'NOT_CREATED'))
);
CREATE UNIQUE INDEX "NotificationSubscription_sellerAccountId_destinationId_noti_key" ON "NotificationSubscription"("sellerAccountId", "destinationId", "notificationType");
CREATE INDEX "NotificationSubscription_tenantId_status_idx" ON "NotificationSubscription"("tenantId", "status");
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 收到的亚马逊通知（按月分区，分区列 receivedAt；唯一键含分区列，只能在同一分区内去重，跨月去重靠业务幂等键，见 models.md G-08）
CREATE TABLE "AmazonNotificationEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "notificationId" TEXT NOT NULL,
  "notificationType" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payloadObjectKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmazonNotificationEvent_pkey" PRIMARY KEY ("id", "receivedAt"),
  CONSTRAINT "AmazonNotificationEvent_status_check" CHECK ("status" IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'))
) PARTITION BY RANGE ("receivedAt");
CREATE UNIQUE INDEX "AmazonNotificationEvent_tenantId_notificationId_receivedAt_key" ON "AmazonNotificationEvent"("tenantId", "notificationId", "receivedAt");
CREATE INDEX "AmazonNotificationEvent_tenantId_notificationType_receivedA_idx" ON "AmazonNotificationEvent"("tenantId", "notificationType", "receivedAt");
CREATE INDEX "AmazonNotificationEvent_tenantId_status_receivedAt_idx" ON "AmazonNotificationEvent"("tenantId", "status", "receivedAt");
CREATE INDEX "AmazonNotificationEvent_sellerAccountId_idx" ON "AmazonNotificationEvent"("sellerAccountId");
ALTER TABLE "AmazonNotificationEvent" ADD CONSTRAINT "AmazonNotificationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AmazonNotificationEvent" ADD CONSTRAINT "AmazonNotificationEvent_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DataFreshness" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "sourceKey" TEXT NOT NULL,
  "lastAttemptAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "dataThrough" TIMESTAMP(3),
  "lastRowCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'NORMAL',
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataFreshness_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataFreshness_status_check" CHECK ("status" IN ('NORMAL', 'DELAYED', 'FAILED', 'UNAUTHORIZED', 'NOT_APPLICABLE', 'NOT_CONNECTED', 'WAITING_DEPENDENCY'))
);
CREATE UNIQUE INDEX "DataFreshness_tenantId_sellerAccountId_sourceKey_key" ON "DataFreshness"("tenantId", "sellerAccountId", "sourceKey") NULLS NOT DISTINCT;
CREATE INDEX "DataFreshness_sellerAccountId_idx" ON "DataFreshness"("sellerAccountId");
ALTER TABLE "DataFreshness" ADD CONSTRAINT "DataFreshness_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataFreshness" ADD CONSTRAINT "DataFreshness_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TenantSetting" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT,
  "key" TEXT NOT NULL,
  "valueJson" JSONB NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'TENANT',
  "updatedBy" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantSetting_scope_check" CHECK ("scope" IN ('TENANT', 'STORE')),
  CONSTRAINT "TenantSetting_scope_store_check" CHECK (("scope" = 'STORE') = ("sellerAccountId" IS NOT NULL))
);
CREATE UNIQUE INDEX "TenantSetting_tenantId_sellerAccountId_key_key" ON "TenantSetting"("tenantId", "sellerAccountId", "key") NULLS NOT DISTINCT;
CREATE INDEX "TenantSetting_sellerAccountId_idx" ON "TenantSetting"("sellerAccountId");
ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantSetting" ADD CONSTRAINT "TenantSetting_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 二、分区
-- ============================================================

DO $$
BEGIN
  PERFORM nova_ensure_partitions_around('"AmazonNotificationEvent"'::regclass, (timezone('UTC', now()) - interval '3 months')::timestamp, timezone('UTC', now())::timestamp, 3);
END $$;

-- ============================================================
-- 三、关账锁定：被期间关账锁定的汇率不可修改、不可删除（重新开账需先解除锁定，由关账流程完成）
-- ============================================================

CREATE FUNCTION nova_fx_rate_locked() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lockedByPeriodId" IS NOT NULL THEN
    -- 只允许“解除锁定”这一种修改（重新开账时），其余任何修改与删除都拒绝
    IF TG_OP = 'UPDATE' AND NEW."lockedByPeriodId" IS NULL
       AND NEW."rate" = OLD."rate" AND NEW."rateDate" = OLD."rateDate" AND NEW."quoteCurrency" = OLD."quoteCurrency"
       AND NEW."source" = OLD."source" AND NEW."isManualOverride" = OLD."isManualOverride" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '汇率已被期间关账锁定，不能修改或删除（期间 %）', OLD."lockedByPeriodId" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FxRate_locked" BEFORE UPDATE OR DELETE ON "FxRate" FOR EACH ROW EXECUTE FUNCTION nova_fx_rate_locked();

-- ============================================================
-- 四、行级安全与授权
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'IntegrationSwitch', 'IntegrationSwitchLog', 'FxRate', 'FxSourceConfig', 'WorkItem', 'Assignment', 'AlertRule', 'AlertRuleVersion', 'AlertInstance',
    'Notification', 'ExportJob', 'SavedView', 'EntityEvent', 'OperationLog', 'Comment', 'Watch', 'NotificationSubscription', 'AmazonNotificationEvent',
    'DataFreshness', 'TenantSetting'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', tbl);
    END IF;
  END LOOP;
END $$;
