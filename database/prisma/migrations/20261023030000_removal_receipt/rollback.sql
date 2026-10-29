-- M-P2a-09 回滚：删除 RemovalReceipt，并去掉 StorageCapacitySnapshot 的两个来源标注列。
-- 说明：收货登记是人工录入的业务记录，删除后不可恢复，回滚前请先导出；文件导入的限额行保留，只是不再带导入文件名与导入人。
DROP TABLE IF EXISTS "RemovalReceipt";
ALTER TABLE "StorageCapacitySnapshot" DROP COLUMN IF EXISTS "sourceFileName", DROP COLUMN IF EXISTS "importedBy";
