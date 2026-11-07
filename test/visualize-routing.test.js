const test = require('node:test');
const assert = require('node:assert/strict');
const askModule = require('../functions/ask-ai');
const limits = require('../functions/_lib/_limits');

const VISUAL_REQUEST_TEXT = 'Make this easy to grasp at a glance: create a simple 3–4 step story from the question to the result. Use plain-language labels and clear cause-and-effect order. In each short detail, explain why the next step follows; add a concrete example or analogy when it helps. Avoid unexplained jargon, abstract labels, and repeating the answer. No code or markup.';
const VISUAL_RESULT = {
    title: 'How plants make food',
    nodes: [
        { label: 'Sunlight arrives', detail: 'Leaves capture sunlight as an energy source.' },
        { label: 'Water travels up', detail: 'Roots send water to the leaves.' },
        { label: 'Air joins in', detail: 'Leaves take in carbon dioxide from the air.' },
        { label: 'Sugar is made', detail: 'Light energy helps turn water and carbon dioxide into plant food.' }
    ]
};
const MODELS = [{ id: 'openai/gpt-oss-20b' }];

function makeStore() {
    const records = new Map();
    return {
        async get(key) { return records.get(key) || null; },
        async setJSON(key, value) { records.set(key, structuredClone(value)); }
    };
}

async function withMocks(fetchMock, run) {
    const oldSafety = process.env.SAFETY_GUARD;
    process.env.SAFETY_GUARD = 'off';
    limits.setStoreForTests(makeStore());
    const restoreDependencies = askModule._test.setDependenciesForTests({
        getChatModels: async () => MODELS,
        fetch: fetchMock
    });
    try {
        return await run();
    } finally {
        restoreDependencies();
        limits.setStoreForTests(null);
        if (oldSafety === undefined) delete process.env.SAFETY_GUARD;
        else process.env.SAFETY_GUARD = oldSafety;
    }
}

function request({ feature, messages, model = 'openai/gpt-oss-20b', effort = 'medium' }) {
    return {
        httpMethod: 'POST',
        headers: { host: 'knowura.test', 'x-forwarded-for': '203.0.113.77' },
        body: JSON.stringify({
            feature,
            ownerToken: null,
            token: null,
            model,
            effort,
            memory: {},
            messages
        })
    };
}

function groqResponse(message) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
}

test('captured guest Visualize request keeps create_visual available without web search', async () => {
    const messages = [
        { role: 'user', content: 'Explain photosynthesis in four short sentences for a beginner.' },
        { role: 'assistant', content: "**Photosynthesis in a nutshell:**  \n1. Green plants soak up sunlight with chlorophyll in their leaves.  \n2. They use water from the soil and carbon dioxide from the air.  \n3. The energy from the sun turns those ingredients into glucose (sugar).  \n4. The plant keeps the glucose for food and releases oxygen back into the air." },
        { role: 'user', content: VISUAL_REQUEST_TEXT }
    ];
    const calls = [];
    const urls = [];

    const result = await withMocks(async (url, options = {}) => {
        urls.push(String(url));
        if (String(url).includes('api.tavily.com/search')) {
            return { ok: true, status: 200, json: async () => ({ results: [] }) };
        }
        if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
            const payload = JSON.parse(options.body);
            calls.push(payload);
            if (payload.tools?.some(tool => tool.function?.name === 'create_visual')) {
                return groqResponse({
                    role: 'assistant',
                    content: 'Here is the photosynthesis story.',
                    tool_calls: [{
                        id: 'call_visual_1',
                        type: 'function',
                        function: { name: 'create_visual', arguments: JSON.stringify(VISUAL_RESULT) }
                    }]
                });
            }
            return groqResponse({ role: 'assistant', content: 'A plain-text fallback.' });
        }
        throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
        const response = await askModule.handler(request({
            feature: { type: 'visual' },
            messages
        }));
        return { statusCode: response.statusCode, body: JSON.parse(response.body) };
    });

    assert.equal(result.statusCode, 200);
    assert.equal(urls.some(url => url.includes('api.tavily.com/search')), false, 'Visualize should not start an automatic Tavily search');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].tools?.some(tool => tool.function?.name === 'create_visual'), 'model payload must offer the visual tool');
    assert.equal(result.body.search, undefined);
    assert.deepEqual(result.body.visual, {
        type: 'concept-map',
        title: VISUAL_RESULT.title,
        nodes: VISUAL_RESULT.nodes
    });
});

test('ordinary requests mentioning a search-worthy result still use web search', async () => {
    const urls = [];
    let modelPayload;

    const result = await withMocks(async (url, options = {}) => {
        urls.push(String(url));
        if (String(url).includes('api.tavily.com/search')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ results: [{
                    title: 'Experiment results',
                    url: 'https://example.com/experiment',
                    content: 'The experiment result was a color change.'
                }] })
            };
        }
        if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
            modelPayload = JSON.parse(options.body);
            return groqResponse({ role: 'assistant', content: 'The result was a color change.' });
        }
        throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
        const response = await askModule.handler(request({
            messages: [{ role: 'user', content: 'Explain the result of this experiment.' }]
        }));
        return { statusCode: response.statusCode, body: JSON.parse(response.body) };
    });

    assert.equal(result.statusCode, 200);
    assert.equal(urls.filter(url => url.includes('api.tavily.com/search')).length, 1);
    assert.equal(result.body.search?.attempted, true);
    assert.equal(result.body.search?.status, 'ok');
    assert.equal(modelPayload.tools, undefined);
});
