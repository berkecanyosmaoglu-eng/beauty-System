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
    /\bsaat\s*\d{1,2}\b/.test(normalized) ||
    /\b\d{1,2}\b\s*(gibi|bucuk|buçuk)\b/.test(normalized);

  if (!hasRelativeDay && !hasCalendarDate && !hasClockTime) {
    return null;
  }

  return normalizeDateTimeExpression(text);
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

function normalizeDateTimeExpression(rawValue: string): string {
  let text = String(rawValue || '').trim();
  if (!text) {
    return text;
  }

  const normalized = normalizeChatbotText(text);

  const context = {
    saysMorning: /\b(sabah|erken)\b/.test(normalized),
    saysNoon: /\b(ogle|öğle)\b/.test(normalized),
    saysAfternoon: /\b(ogleden sonra|öğleden sonra|ikindi)\b/.test(normalized),
    saysEvening: /\b(aksam|akşam|gece)\b/.test(normalized),
  };

  const fullClockMatch = normalized.match(/\b(?:saat\s*)?(\d{1,2})[:.](\d{2})\b/);
  if (fullClockMatch) {
    const original = fullClockMatch[0];
    const parsedHour = Number(fullClockMatch[1]);
    const parsedMinute = Number(fullClockMatch[2]);

    if (
      Number.isFinite(parsedHour) &&
      Number.isFinite(parsedMinute) &&
      parsedHour >= 0 &&
      parsedHour <= 23 &&
      parsedMinute >= 0 &&
      parsedMinute <= 59
    ) {
      const normalizedHour = normalizeHourByContext(parsedHour, context);
      const formatted = `saat ${pad2(normalizedHour)}:${pad2(parsedMinute)}`;
      return replaceFirstClockExpression(text, original, formatted);
    }
  }

  const halfMatch = normalized.match(/\b(?:saat\s*)?(\d{1,2})\s*(bucuk|buçuk)\b/);
  if (halfMatch) {
    const original = halfMatch[0];
    const parsedHour = Number(halfMatch[1]);

    if (Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      const normalizedHour = normalizeHourByContext(parsedHour, context);
      const formatted = `saat ${pad2(normalizedHour)}:30`;
      return replaceFirstClockExpression(text, original, formatted);
    }
  }

  const vagueMatch = normalized.match(/\b(?:saat\s*)?(\d{1,2})\s*gibi\b/);
  if (vagueMatch) {
    const original = vagueMatch[0];
    const parsedHour = Number(vagueMatch[1]);

    if (Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      const normalizedHour = normalizeHourByContext(parsedHour, context);
      const formatted = `saat ${pad2(normalizedHour)}:00`;
      return replaceFirstClockExpression(text, original, formatted);
    }
  }

  const plainHourMatch = normalized.match(/\bsaat\s*(\d{1,2})\b/);
  if (plainHourMatch) {
    const original = plainHourMatch[0];
    const parsedHour = Number(plainHourMatch[1]);

    if (Number.isFinite(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      const normalizedHour = normalizeHourByContext(parsedHour, context);
      const formatted = `saat ${pad2(normalizedHour)}:00`;
      return replaceFirstClockExpression(text, original, formatted);
    }
  }

  return text;
}

function normalizeHourByContext(
  hour: number,
  context: {
    saysMorning: boolean;
    saysNoon: boolean;
    saysAfternoon: boolean;
    saysEvening: boolean;
  },
): number {
  let result = hour;

  if (context.saysMorning) {
    if (result === 12) {
      return 0;
    }
    return result;
  }

  if (context.saysNoon) {
    if (result >= 1 && result <= 4) {
      return result + 12;
    }
    if (result === 12) {
      return 12;
    }
    return result;
  }

  if (context.saysAfternoon || context.saysEvening) {
    if (result >= 1 && result <= 11) {
      return result + 12;
    }
    return result;
  }

  // Türkiye kullanımında randevu bağlamında:
  // 1-7 arası çoğunlukla öğleden sonra/akşam kastedilir.
  if (result >= 1 && result <= 7) {
    return result + 12;
  }

  return result;
}

function replaceFirstClockExpression(
  originalText: string,
  matchedNormalized: string,
  replacement: string,
): string {
  const source = String(originalText || '');
  const escaped = escapeRegExp(matchedNormalized)
    .replace(/\\ /g, '\\s+')
    .replace(/c/g, '[cç]')
    .replace(/i/g, '[iıİI]')
    .replace(/o/g, '[oö]')
    .replace(/u/g, '[uü]')
    .replace(/s/g, '[sş]')
    .replace(/g/g, '[gğ]');

  const regex = new RegExp(escaped, 'i');
  if (regex.test(source)) {
    return source.replace(regex, replacement);
  }

  return source;
}

function cleanupNameCandidate(rawValue: string, serviceName?: string): string | null {
  const text = String(rawValue || '')
    .replace(/\b(randevu|rezervasyon|yarin|yarın|bugun|bugün|icin|için)\b.*$/i, '')
    .replace(
      /\b(saat\s*\d{1,2}(?::|\.)?\d{0,2}|\d{1,2}\s*(gibi|bucuk|buçuk))\b.*$/i,
      '',
    )
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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
