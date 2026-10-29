-- M-P6-12 标签模板与自定义箱标签：标签模板（含箱号规则）与标签生成记录。
-- 依据：14 章 P6-12，16 章第 5.1、5.2 节，freeze/models.md 第二十一节（LabelTemplate、LabelPrintLog）。
--
-- 内容：
--   一、新表 LabelTemplate：自定义勾选项与排序（options）、纸张规格（paper）、箱号规则（boxNoRule）；同一企业内名称唯一；
--      全企业至多一个默认模板（部分唯一索引，Prisma 模型表达不了）；version 做乐观锁。
--   二、新表 LabelPrintLog：每成功生成一份自定义箱标签或商品标签（PDF）记一行，按货件统计生成次数。
--      shipmentId 是我方货件行编号，整个计划的商品标签为空；模板被删除时 templateId 置空，记录保留。
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入这两张表）。
--   四、ExportJob 的文件格式约束增加 PDF（自定义箱标签、商品标签走导出中心，结果是 PDF 文件）。
--
-- 回滚方法：见同目录 rollback.sql（删除两张表，把格式约束改回只允许 CSV、XLSX，并删除 PDF 导出任务记录；已经生成的文件随保留期到期清理）。

-- CreateTable
CREATE TABLE "LabelTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "paper" TEXT NOT NULL,
    "boxNoRule" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelPrintLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "templateId" TEXT,
    "kind" TEXT NOT NULL,
    "labelCount" INTEGER NOT NULL,
    "exportJobId" TEXT,
    "printedBy" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelPrintLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabelTemplate_uq" ON "LabelTemplate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "LabelPrintLog_shipment_idx" ON "LabelPrintLog"("tenantId", "shipmentId", "printedAt");

-- CreateIndex
CREATE INDEX "LabelPrintLog_planId_idx" ON "LabelPrintLog"("planId");

-- CreateIndex
CREATE INDEX "LabelPrintLog_shipmentId_idx" ON "LabelPrintLog"("shipmentId");

-- CreateIndex
CREATE INDEX "LabelPrintLog_templateId_idx" ON "LabelPrintLog"("templateId");

-- AddForeignKey
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintLog" ADD CONSTRAINT "LabelPrintLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintLog" ADD CONSTRAINT "LabelPrintLog_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FbaInboundPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintLog" ADD CONSTRAINT "LabelPrintLog_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "FbaInboundShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintLog" ADD CONSTRAINT "LabelPrintLog_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LabelTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 全企业至多一个默认模板
CREATE UNIQUE INDEX "LabelTemplate_default_key" ON "LabelTemplate"("tenantId") WHERE "isDefault";

-- 取值与长度约束
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_check" CHECK (
  "paper" IN ('THERMAL_4X6', 'A4_2UP', 'A4_4UP')
  AND char_length("name") BETWEEN 1 AND 40
  AND jsonb_typeof("options") = 'object'
  AND jsonb_typeof("boxNoRule") = 'object'
  AND "version" >= 1);

ALTER TABLE "LabelPrintLog" ADD CONSTRAINT "LabelPrintLog_check" CHECK (
  "kind" IN ('BOX_CUSTOM', 'ITEM')
  AND "labelCount" >= 0);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['LabelTemplate', 'LabelPrintLog'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', t);
    END IF;
  END LOOP;
END $$;

-- 导出任务格式：增加 PDF
ALTER TABLE "ExportJob" DROP CONSTRAINT "ExportJob_format_check";
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_format_check" CHECK ("format" IN ('CSV', 'XLSX', 'PDF'));
