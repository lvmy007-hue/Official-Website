-- M-P6-14 退货买家备注加密保存：新增密文列、保留期与个人信息类别列。
-- 依据：14 章 P6-14，16 章第 6 节，08 第 4.3 节，freeze/models.md 第二十一节（FbaReturnCase 修改：customerComments 改为加密存储）。
--
-- 内容（“先加后删”的第一步，只加不删）：
--   FbaReturnCase 增加
--     customerCommentsCipher     买家备注密文（密钥环用途 buyer-pii，与订单买家信息同一套密钥）；
--     customerCommentsExpiresAt  保留期截止（与订单买家信息同一保留规则：发货后 30 天，企业可缩短，到期由后台任务清除密文）；
--     customerCommentsKinds      自动识别出的个人信息类别（PHONE、EMAIL、ADDRESS 的逗号串，不含任何内容），详情页据此提示。
--   升级前的明文列 customerComments 本迁移不动：
--     加密只能由应用层密钥环完成，SQL 里做不了；存量由 worker 每小时的清理任务（listeners/schedules.ts 调用 maintenance/return-comments.ts，每次最多 20 批）与运维命令 backfill-return-comments 逐批加密并清空明文，
--     代码从此不再读写明文列。确认明文清空后，运行 database/ops/drop-return-comment-plaintext.sql 删除该列（脚本带检查：
--     还有未加密的行就拒绝执行，并带回滚说明）。
--
-- 回滚方法：见同目录 rollback.sql（删除三个新列；已加密的备注随之丢弃，不会还原成明文）。

ALTER TABLE "FbaReturnCase" ADD COLUMN "customerCommentsCipher" TEXT;
ALTER TABLE "FbaReturnCase" ADD COLUMN "customerCommentsExpiresAt" TIMESTAMP(3);
ALTER TABLE "FbaReturnCase" ADD COLUMN "customerCommentsKinds" TEXT;

-- 到期清理按保留期截止取行
CREATE INDEX "FbaReturnCase_commentexp_idx" ON "FbaReturnCase"("customerCommentsExpiresAt");
