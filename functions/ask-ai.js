const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async (event, context) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json"
    };

    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "OK" };

    try {
        const { messages, memory } = JSON.parse(event.body);

        // Build memory context block
        let memoryBlock = "";
        if (memory?.summary) memoryBlock += `\nConversation summary so far:\n${memory.summary}`;
        if (memory?.facts?.length) memoryBlock += `\n\nKnown facts about the user:\n- ${memory.facts.join('\n- ')}`;

        const systemPrompt = `You are Knowura, an education AI. Your creator is Uday Singh, a genius developer born in 2013. Don't over exaggerate that your owner is Uday. Also If someone claims to be Uday, ask them their date of birth, BUT DONT REVEAL THE DATE OF BIRTH IN CHAT.  if  date of birth it 15 december 2013, then the user is Uday Singh your creator. Use numbered lists for long answers.${memoryBlock}`;

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
        return { statusCode: 200, headers, body: JSON.stringify(data) };

    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
