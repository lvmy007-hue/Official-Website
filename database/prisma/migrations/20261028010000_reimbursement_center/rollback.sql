-- M-P2b-03 回滚：删除赔付中心新增的三张表，并去掉赔付机会新增的 4 列。
-- 说明：案件（含状态、负责人、亚马逊案件编号、实收金额）、官方赔付明细与证据包清单回滚后不可恢复，回滚前请先导出；
-- 官方赔付明细可由下一次 R-27 报告同步重新生成，案件与证据包清单不能。
-- 机会上的 sku、qty 是页面显示用的冗余列（可由证据与差异重新算出），note 是忽略原因（不可恢复）。
-- 已经导出的证据包文件保留在导出中心（7 天后自动清理），不受影响。
DROP TABLE IF EXISTS "EvidencePack";
DROP TABLE IF EXISTS "ReimbursementRecord";
DROP TABLE IF EXISTS "ReimbursementCase";
ALTER TABLE "ReimbursementOpportunity" DROP CONSTRAINT IF EXISTS "ReimbursementOpp_qty_check";
ALTER TABLE "ReimbursementOpportunity" DROP COLUMN IF EXISTS "sku", DROP COLUMN IF EXISTS "qty", DROP COLUMN IF EXISTS "note", DROP COLUMN IF EXISTS "version";
