import { AgentReplyRequest } from './agent-types';

export function normalizeAgentCustomerPhone(
  payload: AgentReplyRequest,
): string {
  const raw = String(payload.customerPhone || payload.from || '').trim();
  return raw || 'unknown-customer';
}

export type SuggestedServiceCleanupPatch = {
  nextSuggestedServiceId: undefined;
  nextSuggestedServiceName: undefined;
};

export type CustomerNameCommitPatch = {
  nextCustomerName: string;
};

export function withAgentChannel<T extends AgentReplyRequest>(
  payload: T,
  channel: 'chat' | 'voice',
): T & { from: string; channel: 'chat' | 'voice'; source: 'chat' | 'voice' } {
  const from = normalizeAgentCustomerPhone(payload);
  return {
    ...payload,
    from,
    channel,
    source: channel,
  };
}

function normalizeServiceText(s: string) {
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

function normalizePersonText(s: string) {
  let text = normalizeServiceText(s);
  text = text
    .replace(/\b(uzman|uzmani|uzmanı|usta|dr|doktor|mr|ms)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function stripVoiceContextMetadata(raw: string): string {
  return String(raw || '')
    .replace(/\[voice_context:[\s\S]*?\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildServiceMatchVariants(name: string) {
  const normalized = normalizeServiceText(name);
  const variants = new Set<string>();
  if (!normalized) return variants;

  variants.add(normalized);
  variants.add(
    normalized
      .replace(
        /\b(epilasyon|bakimi|bakım|uygulamasi|uygulaması|islemi|işlemi)\b/g,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim(),
  );
  variants.add(
    normalized
      .replace(/\b(protez|tirnak|tırnak)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  for (const part of normalized.split(/\s+/)) {
    if (part.length >= 4) variants.add(part);
  }

  variants.delete('');
  return variants;
}

export function detectServiceFromMessage<T extends { name?: string | null }>(
  raw: string,
  services: T[],
): T | null {
  if (!services || services.length === 0) return null;
  const t = normalizeServiceText(raw);
  if (!t) return null;

  const direct =
    services.find((service) => {
      const variants = [...buildServiceMatchVariants(String(service?.name || ''))];
      return variants.some(
        (name) => name && name.length >= 3 && (t.includes(name) || name.includes(t)),
      );
    }) || null;
  if (direct) return direct;

  const userWords = t.split(/\s+/).filter((word) => word.length >= 3);
  if (!userWords.length) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const service of services) {
    const svcWords = [...buildServiceMatchVariants(String(service?.name || ''))]
      .flatMap((name) => name.split(/\s+/))
      .filter((word) => word.length >= 3);
    if (!svcWords.length) continue;
    const overlap = svcWords.filter((word) => userWords.includes(word)).length;
    const score = overlap / svcWords.length;
    if (overlap >= 1 && score > bestScore) {
      best = service;
      bestScore = score;
    }
  }

  if (bestScore >= 0.45) return best;
  return null;
}

export function detectStaffFromMessage<
  T extends { name?: string | null; fullName?: string | null },
>(raw: string, staff: T[]): T | null {
  const normalized = normalizePersonText(raw);
  if (!normalized || !staff?.length) return null;

  const words = normalized.split(/\s+/).filter(Boolean);
  const staffNames = (person: T) =>
    [
      normalizePersonText(String(person?.name || '')),
      normalizePersonText(String(person?.fullName || '')),
    ].filter(Boolean);

  return (
    staff.find((person) =>
      staffNames(person).some((name) => name === normalized),
    ) ||
    staff.find((person) => {
      const names = staffNames(person);
      return names.some((name) =>
        words.some((word) => word.length >= 3 && name.includes(word)),
      );
    }) ||
    null
  );
}

export function extractNameCandidate(raw: string): string | null {
  const cleaned = stripVoiceContextMetadata(raw);
  if (!cleaned) return null;
  if (cleaned.length < 2) return null;
  if (/^\+?\d[\d\s-]+$/.test(cleaned)) return null;

  const normalized = normalizeServiceText(cleaned);
  const banned = [
    'fark etmez',
    'farketmez',
    'siz secin',
    'siz seçin',
    'herhangi',
    'kim olursa',
    'istemiyorum',
    'vazgectim',
    'vazgec',
    'merhaba',
    'selam',
    'slm',
    'sa',
    'hey',
    'günaydın',
    'iyi akşamlar',
    'iyi aksamlar',
    'iyi geceler',
    'nasilsin',
    'naber',
    'iptal',
    'tamam',
    'onayla',
    'onayliyorum',
    'evet',
    'hayir',
    'hayır',
  ];
  if (banned.some((item) => normalized === normalizeServiceText(item) || normalized.includes(normalizeServiceText(item)))) {
    return null;
  }

  const match = cleaned.match(/^(ben\s+)?([a-zA-ZÇĞİÖŞÜçğıöşü\s]{2,})$/);
  if (!match) return null;

  const name = match[2].trim();
  if (name.length < 2) return null;
  return name;
}

export function buildSuggestedServiceCleanupPatch(): SuggestedServiceCleanupPatch {
  return {
    nextSuggestedServiceId: undefined,
    nextSuggestedServiceName: undefined,
  };
}

export function buildCustomerNameCommitPatch(
  customerName: string,
): CustomerNameCommitPatch {
  return {
    nextCustomerName: customerName,
  };
}
