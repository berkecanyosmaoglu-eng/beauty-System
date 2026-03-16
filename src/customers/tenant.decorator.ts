import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export const TenantId = createParamDecorator((_d, ctx: ExecutionContext) => {
  const req: any = ctx.switchToHttp().getRequest();
  return req?.headers?.['x-tenant-id'] || req?.body?.tenantId || req?.query?.tenantId || null;
});
