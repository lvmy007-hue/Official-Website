export { TargetsModule } from './targets.module'
// 纯函数部分对其他领域模块公开（如经营控制台的目标达成横幅），避免重复实现同一套节奏线公式。
export { achievementRatioOf, elapsedDaysOf, linearRatio, totalDaysOf } from './targets-math'
