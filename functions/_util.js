// Shared helpers for the function handlers. Not a route (no exports.handler).
//
// Every handler starts with guard() (method + same-origin check) and reads its body with
// readJson() (size cap + strict JSON object), then validates each field it uses.

const BASE_HEADERS = {
    "Access-Control-Allow-Headers": "Content-Type, X-Setup-Secret, X-Owner-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
};

function json(statusCode, body, extraHeaders) {
    return { statusCode, headers: { ...BASE_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

function preflight() {
    return { statusCode: 204, headers: BASE_HEADERS, body: "" };
}

function header(event, name) {
    const h = event?.headers || {};
    return h[name] ?? h[name.toLowerCase()] ?? "";
}

// The caller's IP, read ONLY from the header the hosting platform itself sets — headers a client
// could send are ignored, otherwise anyone could invent a fresh "IP" per request and walk
// straight past every IP-based limit.
//   Vercel  -> x-vercel-forwarded-for (set by Vercel; x-forwarded-for is overwritten by it too)
//   Netlify -> x-nf-client-connection-ip (set by Netlify)
// Anywhere else (local dev / tests) fall back to x-forwarded-for.
function clientIp(event) {
    let ip = "";
    if (process.env.VERCEL) {
        ip = header(event, "x-vercel-forwarded-for") || header(event, "x-real-ip") || String(header(event, "x-forwarded-for")).split(",")[0];
    } else if (process.env.NETLIFY || process.env.NETLIFY_LOCAL) {
        ip = header(event, "x-nf-client-connection-ip");
    } else {
        ip = String(header(event, "x-forwarded-for")).split(",")[0] || header(event, "x-real-ip");
    }
    return String(ip || "unknown").trim().slice(0, 64);
}

// What limits are counted against. IPv6 users typically control a whole /64, so rotating
// addresses inside it must not mint new allowances — key on the /64 prefix instead.
function ipKey(event) {
    const ip = clientIp(event).toLowerCase();
    if (!ip.includes(":")) return ip;                       // IPv4 / unknown
    const v4 = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);        // ::ffff:1.2.3.4
    if (v4) return v4[1];
    const [head, tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
    const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

// ─── request guards ───────────────────────────────────────────────────────

// Browsers attach an Origin header to cross-site requests. By default only same-origin
// calls (Origin host == the site's own Host) are accepted; ALLOWED_ORIGINS (comma-separated
// origins) can add more. Requests with no Origin (curl, server-to-server) can't be told
// apart here — the rate limits and auth are what stop those.
function originAllowed(event) {
    const origin = header(event, "origin");
    if (!origin) return true;
    let host;
    try { host = new URL(origin).host; } catch (e) { return false; }
    if (host === header(event, "host")) return true;
    const extra = String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    return extra.includes(origin);
}

// Returns an early response (preflight / 405 / 403) or null to carry on.
function guard(event, methods = ["POST"]) {
    const m = event.httpMethod;
    if (m === "OPTIONS") return preflight();
    if (!methods.includes(m)) return json(405, { error: "Method not allowed" }, { Allow: [...methods, "OPTIONS"].join(", ") });
    if (!originAllowed(event)) return json(403, { error: "Origin not allowed" });
    return null;
}

function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Reads the request body as a JSON *object* within a byte budget.
// -> { body } on success, { error: <response> } otherwise (413 too large / 400 malformed).
function readJson(event, maxBytes = 64 * 1024, { allowEmpty = true } = {}) {
    const raw = event.body == null ? "" : (event.isBase64Encoded ? Buffer.from(String(event.body), "base64").toString("utf8") : String(event.body));
    const declared = Number(header(event, "content-length")) || 0;
    if (declared > maxBytes || Buffer.byteLength(raw, "utf8") > maxBytes) {
        return { error: json(413, { error: "Request too large" }) };
    }
    if (!raw.trim()) return allowEmpty ? { body: {} } : { error: json(400, { error: "Empty request body" }) };
    let body;
    try { body = JSON.parse(raw); } catch (e) { return { error: json(400, { error: "Malformed JSON" }) }; }
    if (!isPlainObject(body)) return { error: json(400, { error: "Expected a JSON object" }) };
    return { body };
}

// Kept for older call sites/tests: parsed body or null.
function parseBody(event) {
    const r = readJson(event, 1024 * 1024);
    return r.error ? null : r.body;
}

// ─── field sanitizers ─────────────────────────────────────────────────────

// A string within [min,max] chars with control characters removed, or null if it isn't one.
function cleanStr(v, max, min = 0) {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return s.length >= min && s.length <= max ? s : null;
}

// ─── in-memory limiter (fast path; per warm instance) ─────────────────────

const hits = new Map();
function rateLimit(event, bucket, max, windowMs, id) {
    const now = Date.now();
    const key = `${bucket}:${id || ipKey(event)}`;
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) { // keep the map from growing forever
        for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    }
    return 0;
}

function tooMany(retryAfter, message) {
    const mins = retryAfter >= 90 ? `${Math.ceil(retryAfter / 60)} minutes` : `${retryAfter} seconds`;
    return json(429, { error: message || `Too many requests — try again in ${mins}.` }, { "Retry-After": String(retryAfter) });
}

module.exports = {
    BASE_HEADERS, json, preflight, header, clientIp, ipKey, guard, originAllowed, isPlainObject,
    readJson, parseBody, cleanStr, rateLimit, tooMany
};
