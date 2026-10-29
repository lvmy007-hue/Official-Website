-- M-P1-15 乐观锁：现有采购单增加版本号（已有数据从 1 开始，其余需要版本号的对象随各自模型创建时带上）。
ALTER TABLE "PurchaseOrder" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
