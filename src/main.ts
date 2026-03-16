import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { RealtimeBridgeService } from './bot/realtime-bridge.service';
import { createServer } from 'http';
import * as bodyParser from 'body-parser';
import * as WebSocket from 'ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Express instance
  const expressApp = app.getHttpAdapter().getInstance();

  // Body parsers (Twilio/WhatsApp webhook’ları için)
  expressApp.use(bodyParser.urlencoded({ extended: false }));
  expressApp.use(bodyParser.json({ limit: '2mb' }));

  // HTTP server (Express) + WS upgrade
  const httpServer = createServer(expressApp);

  // Nest app init (controller’lar vs ayağa kalksın)
  await app.init();

  const logger = new Logger('WS');
  const bridge = app.get(RealtimeBridgeService);

  // ✅ IMPORTANT: create ONE WS server (noServer mode)
  const wss = new WebSocket.Server({ noServer: true });

  // Twilio Media Stream WS: /bot/stream...
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = req.url || '';
      if (!url.startsWith('/bot/stream')) {
        socket.destroy();
        return;
      }

      logger.log(`UPGRADE ${url}`);

      wss.handleUpgrade(req, socket, head, (ws) => {
        // connection event optional; we can call bridge directly
        bridge.handleTwilioWebSocket(ws as any, url);
      });
    } catch (e: any) {
      logger.error(`upgrade error: ${e?.message || e}`);
      try {
        socket.destroy();
      } catch {}
    }
  });

  const port = Number(process.env.PORT || 3001);
  httpServer.listen(port, '0.0.0.0', () => {
    logger.log(`HTTP+WS listening on ${port}`);
  });
}

bootstrap();
