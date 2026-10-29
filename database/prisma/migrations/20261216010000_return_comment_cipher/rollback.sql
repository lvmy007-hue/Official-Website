-- 回滚 M-P6-14：删除退货买家备注的密文、保留期与类别三列和它们的索引。
-- 已加密的备注随列一起丢弃，不会还原成明文（也不应该还原）；升级前的明文列 customerComments 没有被本迁移改动，未回填的行里它仍在。
DROP INDEX IF EXISTS "FbaReturnCase_commentexp_idx";
ALTER TABLE "FbaReturnCase" DROP COLUMN IF EXISTS "customerCommentsCipher";
ALTER TABLE "FbaReturnCase" DROP COLUMN IF EXISTS "customerCommentsExpiresAt";
ALTER TABLE "FbaReturnCase" DROP COLUMN IF EXISTS "customerCommentsKinds";
