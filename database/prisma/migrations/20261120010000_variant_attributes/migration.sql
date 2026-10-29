-- M-P4-03 变体属性（ASIN 与父体分析的“颜色 × 尺码”透视）。
-- 依据：04 章 4.6（子体贡献矩阵按变体属性透视）；freeze/importers.md I-09；14 章 P4-03。
--
-- 内容：
--   一、FbaProduct 增加 variantAttributes（JSONB，变体维度名到取值，例如 {"color":"Red","size":"L"}），由目录同步器（I-09）写入；
--       目录没有给出变体属性时保持为空（页面写“尚未接入”，不猜）。
--   二、FbaProduct 增加按（企业、父体）的索引：父体详情与父体树按父体编号找子体。
--
-- 回滚方法：见同目录 rollback.sql。本迁移不修改、不删除任何既有数据。

-- AlterTable
ALTER TABLE "FbaProduct" ADD COLUMN "variantAttributes" JSONB;

-- CreateIndex
CREATE INDEX "FbaProduct_parent_idx" ON "FbaProduct"("tenantId", "parentAsin");
