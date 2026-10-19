import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ApiController } from './api.controller'
import { ApiService } from './api.service'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { PrismaService } from './prisma.service'
import { QueueService } from './queue.service'
import { RateLimitService } from './rate-limit.service'
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET'), signOptions: { expiresIn: '15m' } }) })], controllers: [ApiController], providers: [PrismaService, QueueService, RateLimitService, AuthService, AuthGuard, ApiService] })
export class AppModule {}
