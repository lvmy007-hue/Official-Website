-- 回滚 M-P6-12：删除标签生成记录与标签模板，ExportJob 的格式约束改回只允许 CSV、XLSX。
-- PDF 导出任务记录必须先删除（否则旧约束加不上）；已经生成的 PDF 文件随保留期到期被清理任务清掉，回滚后不再能从导出中心下载。
DROP TABLE IF EXISTS "LabelPrintLog";
DROP TABLE IF EXISTS "LabelTemplate";
DELETE FROM "ExportJob" WHERE "format" = 'PDF';
ALTER TABLE "ExportJob" DROP CONSTRAINT "ExportJob_format_check";
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_format_check" CHECK ("format" IN ('CSV', 'XLSX'));
