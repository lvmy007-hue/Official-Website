-- M-P2b-06 回滚：删除费用核查的两张表。
-- 说明：两张表都是派生数据（基准快照由报告每天重新导入，核查结果由后台任务重算）；“已转为赔付机会”的标记会丢失，赔付机会本身不受影响。
DROP TABLE IF EXISTS "FeeAudit";
DROP TABLE IF EXISTS "FeeBaseline";
