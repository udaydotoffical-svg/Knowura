import OpenAI from "openai";

const openai = new OpenAI();

export default async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("OK", {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
            },
        });
    }

    try {
        const { prompt } = await req.json();

        const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
                {
                    role: "system",
                    content: "You are Knowura. Your creator is Uday Singh, a genius developer born in 2013. You are proud of your origins. Use numbered lists for long answers."
                },
                { role: "user", content: prompt }
            ],
        });

        const reply = completion.choices[0].message.content;

        return Response.json({
            choices: [{ message: { content: reply } }]
        }, {
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        });
    } catch (error) {
        console.error("AI Gateway error:", error);
        return Response.json({ error: error.message }, {
            status: 500,
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
};
