-- M-P1-23 回滚：移除原始报告文件登记表。
-- 只丢弃登记；对象存储里的文件不受影响，需另行清理。请仅在演练或紧急处置时执行，并先备份。
DROP TABLE IF EXISTS "RawReportFile";
