-- M-P1-17 回滚：移除多因素认证因子表与会话轮换相关列。
-- 回滚后刷新凭据不再轮换，请仅在演练或紧急处置时执行；已绑定的多因素认证需要用户重新绑定。
DROP TABLE IF EXISTS "MfaFactor";
DROP INDEX IF EXISTS "Session_rotatedFromId_idx";
DROP INDEX IF EXISTS "Session_rotationChainId_idx";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "ipMasked";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "deviceFingerprint";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "reuseDetectedAt";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "rotatedFromId";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "rotationChainId";
