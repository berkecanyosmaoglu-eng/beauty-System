import { Controller, Get, Header, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller('bot')
export class BotController {
  /**
   * Builds the TwiML XML response for Twilio Media Streams.
   *
   * @param req The incoming HTTP request (unused, but available for future use)
   * @param tenantId Optional tenant identifier used for multi‑tenant routing
   * @returns An XML string instructing Twilio to connect the call to a WebSocket stream
   */
  private buildStreamXml(req: Request, tenantId?: string): string {
    // Determine tenant ID from query or parameter
    const tid = (tenantId || (req.query?.tenantId as string) || '').trim();

    // Base URL for the API; fallback to your default if not provided
    const httpBase = (process.env.PUBLIC_BASE_URL?.trim() || 'https://bot.sibelizmimarlik.com').replace(/\/$/, '');

    // Convert the base URL to a WebSocket base (wss or ws)
    const wsBase = httpBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    // Build the WebSocket URL with optional tenantId as a query parameter
    const wsUrl = tid ? `${wsBase}/bot/stream?tenantId=${encodeURIComponent(tid)}` : `${wsBase}/bot/stream`;

    // If a tenantId is provided, include it as a Parameter element
    const parameterTag = tid ? `\n      <Parameter name="tenantId" value="${tid}" />` : '';

    // Return the TwiML response instructing Twilio to connect to the WebSocket
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Response>\n` +
      `  <Connect>\n` +
      `    <Stream url="${wsUrl}">${parameterTag}\n` +
      `    </Stream>\n` +
      `  </Connect>\n` +
      `</Response>`;
  }

  @Post('voice')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  async voice(@Req() req: Request, @Query('tenantId') tenantId?: string): Promise<string> {
    console.log('🔥 HIT POST /bot/voice tenantId=', tenantId || '-');
    return this.buildStreamXml(req, tenantId);
  }

  @Get('voice')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  async voiceGet(@Req() req: Request, @Query('tenantId') tenantId?: string): Promise<string> {
    console.log('🔥 HIT GET /bot/voice tenantId=', tenantId || '-');
    return this.buildStreamXml(req, tenantId);
  }
}
