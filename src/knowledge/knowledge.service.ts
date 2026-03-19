import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentReplyRequest } from '../agent/shared/agent-types';

type ServiceInfo = {
  id: string;
  name: string;
  price?: number | null;
  duration?: number | null;
};

@Injectable()
export class KnowledgeService {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async answer(payload: AgentReplyRequest): Promise<string> {
    const tenantId = String(payload.tenantId || '').trim();
    const text = String(payload.text || '').trim();
    const normalized = this.normalize(text);

    const [services, businessProfile, settings] = await Promise.all([
      this.getServices(tenantId),
      this.getBusinessProfile(tenantId),
      this.getTenantSettings(tenantId),
    ]);

    const matchedService = this.findServiceMatch(services, normalized);

    if (this.isPriceQuestion(normalized)) {
      if (matchedService) {
        return this.buildPriceAnswer(matchedService);
      }
      return this.buildServiceMenu(services, 'Fiyat bilgileri kısaca şöyle:');
    }

    if (this.isDurationQuestion(normalized)) {
      if (matchedService && matchedService.duration) {
        return `${matchedService.name} yaklaşık ${matchedService.duration} dakika sürer.`;
      }
      return 'Süre bilgisi için hangi hizmeti istediğinizi yazabilirsiniz.';
    }

    if (this.isAddressQuestion(normalized)) {
      const address = this.pickBusinessField(businessProfile, ['address', 'fullAddress', 'location']);
      return address
        ? `Adresimiz: ${address}`
        : 'Adres bilgisini şu anda paylaşamıyorum. İsterseniz işletme yetkilisi yardımcı olsun.';
    }

    if (this.isWorkingHoursQuestion(normalized)) {
      return this.buildWorkingHoursAnswer(settings);
    }

    if (this.isServiceListQuestion(normalized)) {
      return this.buildServiceMenu(services, 'Aktif hizmetlerimiz:');
    }

    if (this.isBusinessQuestion(normalized)) {
      const businessName = this.pickBusinessField(businessProfile, ['name', 'businessName']) || 'işletmemiz';
      const address = this.pickBusinessField(businessProfile, ['address', 'fullAddress', 'location']);
      return address
        ? `${businessName} için yardımcı olabilirim. Adres: ${address}`
        : `${businessName} için yardımcı olabilirim. İsterseniz randevu oluşturabiliriz.`;
    }

    return 'Kısa bilgi verebilirim veya randevu oluşturabilirim. Randevu için ad soyad, hizmet ve tarih/saat ile başlayalım.';
  }

  private async getServices(tenantId: string): Promise<ServiceInfo[]> {
    return this.getCached(`services:${tenantId}`, async () =>
      this.prisma.services.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, price: true, duration: true },
        take: 20,
      }),
    );
  }

  private async getBusinessProfile(tenantId: string): Promise<Record<string, any> | null> {
    return this.getCached(`business:${tenantId}`, async () => {
      const delegate = (this.prisma as any).businessProfile;
      if (!delegate?.findUnique) {
        return null;
      }
      return delegate.findUnique({ where: { tenantId } }).catch(() => null);
    });
  }

  private async getTenantSettings(tenantId: string) {
    return this.getCached(`settings:${tenantId}`, async () =>
      this.prisma.tenant_settings.findUnique({
        where: { tenantId },
        select: { workingHoursStart: true, workingHoursEnd: true, workingDays: true },
      }),
    );
  }

  private async getCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const value = await loader();
    this.cache.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  private findServiceMatch(services: ServiceInfo[], normalizedText: string): ServiceInfo | null {
    return (
      services.find((service) => {
        const name = this.normalize(service.name);
        return name && (normalizedText.includes(name) || name.includes(normalizedText));
      }) || null
    );
  }

  private buildPriceAnswer(service: ServiceInfo): string {
    if (service.price == null) {
      return `${service.name} için fiyat bilgisini şu anda paylaşamıyorum.`;
    }
    return `${service.name} fiyatı ${service.price} TL.`;
  }

  private buildServiceMenu(services: ServiceInfo[], prefix: string): string {
    if (!services.length) {
      return 'Şu anda aktif hizmet bilgisi görünmüyor.';
    }

    const summary = services
      .slice(0, 6)
      .map((service) => {
        const price = service.price != null ? ` - ${service.price} TL` : '';
        return `${service.name}${price}`;
      })
      .join(', ');

    return `${prefix} ${summary}`;
  }

  private buildWorkingHoursAnswer(settings: { workingHoursStart?: string | null; workingHoursEnd?: string | null; workingDays?: string | null } | null): string {
    const start = settings?.workingHoursStart || '09:00';
    const end = settings?.workingHoursEnd || '18:00';
    const days = this.humanizeWorkingDays(settings?.workingDays || '1,2,3,4,5');
    return `Çalışma saatlerimiz ${days}, ${start} - ${end}.`;
  }

  private humanizeWorkingDays(raw: string): string {
    const labels: Record<string, string> = {
      '0': 'Pazar',
      '1': 'Pazartesi',
      '2': 'Salı',
      '3': 'Çarşamba',
      '4': 'Perşembe',
      '5': 'Cuma',
      '6': 'Cumartesi',
    };

    const values = String(raw || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => labels[value])
      .filter(Boolean);

    return values.length ? values.join(', ') : 'hafta içi';
  }

  private pickBusinessField(profile: Record<string, any> | null, keys: string[]): string | null {
    if (!profile) {
      return null;
    }

    for (const key of keys) {
      const value = String(profile[key] || '').trim();
      if (value) {
        return value;
      }
    }

    return null;
  }

  private isPriceQuestion(text: string): boolean {
    return /\b(fiyat|ucret|ücret|ne kadar)\b/.test(text);
  }

  private isDurationQuestion(text: string): boolean {
    return /\b(kac dakika|kaç dakika|ne kadar surer|ne kadar sürer|sure|süre)\b/.test(text);
  }

  private isAddressQuestion(text: string): boolean {
    return /(adres|adresiniz|konum|lokasyon|nerede)/.test(text);
  }

  private isWorkingHoursQuestion(text: string): boolean {
    return /(calisma saat|çalışma saat|kacta acik|kaçta açık|saat kac|saat kaç|acik misiniz|açık mısınız)/.test(text);
  }

  private isServiceListQuestion(text: string): boolean {
    return /\b(hizmet|islem|işlem|neler yapiyorsunuz|neler yapiyosunuz|hizmetleriniz)\b/.test(text);
  }

  private isBusinessQuestion(text: string): boolean {
    return /\b(isletme|işletme|merkez|salon|siz kimsiniz|hakkinizda|hakkınızda)\b/.test(text);
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/[ıİ]/g, 'i')
      .replace(/[ğĞ]/g, 'g')
      .replace(/[şŞ]/g, 's')
      .replace(/[çÇ]/g, 'c')
      .replace(/[öÖ]/g, 'o')
      .replace(/[üÜ]/g, 'u')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

}
