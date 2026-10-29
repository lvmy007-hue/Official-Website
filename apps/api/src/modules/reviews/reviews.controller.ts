import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common'
import { REVIEWS_ACTIONS, REVIEWS_IMPORT_PERMISSION, REVIEWS_SOLICIT } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ReviewsEligibleService } from './reviews-eligible.service'
import { ReviewsImportService } from './reviews-import.service'
import { ReviewsReadService } from './reviews-read.service'
import { ReviewsWriteService } from './reviews-write.service'

// 评价与反馈（P4-13；05 章 5.7；freeze/api.md /reviews*）。四条路由都是静态路径，没有参数路径，顺序无关。
// 评分与评分数只来自文件导入；评论主题与退货主题来自客户反馈接口（worker 同步）；批量请求评价受写入开关“请求评价”控制，每单只请求一次。
@UseGuards(AuthGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(
    private readonly reads: ReviewsReadService,
    private readonly eligible: ReviewsEligibleService,
    private readonly imports: ReviewsImportService,
    private readonly writes: ReviewsWriteService,
  ) {}

  @Get()
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.read(req, query), req)
  }

  @Get('solicitations/eligible')
  async listEligible(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.eligible.list(req, query), req)
  }

  @Write({ action: REVIEWS_ACTIONS.ratingsImported, resourceType: 'ReviewMetricSnapshot', permission: REVIEWS_IMPORT_PERMISSION })
  @Post('ratings-import')
  async importRatings(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.imports.importRatings(req, body), req)
  }

  @Write({ action: REVIEWS_ACTIONS.solicitationsRequested, resourceType: 'SolicitationRequest', permission: REVIEWS_SOLICIT })
  @Post('solicitations')
  async request(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.request(req, body), req)
  }
}
