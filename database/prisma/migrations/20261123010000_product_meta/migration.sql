-- M-P4-07 商品主数据：负责人与标签的乐观锁、按负责人筛选的索引。
-- 依据：05 章 5.1（设置负责人与标签：系统内数据，不写亚马逊）；14 章 P4-07。
--
-- 内容：
--   一、FbaProduct 增加 version（乐观锁版本号，默认 1）：批量设置负责人与标签时带着看到的版本去改，别人先改了返回 409。
--       目录同步器（I-09）与库存、订单同步器从不写 ownerUserId、tagIds、version，所以同步不会冲掉手工设置。
--   二、FbaProduct 增加按（企业、负责人）的索引：商品列表按负责人筛选。
--
-- 回滚方法：见同目录 rollback.sql。本迁移不修改、不删除任何既有数据。

-- AlterTable
ALTER TABLE "FbaProduct" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "FbaProduct_owner_idx" ON "FbaProduct"("tenantId", "ownerUserId");
