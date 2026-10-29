-- M-P2b-14 商品成本。
-- 依据：freeze/models.md CostVersion；05 章 5.9；14 章 P2b-14。
--
-- 内容：CostVersion 加列——单位关税、备注、乐观锁版本号、录入人、生效人与时间、被谁替换与时间；加检查约束与一条查询索引。
-- 不改任何既有数据：既有版本的新列全部为空（版本号为 1），既有草稿保持草稿，要生效需在商品成本页面确认。
-- 检查约束：成本各项不能为负；至少有一项成本（既有数据都满足：采购收货草稿有采购单价，头程分摊草稿有头程成本）。
--
-- 回滚方法：见同目录 rollback.sql（删加的列与约束；关税、备注、生效留痕会丢，回滚前请先导出）。

-- AlterTable
ALTER TABLE "CostVersion" ADD COLUMN "unitDutyCost" DECIMAL(20,6),
ADD COLUMN "note" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "createdBy" TEXT,
ADD COLUMN "activatedBy" TEXT,
ADD COLUMN "activatedAt" TIMESTAMP(3),
ADD COLUMN "replacedById" TEXT,
ADD COLUMN "replacedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CostVersion_sku_status_idx" ON "CostVersion"("tenantId", "sku", "status");

-- 检查约束
ALTER TABLE "CostVersion" ADD CONSTRAINT "CostVersion_version_check" CHECK ("version" >= 1);
ALTER TABLE "CostVersion" ADD CONSTRAINT "CostVersion_amount_check" CHECK (
  COALESCE("unitProductCost", 0) >= 0 AND COALESCE("unitFirstMileCost", 0) >= 0 AND COALESCE("unitDutyCost", 0) >= 0 AND COALESCE("unitOtherCost", 0) >= 0
);
ALTER TABLE "CostVersion" ADD CONSTRAINT "CostVersion_any_cost_check" CHECK (
  "unitProductCost" IS NOT NULL OR "unitFirstMileCost" IS NOT NULL OR "unitDutyCost" IS NOT NULL OR "unitOtherCost" IS NOT NULL
);
