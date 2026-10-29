import { DESTINATION_ENV_KEY } from '@nova/api-contracts'

/** 推送接收端（消息队列或事件总线）编号：由部署专项创建后配置为环境变量；未配置时订阅无法创建。 */
export const destinationIdFrom = (env: Record<string, string | undefined>) => env[DESTINATION_ENV_KEY]?.trim() || null
