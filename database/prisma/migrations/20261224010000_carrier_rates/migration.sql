-- M-P6-26 物流渠道与报价、头程预估所依据的渠道
-- 依据：14 章 P6-26；16 章第 5.2 节；freeze/models.md `Carrier`、`CarrierChannel`、`ChannelRate`、`FirstMileShipment`。
--
-- 内容：
--   一、新表 Carrier（物流商）、CarrierChannel（渠道：材积除数、分抛系数）、ChannelRate（地区 × 重量段 × 生效区间的阶梯报价）；
--       状态、计费方式限定取值；材积除数为正、分抛系数在 0 到 1 之间；重量段上限大于下限；单价不为负；币种三位大写字母；截止日不早于起始日；version 是乐观锁；
--   二、FirstMileShipment 加 carrierChannelId（外键，RESTRICT：被运单用过的渠道删不掉，只能停用）与 estimatedAt（预估被采用的时间）；两列可空，旧运单不受影响；
--   三、行级安全与授权同其他租户表（regrant.sql 的静态清单同步加入新表）。
--
-- 回滚方法：见同目录 rollback.sql（删除三张新表与运单上两列；已保存的渠道与报价丢失，运单上手工与已采用的预估金额保留）。

-- CreateTable
CREATE TABLE "Carrier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CarrierChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "carrierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "volumetricDivisor" DECIMAL(12,2) NOT NULL DEFAULT 6000,
    "splitFactor" DECIMAL(6,4) NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierChannel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "weightFrom" DECIMAL(14,4) NOT NULL,
    "weightTo" DECIMAL(14,4),
    "unitPrice" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingMode" TEXT NOT NULL DEFAULT 'PER_KG',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelRate_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "FirstMileShipment" ADD COLUMN "carrierChannelId" TEXT;
ALTER TABLE "FirstMileShipment" ADD COLUMN "estimatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_code_uq" ON "Carrier"("tenantId", "code");
CREATE UNIQUE INDEX "CarrierChannel_code_uq" ON "CarrierChannel"("tenantId", "carrierId", "code");
CREATE INDEX "CarrierChannel_carrier_idx" ON "CarrierChannel"("carrierId");
CREATE UNIQUE INDEX "ChannelRate_uq" ON "ChannelRate"("tenantId", "channelId", "region", "weightFrom", "effectiveFrom");
CREATE INDEX "ChannelRate_channel_idx" ON "ChannelRate"("channelId");
CREATE INDEX "FirstMileShipment_channel_idx" ON "FirstMileShipment"("carrierChannelId");

-- AddForeignKey
ALTER TABLE "Carrier" ADD CONSTRAINT "Carrier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarrierChannel" ADD CONSTRAINT "CarrierChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarrierChannel" ADD CONSTRAINT "CarrierChannel_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelRate" ADD CONSTRAINT "ChannelRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelRate" ADD CONSTRAINT "ChannelRate_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "CarrierChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FirstMileShipment" ADD CONSTRAINT "FirstMileShipment_carrierChannelId_fkey" FOREIGN KEY ("carrierChannelId") REFERENCES "CarrierChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 约束：状态与计费方式限定取值；材积除数为正；分抛系数 0 到 1（含 1、不含 0）；重量段上限大于下限；单价不为负；币种三位大写字母；截止日不早于起始日；版本号从 1 起
ALTER TABLE "Carrier" ADD CONSTRAINT "Carrier_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE') AND length("name") BETWEEN 1 AND 80 AND length("code") BETWEEN 1 AND 40 AND "version" >= 1);
ALTER TABLE "CarrierChannel" ADD CONSTRAINT "CarrierChannel_check" CHECK (
  "status" IN ('ACTIVE', 'INACTIVE')
  AND length("name") BETWEEN 1 AND 80
  AND length("code") BETWEEN 1 AND 40
  AND "volumetricDivisor" > 0
  AND "splitFactor" > 0 AND "splitFactor" <= 1
  AND "version" >= 1
);
ALTER TABLE "ChannelRate" ADD CONSTRAINT "ChannelRate_check" CHECK (
  "billingMode" IN ('PER_KG', 'PER_CBM', 'FLAT')
  AND length("region") BETWEEN 1 AND 40
  AND "weightFrom" >= 0
  AND ("weightTo" IS NULL OR "weightTo" > "weightFrom")
  AND "unitPrice" >= 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
  AND "version" >= 1
);

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['Carrier', 'CarrierChannel', 'ChannelRate'] LOOP
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
