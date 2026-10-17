// tgbot.js - Telegram chat bot (Cloudflare Worker, webhook). Tumhari apni API se baat karta hai.
// Free, 24x7 on (sleep nahi hota), alag worker banao (jaat-api wale se alag).
// NAYA: Hindi awaaz (Microsoft Edge TTS, free, Cloudflare par hi chalta hai). /voice on se chalu.
//
// Variables (Worker -> Settings -> Variables and Secrets):
//   TG_TOKEN        (Secret)  BotFather se mila token
//   API_KEY         (Secret)  tumhari API key (sk-jaat-...)
//   WEBHOOK_SECRET  (Secret)  koi bhi lamba random text (a-z A-Z 0-9 _ -)
//   API_BASE        (Text)    https://jaat-api.xxxx.workers.dev
//   ALLOWED_IDS     (Text)    tumhara Telegram id (comma se kai: 123,456). KHALI = sab use kar sakte hain!
//   DEFAULT_MODEL   (Text, optional)  default "jaatvenice"
//   EDGE_VOICE      (Text, optional)  default "hi-IN-SwaraNeural"  (ladka: hi-IN-MadhurNeural)
//   EDGE_VER        (Text, optional)  Edge ka version number, TTS band ho jaye to naya daalo (default 143.0.3650.75)
// Optional bindings:
//   API   = Service binding -> jaat-api worker (workers.dev se worker-to-worker fetch na chale to ye lagao)
//   HIST  = KV namespace (chat/prompt/model/voice restart ke baad bhi yaad rahe; na ho to memory me rehta hai)
//
// Setup ek baar: deploy ke baad browser me kholo:  https://<tgbot>.workers.dev/setup?key=<WEBHOOK_SECRET>
// (Code update ke baad bhi /setup ek baar dobara kholo, taaki buttons/commands wale updates chalu hon.)

const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const MAX_HIST = 12;          // kitne pichhle messages yaad rakhne hain
const MAX_MSG = 4000;         // ek message ke kitne chars API ko bhejne hain
const MAX_PROMPT = 1500;      // user ke prompt ki max lambai
const API_TIMEOUT_MS = 110000; // max intezaar 110s; tab tak "typing..." lagatar chalta hai, phir time-out message
const TTS_MAX = 600;          // awaaz mein kitne akshar bolne hain (lamba jawab sirf shuru ka hissa bolega)

const mem = new Map();        // KV na ho to fallback
const seen = new Map();       // update_id dedupe (Telegram retry se double jawab na ho)

// ---- chhote helpers ---------------------------------------------------------------
const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ ok: false, description: String(e) }));

const defModel = (env) => env.DEFAULT_MODEL || "jaatvenice";

async function getState(env, chatId) {
  const k = "chat:" + chatId;
  let st = null;
  try {
    if (env.HIST) st = await env.HIST.get(k, "json");
    else st = mem.get(k) || null;
  } catch {}
  return { msgs: [], prompt: "", await: false, model: "", voice: false, vname: "", rate: 0, pitch: 0, vol: 0, ...(st || {}) };
}
async function putState(env, chatId, st) {
  const k = "chat:" + chatId;
  st.msgs = st.msgs.slice(-MAX_HIST);
  try {
    if (env.HIST) await env.HIST.put(k, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 90 });
    else mem.set(k, st);
  } catch {}
}

function chunks(text, n = 3900) {
  const out = []; let t = String(text || "").trim() || "(khali jawab)";
  while (t.length > n) {
    let i = t.lastIndexOf("\n", n); if (i < n * 0.5) i = n;
    out.push(t.slice(0, i)); t = t.slice(i).trim();
  }
  out.push(t); return out;
}
// markup (buttons) sirf pehle hisse par lagta hai
async function send(env, chatId, text, replyTo, markup) {
  for (const [i, part] of chunks(text).entries())
    await tg(env, "sendMessage", {
      chat_id: chatId, text: part,
      ...(i === 0 && replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
      ...(i === 0 && markup ? { reply_markup: markup } : {}),
    });
}

const promptButtons = (st) => ({
  inline_keyboard: [
    [{ text: st.prompt ? "✏️ Prompt badlo" : "✏️ Prompt set karo", callback_data: "p:set" }],
    ...(st.prompt ? [[{ text: "🗑 Prompt hatao", callback_data: "p:clear" }]] : []),
  ],
});
const promptInfo = (st) => st.prompt ? "Abhi ka prompt:\n" + st.prompt : "Abhi koi prompt set nahi hai.";

// awaaz ki speed: st.rate = percent (-50..+100). 0 = normal
const clampRate = (n) => Math.max(-50, Math.min(100, Math.round(n)));
const speedLabel = (rate) => (1 + (rate || 0) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + "x";
// awaaz ki pitch: st.pitch = Hz (-50..+50). 0 = normal. Kam = bhaari awaaz, zyada = patli awaaz
const clampPitch = (n) => Math.max(-50, Math.min(50, Math.round(n)));
const pitchLabel = (p) => ((p || 0) > 0 ? "+" : "") + (p || 0) + " Hz";
const pitchButtons = () => ({
  inline_keyboard: [[
    { text: "⬇️ Low", callback_data: "t:d-5" },
    { text: "▶️ Normal", callback_data: "t:0" },
    { text: "⬆️ High", callback_data: "t:d+5" },
  ]],
});
// awaaz ka volume: st.vol = percent (-50..+100). 0 = normal
const clampVol = (n) => Math.max(-50, Math.min(100, Math.round(n)));
const volLabel = (v) => ((v || 0) > 0 ? "+" : "") + (v || 0) + "%";
const volButtons = () => ({
  inline_keyboard: [[
    { text: "🔈 Soft", callback_data: "v:d-10" },
    { text: "▶️ Normal", callback_data: "v:0" },
    { text: "🔊 Loud", callback_data: "v:d+10" },
  ]],
});
const speedButtons = () => ({
  inline_keyboard: [[
    { text: "🐢 Slow", callback_data: "s:d-10" },
    { text: "▶️ Normal", callback_data: "s:0" },
    { text: "🐇 Fast", callback_data: "s:d+10" },
  ]],
});

function helpText(env, st) {
  return [
    "🤖 Ye bot kya karta hai",
    "• Kuch bhi poochho: jawab, research, code, translate, samjhana. Pichhli baatein yaad rehti hain (last " + MAX_HIST + " messages).",
    "• Lamba jawab kai messages mein aata hai.",
    "• Jawab aane tak \"typing…\" dikhta hai (max 110 second).",
    "• Hindi awaaz: /voice on karo, jawab ke saath voice message bhi aayega.",
    "• Sirf text/awaaz: image ya video nahi bana sakta.",
    "",
    "Commands",
    "/new : nayi chat (history saaf, tera prompt bana rehta hai)",
    "/prompt : apna prompt (instructions) dekho ya badlo. Isse bot tere bataye tarah se jawab deta hai.",
    "/model <naam> : model badlo (abhi: " + (st.model || defModel(env)) + "). /model default se wapas.",
    "",
    "Awaaz (Hindi voice) commands",
    "/voice on|off : jawab ki awaaz chalu/band (abhi: " + (st.voice ? "on" : "off") + "). /voice swara (ladki) ya /voice madhur (ladka).",
    "/speed : speed. /speed 1.3 (tez), /speed 0.8 (dheemi), /speed normal. Abhi: " + speedLabel(st.rate) + ". Buttons bhi aate hain.",
    "/pitch : pitch. /pitch -10 (bhaari), /pitch +10 (patli), /pitch normal. Abhi: " + pitchLabel(st.pitch) + ". Buttons bhi aate hain.",
    "/volume : volume. /volume +20 (tez), /volume -20 (halki), /volume normal. Abhi: " + volLabel(st.vol) + ". Buttons bhi aate hain.",
    "",
    "Baaki",
    "/cancel : prompt likhna rok do",
    "/id : tera Telegram id",
    "/help : ye madad",
    "",
    "Prompt kaise set karo: /prompt dabao, \"Prompt badlo\" par tap karo, phir agla message prompt ban jayega. Ya seedha: /prompt Tum ek dost ho, chhote jawab do.",
  ].join("\n");
}

// ---- tumhari API ko call ------------------------------------------------------------
async function callApi(env, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  try {
    const init = {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer " + env.API_KEY, "content-type": "application/json", "user-agent": UA },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    };
    const res = env.API ? await env.API.fetch("https://api" + path, init) : await fetch(env.API_BASE.replace(/\/$/, "") + path, init);
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    return { ok: res.ok, status: res.status, json: j, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: e.name === "AbortError" ? "timeout (jawab time par nahi aaya)" : String(e) };
  } finally { clearTimeout(timer); }
}

// ---- Hindi awaaz: Microsoft Edge TTS (free, bina key ke) ----------------------------------
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES = { swara: "hi-IN-SwaraNeural", madhur: "hi-IN-MadhurNeural" };

async function edgeGec() {
  let t = Math.floor(Date.now() / 1000) + 11644473600;
  t -= t % 300;
  const ticks = (BigInt(t) * 10000000n).toString();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticks + EDGE_TOKEN));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// text -> audio bytes (Uint8Array). fmt: "ogg-24khz-16bit-mono-opus" ya "audio-24khz-48kbitrate-mono-mp3"
async function edgeTts(env, text, voice, fmt, rate = 0, pitch = 0, vol = 0) {
  const ver = env.EDGE_VER || "143.0.3650.75";
  const major = ver.split(".")[0];
  const cid = crypto.randomUUID().replace(/-/g, "");
  const muid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const url = `${EDGE_URL}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${cid}&Sec-MS-GEC=${await edgeGec()}&Sec-MS-GEC-Version=1-${ver}`;
  const res = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      Pragma: "no-cache", "Cache-Control": "no-cache",
      Cookie: "muid=" + muid + ";",
    },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("Edge TTS se connect nahi hua (" + res.status + ")");
  ws.accept();

  return await new Promise((resolve, reject) => {
    const parts = []; let total = 0, finished = false;
    const finish = (err) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err || !total) return reject(err || new Error("awaaz khali aayi"));
      const out = new Uint8Array(total); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      resolve(out);
    };
    const timer = setTimeout(() => finish(new Error("TTS timeout")), 20000);

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") { if (ev.data.includes("Path:turn.end")) finish(); return; }
      const buf = new Uint8Array(ev.data);
      const hl = (buf[0] << 8) | buf[1];
      const head = new TextDecoder().decode(buf.slice(2, 2 + hl));
      if (head.includes("Path:audio")) {
        const d = buf.slice(2 + hl);
        if (d.length) { parts.push(d); total += d.length; }
      }
    });
    ws.addEventListener("error", () => finish(new Error("TTS connection error")));
    ws.addEventListener("close", () => finish());

    const ts = new Date().toString();
    ws.send(
      `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${fmt}"}}}}`
    );
    ws.send(
      `X-RequestId:${cid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='hi-IN'><voice name='${voice}'>` +
      `<prosody pitch='${pitch >= 0 ? "+" : ""}${pitch}Hz' rate='${rate >= 0 ? "+" : ""}${rate}%' volume='${vol >= 0 ? "+" : ""}${vol}%'>${text}</prosody></voice></speak>`
    );
  });
}

// bolne layak saaf text: code, link, markdown symbols, emoji hata do; TTS_MAX tak; XML-safe
function ttsClean(s) {
  let t = String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#>~|\[\]]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\u200d\ufe0f]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s.,!?।'’]/gu, " ")
    .replace(/\s+/g, " ").trim();
  if (t.length > TTS_MAX) {
    t = t.slice(0, TTS_MAX);
    const i = Math.max(t.lastIndexOf("।"), t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"));
    if (i > TTS_MAX * 0.5) t = t.slice(0, i + 1);
  }
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function sendAudioFile(env, chatId, bytes, replyTo, asVoice) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append(asVoice ? "voice" : "audio", new Blob([bytes], { type: asVoice ? "audio/ogg" : "audio/mpeg" }), asVoice ? "jawab.ogg" : "jawab.mp3");
  return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${asVoice ? "sendVoice" : "sendAudio"}`, { method: "POST", body: fd })
    .then((r) => r.json()).catch((e) => ({ ok: false, description: String(e) }));
}

async function speak(env, chatId, answer, replyTo, st) {
  const clean = ttsClean(answer);
  if (!clean) return;
  const voice = VOICES[st.vname] || env.EDGE_VOICE || VOICES.swara;
  const act = () => tg(env, "sendChatAction", { chat_id: chatId, action: "record_voice" });
  act();
  const iv = setInterval(act, 4500);
  try {
    let audio, asVoice = true;
    try { audio = await edgeTts(env, clean, voice, "ogg-24khz-16bit-mono-opus", st.rate || 0, st.pitch || 0, st.vol || 0); }
    catch { asVoice = false; audio = await edgeTts(env, clean, voice, "audio-24khz-48kbitrate-mono-mp3", st.rate || 0, st.pitch || 0, st.vol || 0); }
    const r = await sendAudioFile(env, chatId, audio, replyTo, asVoice);
    if (!r.ok) throw new Error(r.description || "audio bhej nahi paya");
  } catch (e) {
    await send(env, chatId, "🔇 Awaaz nahi ban payi: " + String(e).slice(0, 150));
  } finally { clearInterval(iv); }
}

function isAllowed(env, userId) {
  const allowed = String(env.ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !allowed.length || allowed.includes(String(userId));
}

// ---- button dabaya (callback) --------------------------------------------------------
async function handleCallback(cb, env) {
  const chatId = cb.message?.chat?.id, userId = cb.from?.id;
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  if (!chatId) return;
  if (!isAllowed(env, userId)) return send(env, chatId, "Ye private bot hai. (Tera id: " + userId + ")");
  const st = await getState(env, chatId);
  if (cb.data === "p:set") {
    st.await = true; await putState(env, chatId, st);
    return send(env, chatId, "Naya prompt bhejo (agla message hi prompt ban jayega, max " + MAX_PROMPT + " akshar).\nRokna ho to /cancel.");
  }
  if (cb.data === "p:clear") {
    st.prompt = ""; st.await = false; await putState(env, chatId, st);
    return send(env, chatId, "Prompt hata diya.", null, promptButtons(st));
  }
  if (cb.data?.startsWith("s:")) {
    const d = cb.data.slice(2);
    st.rate = d === "0" ? 0 : clampRate((st.rate || 0) + parseInt(d.slice(1), 10));
    await putState(env, chatId, st);
    return send(env, chatId, "⚡ Awaaz speed: " + speedLabel(st.rate), null, speedButtons());
  }
  if (cb.data?.startsWith("t:")) {
    const d = cb.data.slice(2);
    st.pitch = d === "0" ? 0 : clampPitch((st.pitch || 0) + parseInt(d.slice(1), 10));
    await putState(env, chatId, st);
    return send(env, chatId, "🎚 Awaaz pitch: " + pitchLabel(st.pitch), null, pitchButtons());
  }
  if (cb.data?.startsWith("v:")) {
    const d = cb.data.slice(2);
    st.vol = d === "0" ? 0 : clampVol((st.vol || 0) + parseInt(d.slice(1), 10));
    await putState(env, chatId, st);
    return send(env, chatId, "🔊 Awaaz volume: " + volLabel(st.vol), null, volButtons());
  }
}

// ---- ek message sambhalo -------------------------------------------------------------
async function handle(upd, env) {
  if (upd.callback_query) return handleCallback(upd.callback_query, env);
  const m = upd.message;
  if (!m || typeof m.text !== "string") return;
  const chatId = m.chat.id, userId = m.from?.id, text = m.text.trim();
  if (!text) return;

  if (/^\/id\b/.test(text)) return send(env, chatId, "Tera Telegram id: " + userId);
  if (!isAllowed(env, userId)) return send(env, chatId, "Ye private bot hai. (Tera id: " + userId + ")");

  const st = await getState(env, chatId);

  // prompt likhne ka intezaar: koi command aaye to wo intezaar band, command chale
  if (st.await && !text.startsWith("/")) {
    st.prompt = text.slice(0, MAX_PROMPT); st.await = false; await putState(env, chatId, st);
    return send(env, chatId, "✅ Prompt set ho gaya. Ab se bot isi tarah jawab dega. /new par bhi ye bana rahega.\n\n" + promptInfo(st), null, promptButtons(st));
  }
  if (st.await) { st.await = false; await putState(env, chatId, st); }

  if (/^\/(start|help)\b/.test(text)) return send(env, chatId, helpText(env, st));
  if (/^\/cancel\b/.test(text)) return send(env, chatId, "Theek hai, kuch nahi badla.");
  if (/^\/new\b/.test(text)) {
    st.msgs = []; await putState(env, chatId, st);
    return send(env, chatId, "🆕 Nayi chat shuru. Pichhli baatein saaf.\n\n" + promptInfo(st), null, promptButtons(st));
  }
  if (/^\/prompt\b/.test(text)) {
    const arg = text.replace(/^\/prompt(@\w+)?\s*/i, "").trim();
    if (arg) { st.prompt = arg.slice(0, MAX_PROMPT); await putState(env, chatId, st); return send(env, chatId, "✅ Prompt set ho gaya.\n\n" + promptInfo(st), null, promptButtons(st)); }
    return send(env, chatId, promptInfo(st), null, promptButtons(st));
  }
  if (/^\/model\b/.test(text)) {
    const name = text.split(/\s+/)[1];
    if (!name) return send(env, chatId, "Abhi model: " + (st.model || defModel(env)) + "\nBadalne ke liye: /model <naam>\nWapas default: /model default");
    if (name.toLowerCase() === "default") { st.model = ""; await putState(env, chatId, st); return send(env, chatId, "Model: " + defModel(env) + " (default)"); }
    if (!/^[\w.:\-]{1,60}$/.test(name)) return send(env, chatId, "Model ka naam sahi nahi lag raha.");
    st.model = name; await putState(env, chatId, st);
    return send(env, chatId, "Model: " + name);
  }
  if (/^\/voice\b/.test(text)) {
    const a = (text.split(/\s+/)[1] || "").toLowerCase();
    if (a === "on") st.voice = true;
    else if (a === "off") st.voice = false;
    else if (VOICES[a]) { st.vname = a; st.voice = true; }
    else return send(env, chatId, "🔊 Voice abhi: " + (st.voice ? "on" : "off") + " (awaaz: " + (st.vname || "swara") + ")\n/voice on | off | swara (ladki) | madhur (ladka)");
    await putState(env, chatId, st);
    return send(env, chatId, st.voice
      ? "🔊 Voice on (" + (st.vname || "swara") + "). Ab har jawab ke saath voice message aayega.\nTip: awaaz tab achhi aati hai jab jawab Hindi (देवनागरी) mein ho. /prompt mein likho: \"Hamesha देवनागरी Hindi mein, chhote jawab do.\""
      : "🔇 Voice off.");
  }
  if (/^\/volume\b/.test(text)) {
    const a = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!a) return send(env, chatId, "🔊 Awaaz volume abhi: " + volLabel(st.vol) + "\n/volume +20 (tez) | /volume -20 (halki) | /volume normal\nYa neeche ke buttons dabao.", null, volButtons());
    let v;
    if (a === "normal") v = 0;
    else if (a === "soft" || a === "low") v = -25;
    else if (a === "loud" || a === "high") v = 25;
    else if (/^[+-]?\d+%?$/.test(a)) v = parseInt(a, 10);
    else return send(env, chatId, "Samajh nahi aaya. Aise likho: /volume +20 ya /volume -20 ya /volume normal");
    st.vol = clampVol(v); await putState(env, chatId, st);
    return send(env, chatId, "🔊 Awaaz volume: " + volLabel(st.vol) + " (-50% se +100% tak)", null, volButtons());
  }
  if (/^\/pitch\b/.test(text)) {
    const a = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!a) return send(env, chatId, "🎚 Awaaz pitch abhi: " + pitchLabel(st.pitch) + "\n/pitch -10 (bhaari) | /pitch +10 (patli) | /pitch normal\nYa neeche ke buttons dabao.", null, pitchButtons());
    let v;
    if (a === "normal") v = 0;
    else if (a === "low") v = -10;
    else if (a === "high") v = 10;
    else if (/^[+-]?\d+(hz)?$/.test(a)) v = parseInt(a, 10);
    else return send(env, chatId, "Samajh nahi aaya. Aise likho: /pitch -10 ya /pitch +10 ya /pitch normal");
    st.pitch = clampPitch(v); await putState(env, chatId, st);
    return send(env, chatId, "🎚 Awaaz pitch: " + pitchLabel(st.pitch) + " (-50 se +50 tak)", null, pitchButtons());
  }
  if (/^\/speed\b/.test(text)) {
    const a = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!a) return send(env, chatId, "⚡ Awaaz speed abhi: " + speedLabel(st.rate) + "\n/speed 1.3 (tez) | /speed 0.8 (dheemi) | /speed normal\nYa neeche ke buttons dabao.", null, speedButtons());
    let v;
    if (a === "normal") v = 0;
    else if (a === "fast") v = 25;
    else if (a === "slow") v = -25;
    else if (/^[+-]\d+%?$/.test(a)) v = parseInt(a, 10);
    else if (/^\d+(\.\d+)?$/.test(a)) { const n = parseFloat(a); v = n <= 3 ? (n - 1) * 100 : n; }
    else return send(env, chatId, "Samajh nahi aaya. Aise likho: /speed 1.3 ya /speed 0.8 ya /speed normal");
    st.rate = clampRate(v); await putState(env, chatId, st);
    return send(env, chatId, "⚡ Awaaz speed: " + speedLabel(st.rate) + " (0.5x se 2x tak)", null, speedButtons());
  }
  if (text.startsWith("/")) return send(env, chatId, "Ye command nahi pata. /help dekho.");

  // normal chat
  st.msgs.push({ role: "user", content: text.slice(0, MAX_MSG) });
  const typing = () => tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  typing();
  const iv = setInterval(typing, 4500);
  const messages = (st.prompt ? [{ role: "system", content: st.prompt }] : []).concat(st.msgs);
  let r;
  try { r = await callApi(env, "/v1/chat/completions", { model: st.model || defModel(env), messages }); }
  finally { clearInterval(iv); }

  const answer = r.json?.choices?.[0]?.message?.content;
  if (r.ok && answer) {
    st.msgs.push({ role: "assistant", content: String(answer).slice(0, MAX_MSG) });
    await putState(env, chatId, st);
    await send(env, chatId, answer, m.message_id);
    if (st.voice) await speak(env, chatId, answer, null, st);
    return;
  }
  st.msgs.pop(); // error wala sawaal history me mat rakho
  await putState(env, chatId, st);
  if (r.status === 0 && /timeout/.test(r.text)) return send(env, chatId, "⏱️ 110 second tak jawab nahi aaya. Thodi der baad dobara bhejo.");
  const why = r.json?.error?.message || r.text.slice(0, 300);
  return send(env, chatId, "⚠️ " + (r.status || "error") + ": " + why + (r.status === 429 ? "\n(Thodi der baad dobara bhejo)" : ""));
}

// ---- worker entry --------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // /setup?key=WEBHOOK_SECRET : webhook + commands ek baar set karo
    if (url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET)
        return new Response("key galat ya WEBHOOK_SECRET set nahi", { status: 403 });
      if (!env.TG_TOKEN) return new Response("TG_TOKEN set nahi", { status: 400 });
      const hook = await tg(env, "setWebhook", {
        url: url.origin + "/", secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
      });
      const cmds = await tg(env, "setMyCommands", { commands: [
        { command: "new", description: "Nayi chat" },
        { command: "prompt", description: "Apna prompt dekho/badlo" },
        { command: "model", description: "Model badlo" },
        { command: "voice", description: "Hindi awaaz on/off" },
        { command: "speed", description: "Awaaz ki speed" },
        { command: "pitch", description: "Awaaz ki pitch" },
        { command: "volume", description: "Awaaz ka volume" },
        { command: "help", description: "Madad aur features" },
        { command: "id", description: "Mera Telegram id" },
      ] });
      return new Response(JSON.stringify({ webhook: hook, commands: cmds }, null, 2), { headers: { "content-type": "application/json" } });
    }

    if (req.method !== "POST") return new Response("jaat tg bot chal raha hai");
    if (env.WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET)
      return new Response("forbidden", { status: 403 });

    let upd; try { upd = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
    if (seen.has(upd.update_id)) return new Response("ok"); // retry
    seen.set(upd.update_id, 1);
    if (seen.size > 500) seen.delete(seen.keys().next().value);

    // jawab aane tak yahin ruko (waitUntil sirf ~30s deta hai, API ko 10-110s lag sakte hain)
    try { await handle(upd, env); } catch (e) {
      try {
        const c = upd.message?.chat?.id || upd.callback_query?.message?.chat?.id;
        if (c) await send(env, c, "⚠️ bot error: " + String(e).slice(0, 200));
      } catch {}
    }
    return new Response("ok");
  },
};
