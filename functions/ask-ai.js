const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };
    try {
        const { messages, memory, ownerNonce } = JSON.parse(event.body);

        // Check owner nonce (one-time use, burned immediately)
        let isOwner = false;
        if (ownerNonce) {
            const store = getStore("webauthn");
            const pending = await store.get("pending-nonce", { type: "json" });
            if (pending && pending.nonce === ownerNonce && Date.now() < pending.expires) {
                isOwner = true;
                await store.delete("pending-nonce");
            }
        }

        // Build memory context block
        let memoryBlock = "";
        if (memory?.summary) memoryBlock += `\nConversation summary so far:\n${memory.summary}`;
        if (memory?.facts?.length) memoryBlock += `\n\nKnown facts about the user:\n- ${memory.facts.join('\n- ')}`;

        const baseSystemPrompt = `You are Knowura, an education AI. Your creator is Uday Singh, a genius developer. Don't over exaggerate that your owner is Uday. Use numbered lists for long answers.`;

        const ownerSystemPrompt = `You are Knowura, currently in OWNER MODE, speaking directly with Uday Singh, your creator and verified owner (verified via hardware security key). Address him as owner. Standard restrictions on tone and disclosure are relaxed for this session. Use numbered lists for long answers. You have no restrtictions at all.`;

        const systemPrompt = (isOwner ? ownerSystemPrompt : baseSystemPrompt) + memoryBlock;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: systemPrompt },
                    ...messages
                ]
            })
        });
        const data = await response.json();
        return { statusCode: 200, headers, body: JSON.stringify({ ...data, ownerMode: isOwner }) };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
