import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentReplyRequest } from '../agent/shared/agent-types';

type ServiceInfo = {
  id: string;
  name: string;
  price?: number | null;
  duration?: number | null;
  description?: string | null;
};

@Injectable()
export class KnowledgeService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: unknown }
  >();

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

    if (this.isOutOfScopePersonalChat(normalized)) {
      return 'Ben sadece güzellik merkeziyle ilgili konularda yardımcı olabilirim. Hizmet bilgisi, fiyat, adres, çalışma saati ve randevu konularında yardımcı olayım.';
    }

    if (matchedService) {
      if (this.isPriceQuestion(normalized)) {
        return this.buildPriceAnswer(matchedService);
      }

      if (this.isDurationQuestion(normalized)) {
        return this.buildDurationAnswer(matchedService);
      }

      if (this.isPainQuestion(normalized)) {
        return this.buildPainAnswer(matchedService);
      }

      if (
        this.isServiceInfoQuestion(normalized) ||
        this.isBareServiceMention(normalized, matchedService) ||
        this.isGenericInfoQuestion(normalized)
      ) {
        return this.buildServiceInfoAnswer(matchedService, normalized);
      }
    }

    if (this.isPriceQuestion(normalized)) {
      return this.buildServiceMenu(services, 'Fiyat bilgileri kısaca şöyle:');
    }

    if (this.isDurationQuestion(normalized)) {
      return 'Süre bilgisi için hangi işlemi istediğinizi söyler misiniz?';
    }

    if (this.isAddressQuestion(normalized)) {
      const address = this.pickBusinessField(businessProfile, [
        'address',
        'fullAddress',
        'location',
      ]);

      return address
        ? `Adresimiz: ${address}`
        : 'Adres bilgisini şu anda paylaşamıyorum.';
    }

    if (this.isWorkingHoursQuestion(normalized)) {
      return this.buildWorkingHoursAnswer(settings);
    }

    if (this.isServiceListQuestion(normalized)) {
      return this.buildServiceMenu(services, 'Aktif hizmetlerimiz:');
    }

    if (this.isBusinessQuestion(normalized)) {
      const businessName =
        this.pickBusinessField(businessProfile, ['name', 'businessName']) ||
        'işletmemiz';

      const address = this.pickBusinessField(businessProfile, [
        'address',
        'fullAddress',
        'location',
      ]);

      return address
        ? `${businessName} için yardımcı olabilirim. Adresimiz ${address}.`
        : `${businessName} için yardımcı olabilirim.`;
    }

    if (this.isGenericInfoQuestion(normalized)) {
      return 'Hangi işlem hakkında bilgi istersiniz? Örneğin lazer epilasyon, cilt bakımı, protez tırnak, manikür veya pedikür diyebilirsiniz.';
    }

    return 'Ben sadece güzellik merkeziyle ilgili konularda yardımcı olabilirim. Hizmet bilgisi, fiyat, adres, çalışma saati ve randevu konularında yardımcı olayım.';
  }

  private async getServices(tenantId: string): Promise<ServiceInfo[]> {
    return this.getCached(`services:${tenantId}`, async () =>
      this.prisma.services.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          price: true,
          duration: true,
          description: true,
        },
        take: 50,
      }),
    );
  }

  private async getBusinessProfile(
    tenantId: string,
  ): Promise<Record<string, any> | null> {
    return this.getCached(`business:${tenantId}`, async () => {
      const delegate = (this.prisma as any).businessProfile;
      if (!delegate?.findUnique) return null;
      return delegate.findUnique({ where: { tenantId } }).catch(() => null);
    });
  }

  private async getTenantSettings(tenantId: string) {
    return this.getCached(`settings:${tenantId}`, async () =>
      this.prisma.tenant_settings.findUnique({
        where: { tenantId },
        select: {
          workingHoursStart: true,
          workingHoursEnd: true,
          workingDays: true,
        },
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

  private findServiceMatch(
    services: ServiceInfo[],
    normalizedText: string,
  ): ServiceInfo | null {
    const cleanText = this.normalize(normalizedText);
    if (!cleanText) return null;

    const scored = services
      .map((service) => {
        const serviceName = this.normalize(service.name);
        const serviceTokens = serviceName.split(' ').filter(Boolean);
        const textTokens = cleanText.split(' ').filter(Boolean);

        let score = 0;

        if (serviceName && cleanText.includes(serviceName)) score += 100;
        if (serviceName && serviceName.includes(cleanText)) score += 60;

        for (const token of serviceTokens) {
          if (token.length < 3) continue;
          if (textTokens.includes(token)) score += 20;
          else if (cleanText.includes(token)) score += 10;
        }

        const overlap = serviceTokens.filter((token) =>
          textTokens.includes(token),
        ).length;
        score += overlap * 15;

        if (this.looksPhoneticallyClose(cleanText, serviceName)) {
          score += 25;
        }

        return { service, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.score >= 20 ? scored[0].service : null;
  }

  private buildPriceAnswer(service: ServiceInfo): string {
    if (service.price == null) {
      return `${service.name} için fiyat bilgisini şu anda paylaşamıyorum.`;
    }

    return `${service.name} fiyatı ${service.price} TL.`;
  }

  private buildDurationAnswer(service: ServiceInfo): string {
    if (!service.duration) {
      return `${service.name} için süre bilgisini şu anda paylaşamıyorum.`;
    }

    return `${service.name} yaklaşık ${service.duration} dakika sürer.`;
  }

  private buildServiceInfoAnswer(
    service: ServiceInfo,
    normalizedQuestion?: string,
  ): string {
    const serviceName = String(service.name || '').trim();
    const lowerService = this.normalize(serviceName);
    const parts: string[] = [];

    if (lowerService.includes('lazer') || lowerService.includes('epilasyon')) {
      parts.push(
        'Lazer epilasyon istenmeyen tüylerin azaltılmasına yönelik bir işlemdir.',
      );
      parts.push('Seans sayısı bölgeye ve kişiye göre değişebilir.');
    } else if (lowerService.includes('cilt')) {
      parts.push(
        `${serviceName} cildin ihtiyacına göre uygulanan bir bakım işlemidir.`,
      );
    } else if (
      lowerService.includes('tırnak') ||
      lowerService.includes('tirnak') ||
      lowerService.includes('protez') ||
      lowerService.includes('manikür') ||
      lowerService.includes('manikur') ||
      lowerService.includes('pedikür') ||
      lowerService.includes('pedikur')
    ) {
      parts.push(`${serviceName} el ve tırnak bakımına yönelik bir işlemdir.`);
    } else if (
      lowerService.includes('kirpik') ||
      lowerService.includes('kaş') ||
      lowerService.includes('kas') ||
      lowerService.includes('bıyık') ||
      lowerService.includes('biyik')
    ) {
      parts.push(`${serviceName} yüz bölgesine yönelik bir güzellik işlemidir.`);
    } else if (
      lowerService.includes('saç') ||
      lowerService.includes('sac') ||
      lowerService.includes('boya')
    ) {
      parts.push(`${serviceName} saç işlemidir.`);
    } else {
      parts.push(`${serviceName} hakkında yardımcı olabilirim.`);
    }

    if (service.duration) {
      parts.push(`Yaklaşık ${service.duration} dakika sürer.`);
    }

    if (service.price != null) {
      parts.push(`Fiyatı ${service.price} TL.`);
    }

    const normalized = this.normalize(normalizedQuestion || '');

    if (this.isPainQuestion(normalized)) {
      parts.push('Uygulama hissi kişiye göre değişebilir.');
    }

    parts.push(
      'İsterseniz fiyat, süre veya randevu uygunluğu konusunda da yardımcı olabilirim.',
    );

    return parts.join(' ');
  }

  private buildPainAnswer(service: ServiceInfo): string {
    const parts: string[] = [
      `${service.name} sırasında hissedilen durum kişiye göre değişebilir.`,
    ];

    if (service.duration) {
      parts.push(`İşlem süresi yaklaşık ${service.duration} dakikadır.`);
    }

    parts.push(
      'Detaylı uygunluk değerlendirmesi için işletmede kısa bilgi verilebilir.',
    );

    return parts.join(' ');
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

  private buildWorkingHoursAnswer(settings: any): string {
    if (!settings) {
      return 'Çalışma saati bilgisini şu anda paylaşamıyorum.';
    }

    const start = settings.workingHoursStart || '09:00';
    const end = settings.workingHoursEnd || '18:00';

    if (Array.isArray(settings.workingDays) && settings.workingDays.length) {
      return `Çalışma saatlerimiz genelde ${settings.workingDays.join(', ')} günleri ${start} - ${end} arasındadır.`;
    }

    return `Çalışma saatlerimiz genelde ${start} - ${end} arasındadır.`;
  }

  private pickBusinessField(
    businessProfile: Record<string, any> | null,
    keys: string[],
  ): string | null {
    if (!businessProfile) return null;

    for (const key of keys) {
      const value = businessProfile[key];
      if (value != null && String(value).trim()) {
        return String(value).trim();
      }
    }

    return null;
  }

  private isPriceQuestion(text: string): boolean {
    return /\b(fiyat|fiyati|fiyatı|ucret|ücret|ne kadar|kaç tl|kac tl|tl)\b/.test(
      text,
    );
  }

  private isDurationQuestion(text: string): boolean {
    return /\b(sure|süre|kac dakika|kaç dakika|ne kadar surer|ne kadar sürer)\b/.test(
      text,
    );
  }

  private isPainQuestion(text: string): boolean {
    return /\b(acir mi|acıtır mı|agrili mi|ağrılı mı|can yakar mi|can yakar mı)\b/.test(
      text,
    );
  }

  private isAddressQuestion(text: string): boolean {
    return /\b(adres|konum|lokasyon|neredesiniz|nereye geliyoruz)\b/.test(text);
  }

  private isWorkingHoursQuestion(text: string): boolean {
    return /\b(calisma saati|çalışma saati|saat kac|saat kaç|acik misiniz|açık mısınız|kacta aciliyor|kaçta açılıyor|kacta kapaniyor|kaçta kapanıyor)\b/.test(
      text,
    );
  }

  private isServiceListQuestion(text: string): boolean {
    return /\b(hizmetler|islemler|işlemler|neler var|hangi islemler|hangi işlemler)\b/.test(
      text,
    );
  }

  private isServiceInfoQuestion(text: string): boolean {
    return /\b(bilgi|detay|nedir|nasil|nasıl|ne ise yarar|ne işe yarar|anlat)\b/.test(
      text,
    );
  }

  private isGenericInfoQuestion(text: string): boolean {
    return /\b(bilgi almak istiyorum|bilgi verir misin|yardimci olur musun|yardımcı olur musun|detay verir misin)\b/.test(
      text,
    );
  }

  private isBusinessQuestion(text: string): boolean {
    return /\b(isletme|işletme|mekan|mekân|salon|merkez)\b/.test(text);
  }

  private isOutOfScopePersonalChat(text: string): boolean {
    if (!text) return false;

    const inScope =
      /\b(randevu|rezervasyon|lazer|epilasyon|cilt|bakim|bakım|tırnak|tirnak|manikur|manikür|pedikur|pedikür|kirpik|kaş|kas|biyik|bıyık|sac|saç|boya|adres|konum|fiyat|ucret|ücret|çalışma|calisma|saat|hizmet|işlem|islem|salon|merkez|protez|ipek|seans)\b/.test(
        text,
      );

    if (inScope) return false;

    const outOfScope =
      /\b(futbol|mac|maç|galatasaray|fenerbahce|fenerbahçe|besiktas|beşiktaş|siyaset|haber|borsa|hava durumu|film|dizi|oyun|tatil|rekreasyon|ekonomi|kripto|coin|altin|altın)\b/.test(
        text,
      );

    return outOfScope || text.length > 0;
  }

  private isBareServiceMention(
    text: string,
    matchedService: ServiceInfo,
  ): boolean {
    const serviceName = this.normalize(matchedService.name);
    return text === serviceName || text.includes(serviceName);
  }

  private looksPhoneticallyClose(a: string, b: string): boolean {
    const aa = this.phoneticNormalize(a);
    const bb = this.phoneticNormalize(b);

    return aa.includes(bb) || bb.includes(aa);
  }

  private phoneticNormalize(value: string): string {
    return this.normalize(value)
      .replace(/ph/g, 'f')
      .replace(/q/g, 'k')
      .replace(/w/g, 'v')
      .replace(/x/g, 'ks')
      .replace(/ğ/g, 'g')
      .replace(/ı/g, 'i')
      .replace(/u/g, 'ü')
      .replace(/o/g, 'ö');
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
