// 一次 `vitest run` 跑完全部子项目：前端、后端、工作进程、共享包。
export default ['./vitest.config.ts', './apps/*/vitest.config.ts', './apps/*/vitest.db.config.ts', './packages/*/vitest.config.ts']
