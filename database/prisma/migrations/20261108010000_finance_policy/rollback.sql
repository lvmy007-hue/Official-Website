-- M-P2b-15 回滚：删除财务口径版本表。
-- 说明：口径版本是审批凭证，回滚后会丢失，请先导出。
-- 回滚不会改动企业设置 finance.inventoryCosting：审批通过时已写入的存货计价继续生效，要恢复请手工改那条设置。
DROP TABLE IF EXISTS "FinancePolicyVersion";
