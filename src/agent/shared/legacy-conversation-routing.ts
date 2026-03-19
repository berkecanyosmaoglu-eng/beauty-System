export type LegacyGlobalIntent =
  | 'NEW_BOOKING'
  | 'LIST_APPOINTMENTS'
  | 'MY_APPOINTMENT_TIME'
  | 'RESCHEDULE_BOOKING'
  | 'CANCEL_BOOKING'
  | 'FAQ_GENERAL'
  | 'UNKNOWN';

export function detectLegacyGlobalIntent(raw: string): LegacyGlobalIntent {
  const t = normalizeTr(raw);
  if (!t) return 'UNKNOWN';

  if (looksLikeCancelIntent(raw)) return 'CANCEL_BOOKING';
  if (looksLikeRescheduleIntent(raw) || looksLikeGenericEditIntent(raw))
    return 'RESCHEDULE_BOOKING';
  if (looksLikeUpcomingQuery(raw)) return 'LIST_APPOINTMENTS';
  if (looksLikeBookingIntent(raw)) return 'NEW_BOOKING';

  if (
    looksLikeProcedureQuestion(raw) ||
    looksLikePriceQuestion(raw) ||
    looksLikeServiceListRequest(raw) ||
    looksLikeAddressOrHours(raw)
  ) {
    return 'FAQ_GENERAL';
  }

  return 'UNKNOWN';
}

function normalizeTr(s: string) {
  return (s || '')
    .toLowerCase()
    .replace(/[’'`"]/g, '')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeUpcomingQuery(raw: string) {
  const t = normalizeTr(raw);
  const hasApptWord =
    t.includes('randevu') ||
    t.includes('rezervasyon') ||
    t.includes('randevum') ||
    t.includes('rezervasyonum');
  if (!hasApptWord) return false;

  const wantsInfo =
    t.includes('saatimi unuttum') ||
    t.includes('saatini unuttum') ||
    t.includes('unuttum') ||
    t.includes('kontrol') ||
    t.includes('kontrol et') ||
    t.includes('goster') ||
    t.includes('göster') ||
    t.includes('goruntule') ||
    t.includes('görüntüle') ||
    t.includes('listele') ||
    t.includes('ne zaman') ||
    t.includes('ne zamana') ||
    t.includes('ne zamandi') ||
    t.includes('ne zamandı') ||
    t.includes('tarih') ||
    t.includes('tarihim') ||
    t.includes('saat kac') ||
    t.includes('saat kaç') ||
    t.includes('kacda') ||
    t.includes('kaçta');

  const shortQuestion =
    t.includes('?') && (t.includes('randevu') || t.includes('rezervasyon'));

  return wantsInfo || shortQuestion;
}

function looksLikeBookingIntent(raw: string) {
  const t = normalizeTr(raw);
  if (t === 'randevu' || t === 'rezervasyon') return true;
  const hasRandevu = t.includes('randevu') || t.includes('rezervasyon');
  const serviceLedBooking =
    /(almak|istiyorum|istiyoruz|isterim|istiyoruz|olsun|ayarla|olustur|oluştur)/.test(
      t,
    ) &&
    /(lazer|epilasyon|cilt|bakim|bakım|manikur|manikür|pedikur|pedikür|protez|tirnak|tırnak)/.test(
      t,
    );
  if (!hasRandevu && !serviceLedBooking) return false;
  const verbs = [
    'olustur',
    'oluştur',
    'ayarla',
    'yap',
    'yapal',
    'al',
    'alin',
    'almak',
    'istiyorum',
    'istiyoruz',
    'isterim',
    'rezervasyon yap',
    'randevu yap',
    'randevu al',
  ];
  if (serviceLedBooking || verbs.some((v) => t.includes(normalizeTr(v))))
    return true;
  if (t.includes('yarin') || t.includes('bugun') || /\b\d{1,2}:\d{2}\b/.test(t))
    return true;
  return false;
}

function looksLikeCancelIntent(raw: string) {
  const t = normalizeTr(raw);
  return (
    t === 'iptal' ||
    t.includes('iptal et') ||
    t.includes('randevu iptal') ||
    t.includes('randevumu iptal') ||
    t.includes('vazgectim') ||
    t.includes('vazgec')
  );
}

function looksLikeRescheduleIntent(raw: string) {
  const t = normalizeTr(raw);
  if (
    t.includes('randevu degis') ||
    t.includes('randevu değiş') ||
    t.includes('randevumu degis') ||
    t.includes('randevumu değiş') ||
    t.includes('tarih degis') ||
    t.includes('saat degis') ||
    t.includes('ertele') ||
    t.includes('ileri al') ||
    t.includes('geri al') ||
    t.includes('baska saate') ||
    t.includes('baska tarihe')
  ) {
    return true;
  }

  const hasTime =
    /\b\d{1,2}:\d{2}\b/.test(t) ||
    /\b(saat\s*)?\d{1,2}(\.?\d{2})?\s*(a|e)?\b/.test(t);
  const hasChangeVerb =
    t.includes('degis') ||
    t.includes('değiş') ||
    t.includes('guncelle') ||
    t.includes('güncelle') ||
    t.includes('al') ||
    t.includes('cek') ||
    t.includes('çek') ||
    t.includes('tas') ||
    t.includes('taş') ||
    t.includes('yap');

  if (hasTime && hasChangeVerb) return true;
  if (t.includes('saatini') && hasChangeVerb) return true;

  if (
    (t.includes('randevu') || t.includes('saatini')) &&
    (t.includes('aldin mi') ||
      t.includes('aldın mı') ||
      t.includes('yaptin mi') ||
      t.includes('yaptın mı'))
  ) {
    return true;
  }

  return false;
}

function looksLikeGenericEditIntent(raw: string) {
  const t = normalizeTr(raw);
  return (
    (t.includes('randevu') &&
      (t.includes('degis') ||
        t.includes('değiş') ||
        t.includes('guncelle') ||
        t.includes('güncelle') ||
        t.includes('duzenle') ||
        t.includes('düzenle'))) ||
    (t.includes('randevu') && (t.includes('iptal') || t.includes('ertele'))) ||
    (t.includes('randevu') &&
      (t.includes('ne zaman') ||
        t.includes('ne zamana') ||
        t.includes('hangi gun') ||
        t.includes('hangi gün') ||
        t.includes('tarihi') ||
        t.includes('saat kac') ||
        t.includes('saat kaç') ||
        t.includes('ne zamandi') ||
        t.includes('ne zamandı')))
  );
}

function looksLikeServiceListRequest(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('hizmetler') ||
    t.includes('hizmet list') ||
    t.includes('listeyi at') ||
    t.includes('neler var') ||
    t.includes('servisler')
  );
}

function looksLikePriceQuestion(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('fiyat') ||
    t.includes('ucret') ||
    t.includes('kac tl') ||
    t.includes('kaç tl')
  );
}

function looksLikeAddressOrHours(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('adres') ||
    t.includes('konum') ||
    t.includes('nerde') ||
    t.includes('nerede') ||
    t.includes('calisma saati') ||
    t.includes('çalışma saati') ||
    t.includes('kacda') ||
    t.includes('kaçta')
  );
}

function looksLikeProcedureQuestion(msg: string) {
  const t = normalizeTr(msg);
  return (
    t.includes('nasil') ||
    t.includes('hakkinda bilgi') ||
    t.includes('hakkında bilgi') ||
    t.includes('bilgi almak istiyorum') ||
    t.includes('surec') ||
    t.includes('kac seans') ||
    t.includes('seans') ||
    t.includes('acitir') ||
    t.includes('can yakar') ||
    t.includes('zararli') ||
    t.includes('yan etk') ||
    t.includes('risk') ||
    t.includes('sonrasi') ||
    t.includes('bakim') ||
    t.includes('kimlere uygun degil') ||
    t.includes('kimler icin uygun degil')
  );
}
