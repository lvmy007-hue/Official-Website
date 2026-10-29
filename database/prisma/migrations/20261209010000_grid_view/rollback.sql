-- 回滚 M-P6-03：删除 GridView（含索引、约束与行级安全策略）。
-- 所有成员保存的视图与筛选方案会丢失，各表格回到页面自带的默认列；表格本身不受影响。
DROP TABLE IF EXISTS "GridView";
