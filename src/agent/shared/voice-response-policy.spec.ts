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

  it('preserves the exact final confirmation message', () => {
    const reply = shapeVoiceAgentReply(
      'Rezervasyonunuz oluşturuldu. Randevunuzdan 2 saat önce bir hatırlatma mesajı alacaksınız.',
    );

    expect(reply).toBe(
      'Rezervasyonunuz oluşturuldu. Randevunuzdan 2 saat önce bir hatırlatma mesajı alacaksınız.',
    );
  });
});
