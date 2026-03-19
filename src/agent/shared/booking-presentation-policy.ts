function normalizePresentationText(text: string) {
  return (text || '')
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

function pickPresentationVariant(options: string[], seedText?: string) {
  if (!options?.length) return '';
  const seed = normalizePresentationText(seedText || '') || String(Date.now());
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return options[hash % options.length];
}

export function humanizeAskTimeOnly(seed?: string) {
  return pickPresentationVariant(
    [
      "Saat kaç olsun? Örneğin: '16:00'.",
      "Kaçta ayarlayalım? Örneğin: '16:00'.",
      "Saat alayım. Örneğin: '16:00'.",
    ],
    seed,
  );
}

export function humanizeConfirmNeedEH(seed?: string) {
  return pickPresentationVariant(
    [
      'Onaylıyor musunuz?',
      'Tamamsa evet deyin, istemezseniz hayır diyebilirsiniz.',
      'Randevuyu onaylıyor musunuz? Evet veya hayır diyebilirsiniz.',
    ],
    seed,
  );
}

export function formatBookingSuccess() {
  return 'Rezervasyonunuz oluşturuldu. Randevunuzdan 2 saat önce bir hatırlatma mesajı alacaksınız.';
}

export function formatEditSuccess(
  startAtLabel: string,
  apptId: string,
  seed?: string,
) {
  return pickPresentationVariant(
    [
      `Randevunuzu güncelledim. Yeni tarih: ${startAtLabel}. Kayıt numarası: ${apptId}.`,
      `Randevu güncellendi. Yeni tarih: ${startAtLabel}. Kayıt numarası: ${apptId}.`,
      `Randevu değiştirildi. Yeni tarih: ${startAtLabel}. Kayıt numarası: ${apptId}.`,
    ],
    seed || startAtLabel + apptId,
  );
}
