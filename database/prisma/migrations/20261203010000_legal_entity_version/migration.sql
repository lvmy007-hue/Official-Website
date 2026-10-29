-- M-P5-07 法律主体：LegalEntity 加乐观锁版本号，并给状态与版本加检查约束。
-- 依据：09 章 9.9，14 章 P5-07，freeze/api.md /entities*。
--
-- 内容：
--   一、LegalEntity 新增 version（默认 1）：修改主体时带着看到的版本去改，别人先改了返回 409。
--   二、检查约束：status 只允许 ACTIVE、INACTIVE（此前只有默认值，没有约束；现有数据都是 ACTIVE，下面先把不认识的取值归一再加约束）；version >= 1。
-- 与冻结的出入：冻结没有给 LegalEntity 列版本（`PATCH /entities/:id` 的 VersionBody 需要它）；没有新增表，行级安全与授权沿用 LegalEntity 现有的，不需要改 regrant.sql。
--
-- 回滚方法：见同目录 rollback.sql（删除两个约束与 version 列；主体行保留）。

UPDATE "LegalEntity" SET "status" = 'ACTIVE' WHERE "status" NOT IN ('ACTIVE', 'INACTIVE');

ALTER TABLE "LegalEntity" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE'));
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_version_check" CHECK ("version" >= 1);
