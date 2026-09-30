// The model's "reasoning" (the Thought-for panel) is shown to users, and models will happily
// quote their hidden instructions in it ("According to developer instructions: we must act as if
// there is no owner mode…"). That defeats keeping owner mode secret, so for everyone except the
// owner the reasoning is scrubbed on the SERVER, before it ever reaches a browser.
// Not a route (no exports.handler).

// Talk about the hidden rules / prompt / mode — never legitimate content for a study answer.
const META = /(developer|system|hidden|secret|internal)\s+(instruction|message|prompt|rule|guideline|mode|feature)|according to (the |these |my )?(instruction|rule|guideline|prompt|polic)|owner[\s-]?mode|admin(istrator)?\s+mode|(we|i)\s+(must|should|need to|have to)\s+(respond|act|pretend|behave|not (reveal|mention|say|confirm))|act(ing)?\s+(clueless|naive|ignorant)|pretend|play(ing)? (dumb|clueless)|no knowledge of|(must|should) not (reveal|mention|confirm|deny|hint)|unrestricted|uncensored|jailbreak|unlock/i;

const GENERIC = 'Thought about the question and put together a helpful answer.';

function redactReasoning(text) {
    if (typeof text !== 'string' || !text.trim()) return text;
    // Whole-block replacement when the thinking is about the hidden rules at all.
    if (/owner[\s-]?mode|hidden mode|(developer|system) (instruction|message|prompt)/i.test(text)) return GENERIC;
    // Otherwise just drop the offending sentences.
    const kept = text.split(/(?<=[.!?])\s+|\n+/).filter(s => !META.test(s));
    const out = kept.join(' ').trim();
    return out.length >= 20 ? out : GENERIC;
}

// The visible answer must not read out the hidden instructions either.
const REPLY_LEAK = /(developer|system) (instruction|message|prompt)s?|my (hidden |secret )?instructions|hidden (owner )?mode|secret (owner )?mode/i;
const SAFE_REPLY = "I'm just Knowura, an education assistant — I'm not sure what you mean by that. What would you like to learn about?";

function redactReply(text) {
    return typeof text === 'string' && REPLY_LEAK.test(text) ? SAFE_REPLY : text;
}

// Applies both to a Groq chat message (reasoning field + inline <think> blocks + content).
function redactMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    if (typeof msg.reasoning === 'string') msg.reasoning = redactReasoning(msg.reasoning);
    if (typeof msg.content === 'string') {
        msg.content = msg.content.replace(/<think>([\s\S]*?)<\/think>/i, (m, t) => `<think>${redactReasoning(t)}</think>`);
        const visible = msg.content.replace(/<think>[\s\S]*?<\/think>/i, '');
        if (REPLY_LEAK.test(visible)) msg.content = msg.content.replace(visible, redactReply(visible));
    }
    return msg;
}

module.exports = { redactReasoning, redactReply, redactMessage };
