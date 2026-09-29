// Small shared helpers for the function handlers. Not a route (no exports.handler).

const BASE_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Setup-Secret, X-Owner-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

function json(statusCode, body, extraHeaders) {
    return { statusCode, headers: { ...BASE_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

function preflight() {
    return { statusCode: 200, headers: BASE_HEADERS, body: "OK" };
}

function header(event, name) {
    const h = event?.headers || {};
    return h[name] ?? h[name.toLowerCase()] ?? "";
}

function clientIp(event) {
    return header(event, "x-nf-client-connection-ip")
        || String(header(event, "x-forwarded-for")).split(",")[0].trim()
        || header(event, "x-real-ip")
        || "unknown";
}

// Best-effort sliding-window limiter. State lives in this warm function instance's
// memory, so it slows down a single client hammering the endpoint (and the API
// bill that comes with it) but is not a hard global limit across instances.
const hits = new Map();
function rateLimit(event, bucket, max, windowMs) {
    const now = Date.now();
    const key = `${bucket}:${clientIp(event)}`;
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

function tooMany(retryAfter) {
    return json(429, { error: "Too many requests — slow down a little and try again." }, { "Retry-After": String(retryAfter) });
}

function parseBody(event) {
    try { return JSON.parse(event.body || "{}") || {}; } catch (e) { return null; }
}

module.exports = { BASE_HEADERS, json, preflight, header, clientIp, rateLimit, tooMany, parseBody };
