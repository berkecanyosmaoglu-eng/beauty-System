import { shapeVoiceAgentReply } from './voice-response-policy';

describe('shapeVoiceAgentReply', () => {
  it('keeps voice confirmations concise', () => {
    const reply = shapeVoiceAgentReply(
      'Randevu özeti:\nYarın 17:00 için kayıt hazır.\nTamamsa evet deyin, istemezseniz hayır diyebilirsiniz.',
    );

    expect(reply).toBe('Yarın 17:00 için kayıt hazır. Uygunsa onaylayayım mı?');
  });

  it('turns slot menus into a single suggestion question', () => {
    const reply = shapeVoiceAgentReply(
      'O saat dolu 😕 Şunlar uygun:\n1) Yarın 17:00\n2) Yarın 18:00\nBirini seç (1-9) ya da saati söyle 🙂',
    );

    expect(reply).toBe('O saat dolu. Yarın 17:00. Uygun mu?');
  });

  it('removes long closings from success responses', () => {
    const reply = shapeVoiceAgentReply(
      'Yarın 12:00 için rezervasyonunuzu oluşturdum.\nRezervasyondan 2 saat önce telefonunuza bir hatırlatma mesajı gönderilecektir. Görüşmek üzere.',
    );

    expect(reply).toBe('Yarın 12:00 için rezervasyonunuzu oluşturdum.');
  });

  it('suppresses repeated greeting leads after the first turn', () => {
    const reply = shapeVoiceAgentReply(
      'Merhaba, lazer epilasyon için yardımcı olayım. Size nasıl yardımcı olabilirim?',
    );

    expect(reply).toBe('lazer epilasyon için yardımcı olayım.');
  });
});
