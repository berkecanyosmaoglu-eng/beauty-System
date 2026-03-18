import {
  mergeVoiceFragments,
  shouldBufferShortVoiceTranscript,
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
});
