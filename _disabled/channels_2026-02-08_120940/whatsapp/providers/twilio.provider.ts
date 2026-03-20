import { Injectable } from '@nestjs/common';
import { WhatsAppProvider } from '../whatsapp.provider';
import twilio from 'twilio';

@Injectable()
export class TwilioWhatsAppProvider implements WhatsAppProvider {
  private client;

  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );
  }

  parseInbound(payload: any) {
    return {
      from: payload.From?.replace('whatsapp:', ''),
      text: payload.Body,
      messageId: payload.MessageSid,
    };
  }

  async sendText(to: string, text: string) {
    await this.client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${to}`,
      body: text,
    });
  }
}
