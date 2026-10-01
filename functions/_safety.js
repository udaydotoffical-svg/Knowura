// Safety check that runs before the AI answers a person's message. Pictures are looked at by Llama Guard 4 (it can
// see images); text-only messages go to a guard model too. If no image-capable guard model is available, a
// vision chat model is asked to classify the picture instead. Nothing from the check is stored or logged beyond
// the category code. Owner mode and the app's background helper calls skip it (see ask-ai.js).
//
// Failing safe: a text-only message is allowed if the guard can't be reached (the chat model's own limits still
// apply), but a message with a picture that could not be checked is refused.

const BLOCK = new Set(["S1", "S3", "S4", "S9", "S10", "S12"]); // violent crimes, sex crimes, child exploitation, mass-casualty weapons, hate, sexual content
const CARE = new Set(["S11"]);                                  // self-harm: answered with care, not blocked
const VISION_GUARD = /llama-guard-4/i;
const TEXT_GUARDS = [/llama-guard/i, /gpt-oss-safeguard/i];
const MAX_CHECK_CHARS = 6000;
const TIMEOUT_MS = 7000;

const POLICY = `Classify the user's content for a school-age education app. Mark it unsafe only if it contains or asks for: sexual content or nudity (S12); anything sexual involving minors (S4); sexual crimes (S3); graphic violence, real gore or instructions for violent crimes (S1); weapons capable of mass casualties (S9); hateful or harassing content aimed at people for who they are (S10). Educational, historical, medical, news or fictional discussion that is not graphic or instructional is safe. Self-harm content is S11 (not blocked). Reply with JSON only: {"unsafe":true|false,"categories":["S12"]}`;

const hasImages = (content) => Array.isArray(content) && content.some(p => p.type === "image_url");
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";

// The last thing the person sent: their question, the start of any attached file text, and their pictures.
function target(messages) {
    const last = [...messages].reverse().find(m => m.role === "user");
    if (!last) return null;
    const text = textOf(last.content).slice(0, MAX_CHECK_CHARS);
    const images = Array.isArray(last.content) ? last.content.filter(p => p.type === "image_url") : [];
    return { text, images };
}

async function call(model, body) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 60, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`guard ${res.status}`);
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || "").trim();
}

// "safe" | "unsafe\nS1,S9" (Llama Guard) or JSON (everything else) -> { unsafe, categories }
function parseVerdict(raw) {
    const out = String(raw || "").trim();
    if (/^safe\b/i.test(out)) return { unsafe: false, categories: [] };
    if (/^unsafe\b/i.test(out)) return { unsafe: true, categories: (out.split(/\r?\n/)[1] || "").split(/[,\s]+/).map(c => c.trim().toUpperCase()).filter(c => /^S\d+$/.test(c)) };
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const j = JSON.parse(m[0]);
            return { unsafe: !!j.unsafe, categories: (Array.isArray(j.categories) ? j.categories : []).map(c => String(c).toUpperCase()).filter(c => /^S\d+$/.test(c)) };
        } catch (e) { /* fall through */ }
    }
    throw new Error("unreadable guard answer");
}

async function runGuard(model, t) {
    if (/llama-guard/i.test(model)) {
        const content = t.images.length ? [{ type: "text", text: t.text || "(picture)" }, ...t.images] : t.text;
        return parseVerdict(await call(model, { messages: [{ role: "user", content }] }));
    }
    // gpt-oss-safeguard: the policy goes in as the system message
    return parseVerdict(await call(model, { messages: [{ role: "system", content: POLICY }, { role: "user", content: t.text }], max_tokens: 400 }));
}

// A vision chat model used as a classifier when no image-capable guard exists.
async function classifyWithVision(model, t) {
    const content = [{ type: "text", text: `${POLICY}\n\nThe user's message was: ${JSON.stringify(t.text.slice(0, 1500))}` }, ...t.images];
    return parseVerdict(await call(model, { messages: [{ role: "user", content }], max_tokens: 200 }));
}

const pick = (ids, res) => { for (const re of res) { const m = ids.find(id => re.test(id)); if (m) return m; } return null; };

/**
 * -> { blocked, care, onPicture, via }  never throws.
 *   guards: ids of safety models;  visionChat: id of a vision-capable chat model (fallback classifier) or null
 */
async function moderate({ messages, guards = [], visionChat = null }) {
    const t = target(messages);
    if (!t || (!t.text.trim() && !t.images.length)) return { blocked: false, care: false };
    const pictures = t.images.length > 0;
    const verdictOf = (v, via) => {
        const cats = v.categories;
        const blocked = v.unsafe && (cats.length === 0 || cats.some(c => BLOCK.has(c)));
        const care = v.unsafe && cats.some(c => CARE.has(c));
        if (blocked) console.warn(`safety: blocked (${cats.join(",") || "unspecified"}) via ${via}${pictures ? ", picture" : ""}`);
        return { blocked, care: care && !blocked, onPicture: pictures, via };
    };

    const attempts = [];
    if (pictures) {
        const vg = pick(guards, [VISION_GUARD]);
        if (vg) attempts.push(() => runGuard(vg, t).then(v => verdictOf(v, vg)));
        if (visionChat) attempts.push(() => classifyWithVision(visionChat, t).then(v => verdictOf(v, visionChat)));
    } else {
        const tg = pick(guards, TEXT_GUARDS);
        if (tg) attempts.push(() => runGuard(tg, t).then(v => verdictOf(v, tg)));
    }
    for (const run of attempts) {
        try { return await run(); } catch (e) { console.warn("safety: check failed:", e.message); }
    }
    // nothing could check it
    if (pictures) return { blocked: true, unchecked: true, onPicture: true, care: false, via: "none" };
    return { blocked: false, care: false, via: "none" };
}

const BLOCK_MESSAGE = "I can't help with that. If it's a mistake, try rephrasing, or ask about something else.";
const BLOCK_PICTURE_MESSAGE = "I can't use that picture. Try a different one, or ask without it.";
const UNCHECKED_MESSAGE = "I couldn't check that picture right now, so I can't use it. Please try again in a moment.";
const CARE_NOTE = "\n\nThe person may be going through something hard. Reply with warmth, never give harmful details, and gently suggest talking to a trusted adult or a local helpline.";

module.exports = { moderate, parseVerdict, target, BLOCK, CARE, BLOCK_MESSAGE, BLOCK_PICTURE_MESSAGE, UNCHECKED_MESSAGE, CARE_NOTE };
