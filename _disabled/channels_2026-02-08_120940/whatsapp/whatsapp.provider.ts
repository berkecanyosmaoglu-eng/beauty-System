export interface WhatsAppProvider {
  parseInbound(payload: any): {
    from: string;
    text: string;
    messageId: string;
  };

  sendText(to: string, text: string): Promise<void>;
}
