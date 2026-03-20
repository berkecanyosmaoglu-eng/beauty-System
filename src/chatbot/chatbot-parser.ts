export type ChatbotServiceCandidate = {
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
]);

export function findChatbotServiceMatch<T extends ChatbotServiceCandidate>(
  services: T[],
  rawText: string,
): T | null {
  const normalizedText = normalizeChatbotText(rawText);
  return (
    services.find((service) => {
      const name = normalizeChatbotText(String(service.name || ''));
      return name && (normalizedText.includes(name) || name.includes(normalizedText));
    }) || null
  );
}

export function extractChatbotCustomerName(
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

  const compact = normalizeChatbotText(text);
  if (
    !looksLikeChatbotBookingIntent(text) &&
    !extractChatbotDateTimeText(text) &&
    /^[a-zçğıöşü]+\s+[a-zçğıöşü]+(?:\s+[a-zçğıöşü]+)?$/i.test(compact)
  ) {
    return cleanupNameCandidate(text, serviceName);
  }

  return null;
}

export function extractChatbotDateTimeText(rawText: string): string | null {
  const text = String(rawText || '').trim();
  const normalized = normalizeChatbotText(text);
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

export function looksLikeChatbotBookingIntent(rawText: string): boolean {
  const normalized = normalizeChatbotText(rawText);
  if (
    /\b(randevu|rezervasyon|olusturmak istiyorum|oluşturmak istiyorum|uygun musait|uygun müsait)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return (
    Boolean(extractChatbotDateTimeText(rawText)) &&
    /\b(icin|için|olur mu|musait|müsait)\b/.test(normalized)
  );
}

export function isChatbotAffirmative(rawText: string): boolean {
  return /^(evet|olur|tamam|uygun|dogru|doğru|onayliyorum|onaylıyorum)$/i.test(
    normalizeChatbotText(rawText),
  );
}

export function isChatbotNegative(rawText: string): boolean {
  return /^(hayir|hayır|yok|olmaz|yanlis|yanlış)$/i.test(
    normalizeChatbotText(rawText),
  );
}

export function normalizeChatbotText(value: string): string {
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
    .map((part) => normalizeChatbotText(part))
    .filter(Boolean);

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => fillerWords.has(part) || part.length < 2)
  ) {
    return null;
  }

  if (serviceName && parts.join(' ').includes(normalizeChatbotText(serviceName))) {
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
