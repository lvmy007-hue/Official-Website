-- 回滚 M-P6-33：删除自定义仪表盘三张表（含索引、检查约束与行级安全策略）。
-- 丢失的数据：文件夹、仪表盘布局与组件。不影响报表数据源与自定义指标。
DROP TABLE IF EXISTS "DashboardWidget";
DROP TABLE IF EXISTS "Dashboard";
DROP TABLE IF EXISTS "DashboardFolder";
