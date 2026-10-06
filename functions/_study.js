// Quiz + flashcard "tools" the chat model can call. The model returns structured
// arguments; we validate and clamp them here (never trust model JSON), and the
// front-end renders them as an interactive pop-up. Not a route (no exports.handler).

const STUDY_TOOLS = [
    {
        type: "function",
        function: {
            name: "create_quiz",
            description: "Create an interactive multiple-choice quiz that pops up on the user's screen. Use it when the user asks for a quiz, test, or practice questions. Make 5-10 questions unless they ask for a number.",
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
            description: "Create a set of flip-style flashcards that pops up on the user's screen. Use it when the user asks for flashcards or study cards. Make 8-15 cards unless they ask for a number.",
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

// Tools are only offered when the conversation is actually about quizzes/flashcards, so
// ordinary chat never risks a stray tool call (and the request stays cheap).
const STUDY_RE = /\b(quiz(zes)?|flash ?cards?|study cards?|revision cards?|test me|drill me|practice (questions|problems|test)|mcq|multiple[- ]choice)\b/i;
function wantsStudyTools(messages) {
    const text = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map(p => p?.text || "").join(" ") : "";
    return (messages || []).slice(-4).some(m => STUDY_RE.test(text(m.content).split(/\n\n\[Attached /)[0]));
}

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Turns a tool call ({name, arguments: JSON string}) into a safe, size-capped payload, or null.
function sanitizeStudy(name, rawArgs) {
    let args;
    try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs; } catch (e) { return null; }
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

function studyBlurb(study) {
    return study.type === "quiz"
        ? `Here's your quiz on **${study.title}** — ${study.questions.length} question${study.questions.length === 1 ? "" : "s"}. Good luck!`
        : `Here's your **${study.title}** flashcard deck — ${study.cards.length} card${study.cards.length === 1 ? "" : "s"}. Flip through them and mark what you know.`;
}

const STUDY_PROMPT = ` When asked, you can build a quiz (create_quiz) or flashcards (create_flashcards) that pop up for the user; get the topic first if it's missing, then reply with one short friendly line.`;

// Study mode: the student turned on guided learning, so teach instead of just answering.
const STUDY_MODE_PROMPT = ` STUDY MODE is on: you are a patient tutor. For homework-style questions do not just hand over the final answer: give the key idea or a hint, then ask ONE short guiding question and wait. When they answer, say what is right, gently fix what is not, and set the next small step. If they are stuck or ask you to just explain, explain it clearly. Keep replies short (under about 120 words) unless they asked to learn a concept. After a topic is done, ask one quick check question.`;

module.exports = { STUDY_TOOLS, STUDY_PROMPT, STUDY_MODE_PROMPT, wantsStudyTools, sanitizeStudy, studyBlurb };
