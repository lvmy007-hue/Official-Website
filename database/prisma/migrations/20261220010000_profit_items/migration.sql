-- M-P6-18 利润项目字典、口径版本表、关税进利润
-- 依据：14 章 P6-18；16 章第 7 节；08 第 3.2 节；freeze/models.md 第二十一节（ProfitItem、ProfitItemMapping、MetricVersion 新增）。
--
-- 内容：
--   一、新表 ProfitItem：利润项目字典（最多三级）。比冻结稿多一列 systemKey（系统项目对应的利润桥项目，自定义项目为空），
--       让“改映射后利润日表各列仍与净利润对得上”成为可能；系统项目不能删除（触发器拦住），可以改名；
--   二、新表 ProfitItemMapping：交易类型（费用分类/子类型）到项目的映射，每个类型只能映射到一个项目；
--   三、新表 MetricVersion：口径版本（本包只用 PROFIT_DICTIONARY；P6-31 接入其余三种）。每家企业每种 kind 至多一个 ACTIVE（部分唯一索引）；
--   四、ProfitDaily 加 dutyCost（关税）与 itemAmounts（按字典拆开的带符号贡献）。两列都可空：旧行保持为空，下一次重算（每 6 小时近 45 天）才会补上；
--   五、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除三张新表与 ProfitDaily 的两列；字典、映射与口径版本丢失，利润日表的关税与按项目拆分会在回滚后消失）。

-- AlterTable
ALTER TABLE "ProfitDaily" ADD COLUMN "dutyCost" DECIMAL(20,6);
ALTER TABLE "ProfitDaily" ADD COLUMN "itemAmounts" JSONB;
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_itemAmounts_check" CHECK ("itemAmounts" IS NULL OR jsonb_typeof("itemAmounts") = 'object');
ALTER TABLE "ProfitDaily" ADD CONSTRAINT "ProfitDaily_dutyCost_check" CHECK ("dutyCost" IS NULL OR "dutyCost" >= 0);

-- CreateTable
CREATE TABLE "ProfitItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "sign" INTEGER NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfitItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProfitItemMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfitItemMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetricVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfitItem_name_uq" ON "ProfitItem"("tenantId", "parentId", "name");
CREATE UNIQUE INDEX "ProfitItem_systemKey_uq" ON "ProfitItem"("tenantId", "systemKey");
CREATE INDEX "ProfitItem_tree_idx" ON "ProfitItem"("tenantId", "parentId", "sort");
CREATE INDEX "ProfitItem_parent_idx" ON "ProfitItem"("parentId");
-- 一级项目（没有父项目）的名称在同一企业内也不能重复：普通唯一索引对空值不起作用，这里补一条
CREATE UNIQUE INDEX "ProfitItem_root_name_uq" ON "ProfitItem"("tenantId", "name") WHERE "parentId" IS NULL;
CREATE UNIQUE INDEX "ProfitItemMapping_uq" ON "ProfitItemMapping"("tenantId", "transactionType");
CREATE INDEX "ProfitItemMapping_item_idx" ON "ProfitItemMapping"("itemId");
CREATE UNIQUE INDEX "MetricVersion_uq" ON "MetricVersion"("tenantId", "kind", "versionNo");
CREATE INDEX "MetricVersion_status_idx" ON "MetricVersion"("tenantId", "kind", "status");
CREATE UNIQUE INDEX "MetricVersion_active_uq" ON "MetricVersion"("tenantId", "kind") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "ProfitItem" ADD CONSTRAINT "ProfitItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfitItem" ADD CONSTRAINT "ProfitItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProfitItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfitItemMapping" ADD CONSTRAINT "ProfitItemMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfitItemMapping" ADD CONSTRAINT "ProfitItemMapping_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ProfitItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MetricVersion" ADD CONSTRAINT "MetricVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 约束：层级 1 到 3；一级项目没有父项目、其余必须有；正负方向只能是 +1 或 -1；分组限定六种；名称 1 到 40 字；系统项目必须有 systemKey
ALTER TABLE "ProfitItem" ADD CONSTRAINT "ProfitItem_check" CHECK (
  "level" BETWEEN 1 AND 3
  AND (("level" = 1 AND "parentId" IS NULL) OR ("level" > 1 AND "parentId" IS NOT NULL))
  AND "sign" IN (1, -1)
  AND "group" IN ('REVENUE', 'PLATFORM_FEE', 'LOGISTICS_FEE', 'ADS', 'PRODUCT_COST', 'OTHER')
  AND char_length("name") BETWEEN 1 AND 40
  AND ("isSystem" = false OR "systemKey" IS NOT NULL)
);
ALTER TABLE "ProfitItemMapping" ADD CONSTRAINT "ProfitItemMapping_check" CHECK (char_length("transactionType") BETWEEN 1 AND 200);
ALTER TABLE "MetricVersion" ADD CONSTRAINT "MetricVersion_check" CHECK (
  "kind" IN ('PROFIT_FORMULA', 'BUSINESS_RULES', 'PROFIT_DICTIONARY', 'ALLOCATION_RULES')
  AND "status" IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED')
  AND "versionNo" >= 1
  AND jsonb_typeof("config") = 'object'
);

-- 系统项目不能删除（改名可以）。删除整个企业时系统项目由外键级联清理，那时所属企业的行已经不存在，触发器放行；其余情况一律拦截。
CREATE OR REPLACE FUNCTION nova_profit_item_protect_system() RETURNS trigger AS $$
BEGIN
  IF OLD."isSystem" AND EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = OLD."tenantId") THEN
    RAISE EXCEPTION '系统利润项目不能删除（只能改名）' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProfitItem_protect_system" BEFORE DELETE ON "ProfitItem" FOR EACH ROW EXECUTE FUNCTION nova_profit_item_protect_system();

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ProfitItem', 'ProfitItemMapping', 'MetricVersion'] LOOP
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
