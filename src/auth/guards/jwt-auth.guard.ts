import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext) {
    // TEMP: build'i kaldırmak için her isteğe izin ver
    return true;
  }
}
