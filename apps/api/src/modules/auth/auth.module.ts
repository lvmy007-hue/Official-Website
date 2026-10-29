import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { JwtModule } from '@nestjs/jwt'
import { AuthController } from './auth.controller'
import { AuthGuard } from './auth.guard'
import { InternalAccessService } from './internal-access.service'
import { AuthService } from './auth.service'
import { ContextService } from './context.service'
import { MfaService } from './mfa.service'
import { ScopeService } from './scope.service'
import { WriteInterceptor } from './write.interceptor'

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  // 写接口拦截器（权限预检、再次验证、幂等、审计）依赖请求上下文，归在鉴权域，全局注册，所有领域模块的写接口自动经过
  providers: [AuthService, MfaService, InternalAccessService, AuthGuard, ContextService, ScopeService, { provide: APP_INTERCEPTOR, useClass: WriteInterceptor }],
  // JwtModule 一并导出，其他领域模块引入 AuthModule 后即可使用 AuthGuard
  exports: [ContextService, ScopeService, AuthGuard, JwtModule],
})
export class AuthModule {}
