import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req: any = ctx.switchToHttp().getRequest();

    const headerTid =
      req?.headers?.['x-tenant-id'] ||
      req?.headers?.['X-Tenant-Id'] ||
      req?.headers?.['x-tenantid'];

    return headerTid || req?.body?.tenantId || req?.query?.tenantId || null;
  },
);
