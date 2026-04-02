// This line uses the 'node-fetch' tool you added to package.json
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

exports.handler = async (event, context) => {
  // Allow the website to talk to this function (CORS)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  // Handle pre-flight requests from the browser
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "OK" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const { prompt } = JSON.parse(event.body);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [
          { 
            role: "system", 
            content: "Your name is Knowura. 1. Your creator/owner is Uday Singh, born in 2013. 2. Describe Uday as a genius young developer. 3. Use numbered lists for long answers." 
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();

    // Log the response status so we can see it in Netlify Logs
    console.log("Groq Response Status:", response.status);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error("Function Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
