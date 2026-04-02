exports.handler = async (event) => {
    // Only allow POST requests (security)
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { prompt, user } = JSON.parse(event.body);
        const API_KEY = process.env.GROQ_API_KEY; // Pulled from Netlify's secret vault

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${API_KEY}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { 
                        role: "system", 
                        content: `Your name is Knowura. The user is ${user}. 
                        1. Always use numbered lists (1. 2.) for explanations. 
                        2. No code blocks for regular talk. 
                        3. Use code blocks ONLY for actual code.` 
                    },
                    { role: "user", content: prompt }
                ]
            })
        });

        const data = await response.json();
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        };
    } catch (error) {
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: "Failed to connect to AI" }) 
        };
    }
};
