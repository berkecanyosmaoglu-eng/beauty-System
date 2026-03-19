export type JarvisServiceCandidate = {
  id?: string | null;
  name?: string | null;
};

const fillerWords = new Set([
  'evet',
  'hayir',
  'hayır',
  'tamam',
  'olur',
  'uygun',
  'merhaba',
  'selam',
  'alo',
]);

export function findJarvisServiceMatch<T extends JarvisServiceCandidate>(
  services: T[],
  rawText: string,
): T | null {
  const normalizedText = normalizeJarvisText(rawText);
  return (
    services.find((service) => {
      const name = normalizeJarvisText(String(service.name || ''));
      return name && (normalizedText.includes(name) || name.includes(normalizedText));
    }) || null
  );
}

export function extractJarvisCustomerName(
  rawText: string,
  serviceName?: string,
): string | null {
  const text = String(rawText || '').trim();
  const explicit = text.match(
    /\b(?:ben|ad[ıi]m|ismim|ad soyad[ıi]m|adım soyadım)\s+([^,.;:]+)/i,
  )?.[1];
  const candidate = cleanupNameCandidate(explicit || '', serviceName);
  if (candidate) {
    return candidate;
  }

  const compact = normalizeJarvisText(text);
  if (
    !looksLikeJarvisBookingIntent(text) &&
    !extractJarvisDateTimeText(text) &&
    /^[a-zçğıöşü]+\s+[a-zçğıöşü]+(?:\s+[a-zçğıöşü]+)?$/i.test(compact)
  ) {
    return cleanupNameCandidate(text, serviceName);
  }

  return null;
}

export function extractJarvisDateTimeText(rawText: string): string | null {
  const text = String(rawText || '').trim();
  const normalized = normalizeJarvisText(text);
  if (!normalized) {
    return null;
  }

  const hasRelativeDay =
    /\b(bugun|bugün|yarin|yarın|pazartesi|sali|salı|carsamba|çarşamba|persembe|cuma|cumartesi|pazar)\b/.test(
      normalized,
    );
  const hasCalendarDate = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/.test(text);
  const hasClockTime =
    /\b(?:saat\s*)?\d{1,2}[:.]\d{2}\b/.test(normalized) ||
    /\b\d{1,2}\b\s*(gibi|bucuk|buçuk)\b/.test(normalized);

  return hasRelativeDay || hasCalendarDate || hasClockTime ? text : null;
}

export function looksLikeJarvisBookingIntent(rawText: string): boolean {
  const normalized = normalizeJarvisText(rawText);
  if (
    /\b(randevu|rezervasyon|gelmek istiyorum|ayirtmak istiyorum|uygun musunuz|uygun mu)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return (
    Boolean(extractJarvisDateTimeText(rawText)) &&
    /\b(icin|için|olur mu|müsait|musait)\b/.test(normalized)
  );
}

export function isJarvisAffirmative(rawText: string): boolean {
  return /^(evet|olur|tamam|uygun|dogru|doğru|onayliyorum|onaylıyorum)$/.test(
    normalizeJarvisText(rawText),
  );
}

export function isJarvisNegative(rawText: string): boolean {
  return /^(hayir|hayır|yok|olmaz|yanlis|yanlış)$/.test(
    normalizeJarvisText(rawText),
  );
}

export function buildJarvisDeterministicShortReply(rawText: string): string | null {
  const text = normalizeJarvisText(rawText);
  if (
    [
      /^sesim geliyor mu$/,
      /^beni duyuyor musunuz$/,
      /^sesim duyuluyor mu$/,
      /^ses geliyor mu$/,
      /^beni duyabiliyor musunuz$/,
    ].some((pattern) => pattern.test(text))
  ) {
    return 'Evet, sizi duyuyorum.';
  }

  return null;
}

export function normalizeJarvisText(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s:./-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupNameCandidate(rawValue: string, serviceName?: string): string | null {
  const text = String(rawValue || '')
    .replace(/\b(randevu|rezervasyon|yarin|yarın|bugun|bugün|icin|için)\b.*$/i, '')
    .replace(/\b(saat\s*\d{1,2}[:.]\d{2}|\d{1,2}\s*(gibi|bucuk|buçuk))\b.*$/i, '')
    .trim();

  const parts = text
    .split(/\s+/)
    .map((part) => normalizeJarvisText(part))
    .filter(Boolean);

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => fillerWords.has(part) || part.length < 2)
  ) {
    return null;
  }

  if (serviceName && parts.join(' ').includes(normalizeJarvisText(serviceName))) {
    return null;
  }

  return toTitleCase(parts.join(' '));
}

function toTitleCase(value: string): string {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toLocaleUpperCase('tr-TR') +
        part.slice(1).toLocaleLowerCase('tr-TR'),
    )
    .join(' ');
}
