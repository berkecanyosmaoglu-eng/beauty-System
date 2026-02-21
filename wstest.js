const WebSocket = require("ws");

const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("OPENAI_API_KEY missing"); process.exit(1); }

const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });

ws.on("open", () => {
  console.log("OPEN");
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      turn_detection: { type: "server_vad", create_response: true },
      audio: { input: { format: { type: "audio/pcmu" } }, output: { format: { type: "audio/pcmu" } } },
      instructions: "Türkçe konuş. Sadece 'test tamam' de."
    }
  }));
  setTimeout(() => ws.close(), 1500);
});

ws.on("message", (m) => console.log("MSG", m.toString().slice(0, 300)));
ws.on("error", (e) => console.error("ERR", e.message));
ws.on("close", () => console.log("CLOSE"));
