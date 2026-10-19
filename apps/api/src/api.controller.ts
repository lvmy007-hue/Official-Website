import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ContactRequestSchema, FbaInboundPlanCreateSchema, FbaListQuerySchema, FbaReportCreateSchema, FbaSyncCreateSchema, LoginInputSchema } from '@nova/api-contracts'
import { ApiService } from './api.service'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { RateLimitService } from './rate-limit.service'
import { AppError, ensureRequestId, ok, RequestWithContext } from './http'
@Controller()
export class ApiController { constructor(private readonly api: ApiService, private readonly auth: AuthService, private readonly rateLimit: RateLimitService) {}
  @Get('health') async health(@Req() req: RequestWithContext) { return ok(await this.api.health(), req) }
  @Post('auth/login') async login(@Req() req: RequestWithContext, @Body() body: unknown, @Res({ passthrough: true }) response: Response) { const input = LoginInputSchema.parse(body); await this.rateLimit.check('login', `${req.ip}:${input.email.toLowerCase()}`, 10, 60); const result = await this.auth.login(input.email, input.password, input.tenantId, req.header('user-agent'), req.ip); response.cookie('nova_refresh_token', result.refreshToken, { httpOnly: true, secure: process.env.APP_MODE === 'production', sameSite: 'lax', maxAge: 30*86400000, path: '/api/v1/auth' }); return ok(result, req) }
  @Post('auth/refresh') async refresh(@Req() req: RequestWithContext, @Headers('cookie') cookie?: string) { const match = cookie?.match(/(?:^|;\s*)nova_refresh_token=([^;]+)/); if (!match) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效'); return ok(await this.auth.refresh(decodeURIComponent(match[1])), req) }
  @UseGuards(AuthGuard) @Get('auth/me') async me(@Req() req: RequestWithContext) { return ok(await this.api.me(req), req) }
  @UseGuards(AuthGuard) @Get('entities') async entities(@Req() req: RequestWithContext) { return ok(await this.api.entities(req), req) }
  @UseGuards(AuthGuard) @Get('members') async members(@Req() req: RequestWithContext) { return ok(await this.api.members(req), req) }
  @UseGuards(AuthGuard) @Get('audit') async audit(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.audit(req, query), req) }
  @UseGuards(AuthGuard) @Get('orders') async orders(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.orders(req, query), req) }
  @UseGuards(AuthGuard) @Get('inventory') async inventory(@Req() req: RequestWithContext) { return ok(await this.api.inventory(req), req) }
  @UseGuards(AuthGuard) @Get('fba/summary') async fbaSummary(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaSummary(req, query), req) }
  @UseGuards(AuthGuard) @Get('fba/products') async fbaProducts(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaProducts(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Get('fba/inventory') async fbaInventory(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaInventory(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Get('fba/inbound-plans') async fbaInboundPlans(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaInboundPlans(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Get('fba/fees') async fbaFees(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaFees(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Get('fba/returns') async fbaReturns(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaReturns(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Get('reports/jobs') async fbaReports(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.fbaReports(req, FbaListQuerySchema.parse(query)), req) }
  @UseGuards(AuthGuard) @Post('fba/inbound-plans') async createFbaInboundPlan(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) { const result = await this.api.createFbaInboundPlan(req, FbaInboundPlanCreateSchema.parse(body)); return response.status(202).json(ok(result, req)) }
  @UseGuards(AuthGuard) @Post('reports/jobs') async createFbaReport(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) { const result = await this.api.createFbaReport(req, FbaReportCreateSchema.parse(body)); return response.status(202).json(ok(result, req)) }
  @UseGuards(AuthGuard) @Post('fba/sync/jobs') async createFbaSync(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) { const result = await this.api.createFbaSync(req, FbaSyncCreateSchema.parse(body)); return response.status(202).json(ok(result, req)) }
  @UseGuards(AuthGuard) @Get('connections') async connections(@Req() req: RequestWithContext) { return ok(await this.api.connections(req), req) }
  @UseGuards(AuthGuard) @Get('sync/jobs') async syncJobs(@Req() req: RequestWithContext) { return ok(await this.api.syncJobs(req), req) }
  @UseGuards(AuthGuard) @Post('sync/jobs/:id/retry') async retrySync(@Req() req: RequestWithContext, @Param('id') id: string, @Res() response: Response) { const result = await this.api.retrySync(req, id); return response.status(202).json(ok(result, req)) }
  @UseGuards(AuthGuard) @Post('sync/jobs') async createSync(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) { const result = await this.api.createSync(req, body); return response.status(202).json(ok(result, req)) }
  @UseGuards(AuthGuard) @Post('sp-api/oauth/start') async startOAuth(@Req() req: RequestWithContext, @Body() body: unknown) { return ok(await this.api.startOAuth(req, body), req, 'external') }
  @Get('sp-api/oauth/callback') async callback(@Req() req: RequestWithContext, @Query() query: Record<string,string>) { return ok(await this.api.completeOAuth(query), req, 'external') }
  @Post('contact-requests') async contact(@Req() req: RequestWithContext, @Body() body: unknown) { const input = ContactRequestSchema.parse(body); await this.rateLimit.check('contact', req.ip ?? 'unknown', 5, 300); return ok(await this.api.createContactRequest(input), req) }
}
export function requestIdMiddleware(req: Request, _res: Response, next: () => void) { ensureRequestId(req as RequestWithContext); next() }
