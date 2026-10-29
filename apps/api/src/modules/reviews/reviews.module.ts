import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ReviewsEligibleService } from './reviews-eligible.service'
import { ReviewsImportService } from './reviews-import.service'
import { ReviewsJobService } from './reviews-jobs.service'
import { ReviewsRatingsService } from './reviews-ratings.service'
import { ReviewsReadService } from './reviews-read.service'
import { ReviewsReturnsService } from './reviews-returns.service'
import { ReviewsSolicitService } from './reviews-solicit.service'
import { ReviewsTopicsService } from './reviews-topics.service'
import { ReviewsWriteService } from './reviews-write.service'
import { ReviewsController } from './reviews.controller'

@Module({
  imports: [AuthModule],
  controllers: [ReviewsController],
  providers: [
    ReviewsReadService,
    ReviewsRatingsService,
    ReviewsTopicsService,
    ReviewsReturnsService,
    ReviewsSolicitService,
    ReviewsEligibleService,
    ReviewsImportService,
    ReviewsWriteService,
    ReviewsJobService,
  ],
})
export class ReviewsModule {}
