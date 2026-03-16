import { Controller, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { RemindersService } from './reminders.service';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Post('run-2h')
  async run2h(@Headers('x-reminder-secret') secret?: string) {
    const expected = process.env.REMINDERS_MANUAL_SECRET || '';
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('bad secret');
    }

    await this.reminders.run2hReminders();
    return { ok: true };
  }
}
