-- 删除退货买家备注的明文列（P6-14，“先加后删”的第二步）。
--
-- 背景：迁移 20261216010000_return_comment_cipher 新增了加密列，升级前的明文列 FbaReturnCase.customerComments 没有动
-- （SQL 做不了应用层加密）。worker 的存量加密任务（maintenance/return-comments.ts）逐批加密并清空明文；
-- 本脚本在确认明文已经清空之后才删除这一列。
--
-- 执行前提（缺一不可）：
--   1. 存量加密已跑完：keys-cli 的 backfill-return-comments 报告“失败 0”，且下面的检查通过（脚本自己也会检查，不通过就拒绝执行）；
--   2. 运行中的接口服务与 worker 都不再引用 customerComments。本版本的存量加密任务与 schema.prisma 里的字段说明还在引用它，
--      所以必须等到“移除存量加密任务与 schema 字段”的后续版本全部发布之后再执行，否则 Prisma 的整行读写会因为缺列而报错。
--
-- 用法（由表的所有者账号执行，可重复执行）：psql "$DATABASE_URL" -f database/ops/drop-return-comment-plaintext.sql
--
-- 回滚：ALTER TABLE "FbaReturnCase" ADD COLUMN "customerComments" TEXT;
--   列会回来但内容不会回来（明文已按设计清掉）；需要时重新导入退货报告，备注会以加密形式重新写入。

DO $$
DECLARE
  remaining bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'FbaReturnCase' AND column_name = 'customerComments'
  ) THEN
    RAISE NOTICE '明文列 customerComments 已经不存在，无需处理';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM "FbaReturnCase" WHERE "customerComments" IS NOT NULL' INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION '还有 % 行退货备注没有加密（customerComments 不为空）：先运行 keys-cli backfill-return-comments，失败为 0 后再执行本脚本', remaining;
  END IF;

  ALTER TABLE "FbaReturnCase" DROP COLUMN "customerComments";
  RAISE NOTICE '已删除明文列 customerComments';
END
$$;
