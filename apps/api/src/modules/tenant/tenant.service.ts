import { Injectable } from '@nestjs/common'
import { RequestWithContext } from '../../platform/http'
import { ContextService, ScopeService } from '../auth'

@Injectable()
export class TenantService {
  constructor(
    private readonly context: ContextService,
    private readonly scopes: ScopeService,
  ) {}

  async scopeOptions(req: RequestWithContext) {
    return this.scopes.options(await this.context.resolve(req))
  }
}
