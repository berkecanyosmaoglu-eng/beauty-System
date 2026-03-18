export function shapeVoiceAgentReply(reply: string): string {
  let text = String(reply || '').trim();
  if (!text) return 'Tamam.';

  text = text
    .replace(/[🙂😕✅👍✨😊😉🙏]/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const slotSuggestion = shapeSlotSuggestion(text);
  if (slotSuggestion) return slotSuggestion;

  const lines = text
    .split(/\n+/)
    .map((line) => cleanupLine(line))
    .filter(Boolean)
    .filter((line) => !isFillerLine(line));

  const cleaned = lines
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return 'Tamam.';

  const sentences = splitSentences(cleaned)
    .map((sentence) => cleanupLine(sentence))
    .filter(Boolean)
    .filter((sentence) => !isFillerLine(sentence));

  if (!sentences.length) return 'Tamam.';

  const deduped: string[] = [];
  for (const sentence of sentences) {
    if (
      !deduped.some(
        (prev) => normalizeVoiceText(prev) === normalizeVoiceText(sentence),
      )
    ) {
      deduped.push(sentence);
    }
  }

  const question = deduped.find((sentence) => /\?$/.test(sentence));
  const shortQuestion = question
    ? ensureTerminalPunctuation(question, '?')
    : '';

  if (shortQuestion && deduped.length === 1) return shortQuestion;

  const firstStatement = deduped.find((sentence) => !/\?$/.test(sentence));
  if (shortQuestion && firstStatement) {
    if (
      normalizeVoiceText(firstStatement).includes(
        normalizeVoiceText(shortQuestion),
      )
    ) {
      return shortQuestion;
    }
    return `${ensureTerminalPunctuation(firstStatement)} ${shortQuestion}`.trim();
  }

  return deduped
    .slice(0, 1)
    .map((sentence) =>
      ensureTerminalPunctuation(sentence, /\?$/.test(sentence) ? '?' : '.'),
    )
    .join(' ')
    .trim();
}

function shapeSlotSuggestion(text: string): string | null {
  const itemMatch = text.match(/(?:^|\n)\s*1\)\s*([^\n]+)/);
  if (!itemMatch) return null;

  const firstOption = cleanupLine(itemMatch[1]);
  if (!firstOption) return null;

  const normalized = normalizeVoiceText(text);
  const prefix = normalized.includes('calismiyoruz')
    ? 'Bu saatlerde çalışmıyoruz.'
    : normalized.includes('dolu')
      ? 'O saat dolu.'
      : 'Şu saat uygun.';

  return `${prefix} ${ensureTerminalPunctuation(firstOption)} Uygun mu?`;
}

function cleanupLine(line: string): string {
  return String(line || '')
    .replace(/^(Randevu özeti|Değişiklik özeti):\s*/i, '')
    .replace(/^(Onaylıyor musunuz|Onaylıyor musun)\??$/i, 'Onaylıyor musunuz?')
    .replace(
      /Tamamsa evet deyin, istemezseniz hayır diyebilirsiniz\.?/gi,
      'Onaylıyor musunuz?',
    )
    .replace(
      /Randevuyu onaylıyor musunuz\? Evet veya hayır diyebilirsiniz\.?/gi,
      'Onaylıyor musunuz?',
    )
    .replace(
      /Rezervasyondan 2 saat önce telefonunuza bir hatırlatma mesajı gönderilecektir\.?/gi,
      '',
    )
    .replace(/Başka bir şeyle yardımcı olabilir miyim\??/gi, '')
    .replace(/Rica ederim[,!]? her zaman buradayız\.?/gi, '')
    .replace(/Görüşmek üzere\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isFillerLine(line: string): boolean {
  const normalized = normalizeVoiceText(line);
  return (
    !normalized ||
    [
      'tesekkur ederim',
      'rica ederim',
      'her zaman buradayiz',
      'baska bir sey ile yardimci olabilir miyim',
      'gorusmek uzere',
    ].some((item) => normalized === item)
  );
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ensureTerminalPunctuation(text: string, punctuation = '.'): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}${punctuation}`;
}

function normalizeVoiceText(text: string): string {
  return String(text || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
