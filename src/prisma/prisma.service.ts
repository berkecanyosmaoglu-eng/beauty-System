import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }

  /**
   * Prisma v6 type değişikliği yüzünden:
   * this.$on('beforeExit') TS'de "never" diyebiliyor.
   * Any cast ile sorunsuz.
   */
  async enableShutdownHooks(app: INestApplication) {
    (this as any).$on('beforeExit', async () => {
      await app.close();
    });
  }

  // =========================
  // ✅ DB1 Legacy Aliases
  // Kodun her yerinde eski: prisma.appointment / prisma.tenant / prisma.customer
  // Prisma Client ise plural üretiyor: prisma.appointments / prisma.tenants / prisma.customers ...
  // Burada köprü kuruyoruz.
  // =========================

  get appointment(): any {
    return (this as any).appointments;
  }

  get tenant(): any {
    return (this as any).tenants;
  }

  get customer(): any {
    return (this as any).customers;
  }

  get service(): any {
    return (this as any).services;
  }

  // notificationLog eski isim, DB1 client'ta 'notifications' var
  get notificationLog(): any {
    return (this as any).notifications;
  }

  // Bazı kodlar whatsAppMessage diye çağırıyor olabilir.
  // DB1 client'ta isim farklıysa bile any ile tolerans.
  get whatsAppMessage(): any {
    return (this as any).whatsAppMessages ?? (this as any).whatsAppMessage;
  }

  // Bot tabloları DB1'de yok → kod çalışırken patlamasın diye
  // Controller/Service içinde ayrıca legacy modda hiç çağırmamalıyız.
  get botConversation(): any {
    return (this as any).botConversation;
  }

  get botMessage(): any {
    return (this as any).botMessage;
  }
}
