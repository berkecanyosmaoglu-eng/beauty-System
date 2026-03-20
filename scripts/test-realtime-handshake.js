require('dotenv').config();

const WebSocket = require('ws');

const apiKey = process.env.OPENAI_API_KEY;
const model =
  process.env.JARVIS_REALTIME_MODEL ||
  process.env.OPENAI_REALTIME_MODEL ||
  'gpt-realtime';

if (!apiKey) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
}

const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
const eventId = `diag_${Date.now()}`;

console.log('Connecting to:', url);
console.log('Using model:', model);
console.log('Event ID:', eventId);

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': 'realtime=v1',
  },
});

const timeout = setTimeout(() => {
  console.error('Timeout: no useful result within 20s');
  try {
    ws.close();
  } catch {}
  process.exit(2);
}, 20000);

ws.on('open', () => {
  console.log('WS OPEN');

const payload = {
  type: 'session.update',
  event_id: eventId,
  session: {},
};

  console.log('SEND:', JSON.stringify(payload));
  ws.send(JSON.stringify(payload));
});

ws.on('message', (buf) => {
  const text = buf.toString();
  console.log('RECV RAW:', text);

  try {
    const evt = JSON.parse(text);

    if (evt.type === 'session.created') {
      console.log('SESSION_CREATED');
    }

    if (evt.type === 'session.updated') {
      console.log('SESSION_UPDATED');
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      process.exit(0);
    }

    if (evt.type === 'error') {
      console.log(
        'ERROR_EVENT:',
        JSON.stringify({
          type: evt.type,
          event_id: evt.event_id || evt?.error?.event_id || null,
          code: evt?.error?.code || null,
          param: evt?.error?.param || null,
          message: evt?.error?.message || null,
          full: evt,
        })
      );
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      process.exit(3);
    }
  } catch (e) {
    console.error('JSON parse failed:', e.message);
  }
});

ws.on('close', (code, reason) => {
  console.log('WS CLOSE:', code, reason ? reason.toString() : '');
});

ws.on('error', (err) => {
  console.error('WS ERROR:', err && err.message ? err.message : err);
});
