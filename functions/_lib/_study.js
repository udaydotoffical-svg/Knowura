// Structured study tools returned by the chat model. All tool arguments are treated as
// untrusted model output and are validated/clamped before they reach a client renderer.
const STUDY_TOOLS = [
    {
        type: "function",
        function: {
            name: "create_quiz",
            description: "Create an interactive multiple-choice quiz that pops up for the user. Use it when the user asks for a quiz, test, or practice questions. Make 5-10 questions unless they ask for a number.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short quiz title, e.g. 'Photosynthesis basics'" },
                    questions: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                question: { type: "string" },
                                options: { type: "array", items: { type: "string" }, description: "3-4 answer choices, without letter prefixes" },
                                answer_index: { type: "integer", description: "0-based index of the correct option" },
                                explanation: { type: "string", description: "One or two sentences on why the answer is right" }
                            },
                            required: ["question", "options", "answer_index", "explanation"]
                        }
                    }
                },
                required: ["title", "questions"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_flashcards",
            description: "Create a set of flip-style flashcards that pops up for the user. Use it when the user asks for flashcards or study cards. Make 8-15 cards unless they ask for a number.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short deck title" },
                    cards: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                front: { type: "string", description: "Term or question (short)" },
                                back: { type: "string", description: "Definition or answer (concise)" }
                            },
                            required: ["front", "back"]
                        }
                    }
                },
                required: ["title", "cards"]
            }
        }
    }
];

const TEACHBACK_PROMPT_TOOLS = [{
    type: "function",
    function: {
        name: "create_teachback_question",
        description: "Create one short open-ended teach-back question about the concept just explained. Do not reveal the answer.",
        parameters: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"]
        }
    }
}];

const TEACHBACK_ASSESS_TOOLS = [{
    type: "function",
    function: {
        name: "assess_teachback",
        description: "Assess the student's latest teach-back response against the earlier explanation. Be specific, kind, and honest; list only genuine gaps as weak spots.",
        parameters: {
            type: "object",
            properties: {
                feedback: { type: "string" },
                strengths: { type: "array", items: { type: "string" } },
                weak_spots: { type: "array", items: { type: "string" } },
                next_step: { type: "string" }
            },
            required: ["feedback", "strengths", "weak_spots", "next_step"]
        }
    }
}];

// Data-only concept-map contract: the client renders nodes with its own accessible UI. Never accept
// HTML, SVG, script, or model-provided rendering code.
const VISUAL_TOOLS = [{
    type: "function",
    function: {
        name: "create_visual",
        description: "Turn the current explanation into a student-friendly visual story with 3 or 4 ordered steps, from the question to its result. Use concrete, familiar labels (2-5 words) and one short plain-language detail per step; add a memorable analogy or example when it genuinely helps. Avoid unexplained jargon and abstract labels.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string" },
                nodes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            detail: { type: "string" }
                        },
                        required: ["label", "detail"]
                    }
                }
            },
            required: ["title", "nodes"]
        }
    }
}];

// Tools are only offered when the conversation is actually about quizzes/flashcards, so
// ordinary chat never risks a stray study tool call (and the request stays cheap).
const STUDY_RE = /\b(quiz(zes)?|flash ?cards?|study cards?|revision cards?|test me|drill me|practice (questions|problems|test)|mcq|multiple[- ]choice)\b/i;
function wantsStudyTools(messages) {
    const text = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map(p => p?.text || "").join(" ") : "";
    return (messages || []).slice(-4).some(m => STUDY_RE.test(text(m.content).split(/\n\n\[Attached /)[0]));
}

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function parseArgs(rawArgs) {
    try { return typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs; } catch (e) { return null; }
}
function cleanList(values, maxItems, maxChars) {
    return Array.isArray(values) ? values.slice(0, maxItems).map(v => clip(v, maxChars)).filter(Boolean) : [];
}

// Turns a tool call into a safe, size-capped study payload, or null.
function sanitizeStudy(name, rawArgs) {
    const args = parseArgs(rawArgs);
    if (!args || typeof args !== "object") return null;

    if (name === "create_quiz" && Array.isArray(args.questions)) {
        const questions = [];
        for (const q of args.questions.slice(0, 15)) {
            const options = Array.isArray(q?.options) ? q.options.map(o => clip(o, 160)).filter(Boolean).slice(0, 5) : [];
            const answer = Number(q?.answer_index);
            const question = clip(q?.question, 400);
            if (!question || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
            questions.push({ question, options, answer, explanation: clip(q?.explanation, 400) });
        }
        if (questions.length < 1) return null;
        return { type: "quiz", title: clip(args.title, 80) || "Quick quiz", questions };
    }

    if (name === "create_flashcards" && Array.isArray(args.cards)) {
        const cards = [];
        for (const c of args.cards.slice(0, 30)) {
            const front = clip(c?.front, 200), back = clip(c?.back, 400);
            if (front && back) cards.push({ front, back });
        }
        if (cards.length < 1) return null;
        return { type: "flashcards", title: clip(args.title, 80) || "Flashcards", cards };
    }
    return null;
}

function sanitizeTeachback(name, rawArgs) {
    const args = parseArgs(rawArgs);
    if (!args || typeof args !== "object") return null;
    if (name === "create_teachback_question") {
        const question = clip(args.question, 500);
        return question ? { type: "question", question } : null;
    }
    if (name === "assess_teachback") {
        const feedback = clip(args.feedback, 600);
        const strengths = cleanList(args.strengths, 5, 200);
        const weakSpots = cleanList(args.weak_spots, 5, 200);
        const nextStep = clip(args.next_step, 300);
        if (!feedback || (!strengths.length && !weakSpots.length && !nextStep)) return null;
        return { type: "assessment", feedback, strengths, weakSpots, nextStep };
    }
    return null;
}

function sanitizeTeachbackPayload(value) {
    if (!value || typeof value !== "object") return null;
    if (value.type === "question") return sanitizeTeachback("create_teachback_question", value);
    if (value.type === "assessment") {
        const assessment = sanitizeTeachback("assess_teachback", {
            feedback: value.feedback, strengths: value.strengths, weak_spots: value.weakSpots, next_step: value.nextStep
        });
        if (!assessment) return null;
        const question = clip(value.question, 500);
        const response = clip(value.response, 1200);
        if (question) assessment.question = question;
        if (response) assessment.response = response;
        return assessment;
    }
    return null;
}

function sanitizeVisual(name, rawArgs) {
    const args = parseArgs(rawArgs);
    if (!args || typeof args !== "object" || name !== "create_visual" || !Array.isArray(args.nodes)) return null;
    const nodes = args.nodes.slice(0, 5).map(node => ({
        label: clip(node?.label, 70), detail: clip(node?.detail, 200)
    })).filter(node => node.label && node.detail);
    if (nodes.length < 2) return null;
    return { type: "concept-map", title: clip(args.title, 100) || "Explore the idea", nodes };
}

function sanitizeVisualPayload(value) {
    if (!value || typeof value !== "object") return null;
    if (value.type === "concept-map") return sanitizeVisual("create_visual", { title: value.title, nodes: value.nodes });
    return null;
}

function studyBlurb(study) {
    return study.type === "quiz"
        ? `Here's your quiz on **${study.title}** — ${study.questions.length} question${study.questions.length === 1 ? "" : "s"}. Good luck!`
        : `Here's your **${study.title}** flashcard deck — ${study.cards.length} card${study.cards.length === 1 ? "" : "s"}. Flip through them and mark what you know.`;
}
function teachbackBlurb(payload) {
    return payload.type === "question" ? "Try explaining this idea in your own words." : payload.feedback;
}
function visualBlurb(payload) { return `Here's an interactive concept map: **${payload.title}**.`; }

const STUDY_PROMPT = ` When asked, you can build a quiz (create_quiz) or flashcards (create_flashcards) that pop up for the user; get the topic first if it's missing, then reply with one short friendly line.`;
const TEACHBACK_PROMPT = ` This is a one-tap teach-back prompt: ask exactly one short open-ended question about the topic just explained, do not reveal the answer, and call create_teachback_question. Keep the visible reply brief.`;
const TEACHBACK_ASSESS_PROMPT = ` Assess the student's latest response against the relevant explanation in the conversation. Praise accurate parts, be clear about anything missing or mistaken, and call assess_teachback with concise strengths and weak_spots. Do not invent misconceptions; weak_spots can be empty when the answer is complete.`;
const VISUAL_PROMPT = ` The user wants a visual explanation they can understand at a glance, not raw labels. When it can clarify the topic, call create_visual with a friendly 3- or 4-step story from question to result. Make each short label concrete and each detail a clear plain-language sentence that explains why the next step follows; use a familiar example or analogy when helpful. Avoid unexplained jargon and generic headings like "Connection 1". Never generate code or markup. If no meaningful map can be made, explain briefly instead.`;
// Study mode: the student turned on guided learning, so teach instead of just answering.
const STUDY_MODE_PROMPT = ` STUDY MODE is on: you are a patient tutor. For homework-style questions do not just hand over the final answer: give the key idea or a hint, then ask ONE short guiding question and wait. When they answer, say what is right, gently fix what is not, and set the next small step. If they are stuck or ask you to just explain, explain it clearly. Keep replies short (under about 120 words) unless they asked to learn a concept. After a topic is done, ask one quick check question.`;

module.exports = {
    STUDY_TOOLS, TEACHBACK_PROMPT_TOOLS, TEACHBACK_ASSESS_TOOLS, VISUAL_TOOLS,
    STUDY_PROMPT, TEACHBACK_PROMPT, TEACHBACK_ASSESS_PROMPT, VISUAL_PROMPT, STUDY_MODE_PROMPT,
    wantsStudyTools, sanitizeStudy, sanitizeTeachback, sanitizeTeachbackPayload,
    sanitizeVisual, sanitizeVisualPayload, studyBlurb, teachbackBlurb, visualBlurb
};
