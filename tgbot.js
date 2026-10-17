// tgbot.js - Telegram chat bot (Cloudflare Worker, webhook). Tumhari apni API se baat karta hai.
// Free, 24x7 on (sleep nahi hota), alag worker banao (jaat-api wale se alag).
//
// Variables (Worker -> Settings -> Variables and Secrets):
//   TG_TOKEN        (Secret)  BotFather se mila token
//   API_KEY         (Secret)  tumhari API key (sk-jaat-...)
//   WEBHOOK_SECRET  (Secret)  koi bhi lamba random text (a-z A-Z 0-9 _ -)
//   API_BASE        (Text)    https://jaat-api.xxxx.workers.dev
//   ALLOWED_IDS     (Text)    tumhara Telegram id (comma se kai: 123,456). KHALI = sab use kar sakte hain!
//   DEFAULT_MODEL   (Text, optional)  default "jaatvenice"
// Optional bindings:
//   API   = Service binding -> jaat-api worker (workers.dev se worker-to-worker fetch na chale to ye lagao)
//   HIST  = KV namespace (chat/prompt/model restart ke baad bhi yaad rahe; na ho to memory me rehta hai)
//
// Setup ek baar: deploy ke baad browser me kholo:  https://<tgbot>.workers.dev/setup?key=<WEBHOOK_SECRET>
// (Code update ke baad bhi /setup ek baar dobara kholo, taaki buttons wale updates chalu hon.)

const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
const MAX_HIST = 12;          // kitne pichhle messages yaad rakhne hain
const MAX_MSG = 4000;         // ek message ke kitne chars API ko bhejne hain
const MAX_PROMPT = 1500;      // user ke prompt ki max lambai
const API_TIMEOUT_MS = 110000; // max intezaar 110s; tab tak "typing..." lagatar chalta hai, phir time-out message

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
  return { msgs: [], prompt: "", await: false, model: "", ...(st || {}) };
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

function helpText(env, st) {
  return [
    "🤖 Ye bot kya karta hai",
    "• Kuch bhi poochho: jawab, research, code, translate, samjhana. Pichhli baatein yaad rehti hain (last " + MAX_HIST + " messages).",
    "• Lamba jawab kai messages mein aata hai.",
    "• Jawab aane tak \"typing…\" dikhta hai (max 110 second).",
    "• Sirf text: image ya video nahi bana sakta.",
    "",
    "Commands",
    "/new : nayi chat (history saaf, tera prompt bana rehta hai)",
    "/prompt : apna prompt (instructions) dekho ya badlo. Isse bot tere bataye tarah se jawab deta hai.",
    "/model <naam> : model badlo (abhi: " + (st.model || defModel(env)) + "). /model default se wapas.",
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
    return send(env, chatId, answer, m.message_id);
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
