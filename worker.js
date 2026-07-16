// brick-ai — Cloudflare Worker (personal account; NOT company infra)
// Proxies "photo -> build-program" through Claude, keeping the API key server-side.
// The browser never sees ANTHROPIC_API_KEY.
//
// Deploy: see README.md. Set the secret with:  wrangler secret put ANTHROPIC_API_KEY

// Restrict who may call this Worker. Set to your live site origin.
const ALLOW_ORIGIN = "https://tamleluya.github.io";

const MODEL = "claude-opus-4-8";   // best vision + spatial reasoning; swap to "claude-sonnet-5" to cut cost

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request);

    // ---- Community gallery (KV-backed, personal account) ----
    if (url.pathname.endsWith("/gallery")) return handleGallery(request, env, url);

    if (request.method !== "POST")   return withCors(json({ error: "POST only" }, 405), request);

    let body;
    try { body = await request.json(); }
    catch { return withCors(json({ error: "invalid JSON body" }, 400), request); }

    const { image, prompt, schema } = body;
    if (!prompt) return withCors(json({ error: "missing prompt" }, 400), request);
    if (!env.ANTHROPIC_API_KEY) return withCors(json({ error: "server missing ANTHROPIC_API_KEY" }, 500), request);

    // Build the message content: image (if any) + the instruction prompt.
    const content = [];
    if (image) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(image);
      if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else   return withCors(json({ error: "image must be a base64 data URL" }, 400), request);
    }
    content.push({ type: "text", text: prompt });

    const apiReq = {
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content }],
    };
    // Structured output — forces valid build-program JSON.
    if (schema) apiReq.output_config.format = { type: "json_schema", schema };

    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(apiReq),
      });
    } catch (e) {
      return withCors(json({ error: "upstream fetch failed", detail: String(e) }, 502), request);
    }

    if (!r.ok) {
      const t = await r.text();
      return withCors(json({ error: "anthropic " + r.status, detail: t.slice(0, 400) }, 502), request);
    }

    const j = await r.json();
    if (j.stop_reason === "refusal") return withCors(json({ error: "model refused" }, 502), request);
    const textBlock = (j.content || []).find((b) => b.type === "text");
    if (!textBlock) return withCors(json({ error: "no text block in response" }, 502), request);

    let program;
    try { program = JSON.parse(textBlock.text); }
    catch { return withCors(json({ error: "model returned non-JSON", raw: textBlock.text.slice(0, 400) }, 502), request); }

    return withCors(json({ program }), request);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
}
function withCors(res, request) {
  const origin = request.headers.get("Origin");
  // Allow the configured site (and localhost/file for dev testing).
  const ok = origin === ALLOW_ORIGIN || origin === "null" || /^https?:\/\/localhost(:\d+)?$/.test(origin || "");
  res.headers.set("Access-Control-Allow-Origin", ok ? (origin || ALLOW_ORIGIN) : ALLOW_ORIGIN);
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Vary", "Origin");
  return res;
}

// ---- Public models gallery, backed by a KV namespace bound as GALLERY ----
// GET  /gallery            -> { models: [ {id,name,author,ts,thumb} ...newest 120 ] }
// GET  /gallery?model=<id> -> { parts: [...] }
// POST /gallery { name, author, parts, thumb } -> { ok, id }
async function handleGallery(request, env, url) {
  if (!env.GALLERY) return withCors(json({ error: "gallery KV not bound (create a KV namespace 'GALLERY')" }, 500), request);

  if (request.method === "GET") {
    const id = url.searchParams.get("model");
    if (id) {
      const raw = await env.GALLERY.get("m:" + id);
      if (!raw) return withCors(json({ error: "not found" }, 404), request);
      return withCors(json({ parts: JSON.parse(raw).parts }), request);
    }
    const idx = JSON.parse((await env.GALLERY.get("idx")) || "[]");
    return withCors(json({ models: idx }), request);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return withCors(json({ error: "invalid JSON" }, 400), request); }

    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3000)
      return withCors(json({ error: "parts must be an array of 1..3000" }, 400), request);

    const name = String(body.name || "דגם").slice(0, 60);
    const author = String(body.author || "אנונימי").slice(0, 40);
    let thumb = typeof body.thumb === "string" ? body.thumb : "";
    if (thumb.length > 60000) thumb = "";   // ~45KB cap; drop oversized thumbnails

    // Sanitize each part to the known shape (defends the shared store).
    const clean = parts.slice(0, 3000).map((p) => {
      const o = {
        type: String(p.type != null ? p.type : (p.t != null ? p.t : "")).slice(0, 24),
        x: (p.x | 0), z: (p.z | 0), l: (p.l | 0),
      };
      const col = typeof p.color === "string" ? p.color : (typeof p.c === "string" ? p.c : null);
      if (col) o.color = col.slice(0, 12);
      if (Array.isArray(p.q) && p.q.length === 4) o.q = p.q.map(Number);
      return o;
    }).filter((p) => p.type);

    const id = crypto.randomUUID().slice(0, 12);
    const ts = Date.now();
    await env.GALLERY.put("m:" + id, JSON.stringify({ parts: clean }));

    let idx = JSON.parse((await env.GALLERY.get("idx")) || "[]");
    idx.unshift({ id, name, author, ts, thumb });
    const dropped = idx.slice(120);
    idx = idx.slice(0, 120);
    for (const d of dropped) { try { await env.GALLERY.delete("m:" + d.id); } catch {} }
    await env.GALLERY.put("idx", JSON.stringify(idx));

    return withCors(json({ ok: true, id }), request);
  }

  return withCors(json({ error: "method not allowed" }, 405), request);
}
