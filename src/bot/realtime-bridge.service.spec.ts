import {
  mergeVoiceFragments,
  normalizeTranscriptForAgent,
  rewriteAgentReplyForVoice,
  shouldBufferShortVoiceTranscript,
  shortenReplyForPhone,
} from './realtime-bridge.service.ts';

describe('RealtimeBridgeService voice transcript helpers', () => {
  it('buffers short split name fragments in WAIT_NAME', () => {
    expect(shouldBufferShortVoiceTranscript('WAIT_NAME', 'Mehmet')).toBe(true);
    expect(mergeVoiceFragments('Mehmet', 'Avcı', 'WAIT_NAME')).toBe(
      'Mehmet Avcı',
    );
  });

  it('buffers short split datetime fragments in WAIT_DATETIME', () => {
    expect(shouldBufferShortVoiceTranscript('WAIT_DATETIME', '20 Mart')).toBe(
      true,
    );
    expect(mergeVoiceFragments('20 Mart', 'saat üç', 'WAIT_DATETIME')).toBe(
      '20 Mart saat üç',
    );
  });

  it('does not buffer staff-like fragments when staff selection no longer exists', () => {
    expect(shouldBufferShortVoiceTranscript('WAIT_STAFF', 'Mehmet')).toBe(
      false,
    );
    expect(mergeVoiceFragments('Mehmet', 'Bey', 'WAIT_STAFF')).toBe('Bey');
  });

  it('does not collapse greeting replies into useless single-word acknowledgements', () => {
    const spoken = shortenReplyForPhone(
      rewriteAgentReplyForVoice(
        'Teşekkür ederim! Size nasıl yardımcı olabilirim?',
      ),
    );

    expect(spoken).toBe('Teşekkür ederim! Size nasıl yardımcı olabilirim?');
    expect(spoken).not.toBe('Tamam.');
    expect(spoken).not.toBe('Peki.');
  });

  it('does not collapse informational replies into useless single-word acknowledgements', () => {
    const spoken = shortenReplyForPhone(
      'Lazer epilasyon için fiyatlarımız bölgeye göre değişiyor. İsterseniz kısa bilgi vereyim.',
    );

    expect(spoken).toBe(
      'Lazer epilasyon için fiyatlarımız bölgeye göre değişiyor. İsterseniz kısa bilgi vereyim.',
    );
    expect(spoken).not.toBe('Tamam.');
  });

  it('keeps explicit acknowledgements short', () => {
    expect(shortenReplyForPhone('Tamam.')).toBe('Tamam.');
    expect(shortenReplyForPhone('Peki.')).toBe('Peki.');
  });

  it('filters assistant/system contamination from normalized transcripts', () => {
    expect(
      normalizeTranscriptForAgent(
        'Güzellik merkezi, randevu, rezervasyon...',
        '',
      ),
    ).toBe('');
    expect(
      normalizeTranscriptForAgent('Ben güzellik merkezinden arıyorum', ''),
    ).toBe('');
    expect(
      normalizeTranscriptForAgent(
        'Merhaba, ben güzellik merkezinden arıyorum lazer fiyatı nedir',
        '',
      ),
    ).toBe('lazer fiyatı nedir');
  });
});
