import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from './app.module'
import { ApiExceptionFilter } from './http'
import { requestIdMiddleware } from './api.controller'
function assertProductionConfig() { if (process.env.APP_MODE !== 'production') return; if (process.env.DEMO_MODE === 'true' || process.env.MOCK_CONNECTOR === 'true') throw new Error('Production refuses DEMO_MODE or MOCK_CONNECTOR'); if (!process.env.DATABASE_URL || !process.env.REDIS_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Production requires DATABASE_URL, REDIS_URL and a strong JWT_SECRET'); if (!process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY.length < 64) throw new Error('Production requires TOKEN_ENCRYPTION_KEY') }
async function bootstrap() { assertProductionConfig(); const app = await NestFactory.create(AppModule, { cors: false }); app.use(helmet({ contentSecurityPolicy: false })); app.use(cookieParser()); app.use(requestIdMiddleware); const origins = (process.env.CORS_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean); app.enableCors({ origin: origins.length ? origins : false, credentials: true }); app.setGlobalPrefix('api/v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); app.useGlobalFilters(new ApiExceptionFilter()); await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0') }
bootstrap().catch(error => { console.error(error); process.exit(1) })
