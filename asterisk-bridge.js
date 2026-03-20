'use strict';

const AriClient = require('ari-client');
const WebSocket = require('ws');
const dgram = require('dgram');
const crypto = require('crypto');

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USERNAME = process.env.ARI_USERNAME || 'user';
const ARI_PASSWORD = process.env.ARI_PASSWORD || 'supersecret';
const ARI_APP = process.env.ARI_APP || 'sip-bridge';

const API_WS_URL =
  process.env.BOT_STREAM_URL ||
  (process.env.WS_BASE_URL ? `${process.env.WS_BASE_URL}/bot/stream` : '') ||
  'ws://127.0.0.1:3001/bot/stream';

const TENANT_ID =
  process.env.DEFAULT_TENANT_ID ||
  process.env.TENANT_ID ||
  'cmkeas8p500056hpg59gmkquc';

const FRAME_SIZE = 160;
const FRAME_MS = 20;

const MAX_QUEUE_FRAMES = Math.max(
  5,
  Number(process.env.ASTERISK_MAX_QUEUE_FRAMES || 15),
);
const MAX_QUEUE_BYTES = FRAME_SIZE * MAX_QUEUE_FRAMES;

const CLEAR_FLUSH_SILENCE_FRAMES = 6;

const RTP_PAYLOAD_TYPE_PCMU = 0;

const activeCalls = new Map();

function log(...args) {
  console.log('[ASTERISK-BRIDGE]', ...args);
}

function isHelperChannel(channel) {
  const name = String(channel?.name || '');
  const id = String(channel?.id || '');

  if (name.includes('Snoop')) return true;
  if (name.includes('UnicastRTP')) return true;
  if (name.includes('External')) return true;
  if (id.startsWith('snoop-')) return true;

  return false;
}

function findCtxByAnyChannelId(channelId) {
  for (const ctx of activeCalls.values()) {
    if (!ctx) continue;

    if (ctx.caller?.id === channelId) return ctx;
    if (ctx.external?.id === channelId) return ctx;
    if (ctx.bridge?.id === channelId) return ctx;
  }

  return null;
}

async function main() {
  log('BOOTING...');

  const ari = await AriClient.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD);

  log(`connected ARI_URL=${ARI_URL}`);

  ari.on('StasisStart', async (event, channel) => {
    try {
      if (!channel) return;

      if (isHelperChannel(channel)) return;

      if (activeCalls.has(channel.id)) return;

      const callId = channel.id;

      log('incoming', callId);

      try {
        await channel.answer();
      } catch {}

      const ctx = await setupCall(ari, channel);

      activeCalls.set(channel.id, ctx);
    } catch (err) {
      log('StasisStart error', err);

      try {
        await channel.hangup();
      } catch {}
    }
  });

  ari.on('ChannelDestroyed', async (_event, channel) => {
    if (!channel) return;

    const ctx = findCtxByAnyChannelId(channel.id);

    if (!ctx) return;

    if (ctx.caller?.id !== channel.id) return;

    await cleanupCall(ctx);

    activeCalls.delete(ctx.callId);
  });

  ari.start(ARI_APP);
}

async function setupCall(ari, caller) {
  const callId = caller.id;

  const rtp = createRtpBridge(callId);

  const wsUrl = new URL(API_WS_URL);


wsUrl.searchParams.set('tenantId', TENANT_ID);
wsUrl.searchParams.set('callId', callId);


const callerNumber =
  caller?.caller?.number ||
  caller?.channelvars?.CALLERID_num ||
  caller?.channelvars?.CALLERIDNUM ||
  caller?.connected?.number ||
  caller?.dialplan?.callerid ||
  caller?.caller?.id ||
  '';

const calledNumber =
  caller?.dialplan?.exten ||
  caller?.channelvars?.EXTEN ||
  caller?.connected?.number ||
  '';

if (callerNumber) wsUrl.searchParams.set('from', String(callerNumber));
if (calledNumber) wsUrl.searchParams.set('to', String(calledNumber));

log('callerNumber=', callerNumber, 'calledNumber=', calledNumber, 'callId=', callId);


  const ctx = {
    callId,
    ari,
    caller,
    external: null,
    bridge: null,
    ws: null,
    rtp,
    cleaned: false,
  };

  const ws = new WebSocket(wsUrl.toString());

  ctx.ws = ws;

  ws.on('open', () => {
safeWsSend(ctx, {
  event: 'start',
  start: {
    callId,
    tenantId: TENANT_ID,
    from: callerNumber ? String(callerNumber) : undefined,
    to: calledNumber ? String(calledNumber) : undefined,
    streamSid: callId,
  },
});
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'media') {
        rtp.sendAudio(msg.media.payload);

        return;
      }

      if (msg.event === 'clear') {
        rtp.clear();

        return;
      }
    } catch {}
  });

  ws.on('close', async () => {
    if (!ctx.cleaned) {
      await cleanupCall(ctx);

      activeCalls.delete(callId);
    }
  });

  const waitPort = await waitForRtpPort(rtp);

  const external = await ari.channels.externalMedia({
    app: ARI_APP,
    external_host: `127.0.0.1:${waitPort}`,
    format: 'ulaw',
  });

  ctx.external = external;

  const bridge = await ari.bridges.create({ type: 'mixing' });

  ctx.bridge = bridge;

  await bridge.addChannel({
    channel: [caller.id, external.id],
  });

  rtp.onAudio = (payload) => {
    safeWsSend(ctx, {
      event: 'media',
      media: { payload },
    });
  };

  return ctx;
}

function safeWsSend(ctx, data) {
  try {
    if (!ctx.ws) return;

    if (ctx.ws.readyState !== WebSocket.OPEN) return;

    ctx.ws.send(JSON.stringify(data));
  } catch {}
}

async function cleanupCall(ctx) {
  if (!ctx || ctx.cleaned) return;

  ctx.cleaned = true;

  try {
    ctx.ws?.close();
  } catch {}

  try {
    ctx.rtp?.close();
  } catch {}

  try {
    await ctx.bridge?.destroy();
  } catch {}

  try {
    await ctx.external?.hangup();
  } catch {}

  try {
    await ctx.caller?.hangup();
  } catch {}
}

function waitForRtpPort(rtp) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const timer = setInterval(() => {
      if (rtp.port) {
        clearInterval(timer);

        resolve(rtp.port);
      }

      if (Date.now() - start > 3000) {
        clearInterval(timer);

        reject('RTP timeout');
      }
    }, 25);
  });
}

function createRtpBridge(callId) {
  const socket = dgram.createSocket('udp4');

  let remote = null;

  let seq = 0;
  let ts = 0;

  const ssrc = crypto.randomBytes(4).readUInt32BE(0);

  let queue = [];
  let queuedBytes = 0;

  let closed = false;

  const silenceFrame = Buffer.alloc(FRAME_SIZE, 0xff);

  let pendingSilence = 0;

  const api = {
    port: null,

    onAudio: null,

    sendAudio(payloadB64) {
      if (closed) return;

      const buf = Buffer.from(payloadB64, 'base64');

      let offset = 0;

      while (offset < buf.length) {
        const end = Math.min(offset + FRAME_SIZE, buf.length);

        let frame = buf.slice(offset, end);

        if (frame.length < FRAME_SIZE) {
          const padded = Buffer.alloc(FRAME_SIZE, 0xff);

          frame.copy(padded);

          frame = padded;
        }

        queue.push(frame);

        queuedBytes += FRAME_SIZE;

        offset = end;
      }

      if (queuedBytes > MAX_QUEUE_BYTES) {
        while (queuedBytes > MAX_QUEUE_BYTES) {
          queue.shift();

          queuedBytes -= FRAME_SIZE;
        }
      }
    },

    clear() {
      queue = [];

      queuedBytes = 0;

      pendingSilence = CLEAR_FLUSH_SILENCE_FRAMES;
    },

    close() {
      closed = true;

      clearInterval(ticker);

      socket.close();
    },
  };

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;

    remote = {
      address: rinfo.address,

      port: rinfo.port,
    };

    const payload = msg.slice(12);

    api.onAudio?.(payload.toString('base64'));
  });

  socket.bind(0, '127.0.0.1', () => {
    api.port = socket.address().port;
  });

  const ticker = setInterval(() => {
    if (closed) return;

    if (!remote) return;

    let audio;

    if (pendingSilence > 0) {
      audio = silenceFrame;

      pendingSilence--;
    } else if (queue.length > 0) {
      audio = queue.shift();

      queuedBytes -= FRAME_SIZE;
    } else {
      return;
    }

    const packet = Buffer.alloc(12 + FRAME_SIZE);

    packet[0] = 0x80;

    packet[1] = RTP_PAYLOAD_TYPE_PCMU;

    packet.writeUInt16BE(seq & 0xffff, 2);

    packet.writeUInt32BE(ts, 4);

    packet.writeUInt32BE(ssrc, 8);

    audio.copy(packet, 12);

    socket.send(packet, remote.port, remote.address);

    seq = (seq + 1) & 0xffff;

    ts += FRAME_SIZE;
  }, FRAME_MS);

  return api;
}

main().catch((err) => {
  console.error(err);

  process.exit(1);
});
