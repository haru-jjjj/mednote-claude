
// ============================================================================
// Claude API service (Anthropic Messages API)
// ----------------------------------------------------------------------------
// 이 파일은 예전 services/geminiService.ts 를 대체합니다.
//
// 주의(보안): 이 프로젝트는 사용자의 선택에 따라 "프론트엔드에서 API를 직접 호출"하는
// 구조를 그대로 유지합니다. 즉 ANTHROPIC_API_KEY가 브라우저에 번들되어 노출됩니다.
// 개인적으로 로컬에서 실행하거나, 접근이 통제된 소수만 쓰는 환경이 아니라면
// 이 방식으로 공개 배포하지 마세요. (참고: https://support.claude.com/en/articles/9767949)
//
// 구조적으로 바뀐 점:
// - Gemini의 `responseMimeType: "application/json"` 텍스트 파싱 방식 대신,
//   Claude의 강제 tool-use(입력 스키마)를 사용해 항상 유효한 JSON을 받습니다.
//   (퀴즈 생성 등 - generateMedicalQuiz, generateOXQuiz, generateStudySuggestions)
// - Gemini의 Google Search grounding 대신 Claude의 web_search 툴을 사용하고,
//   응답 텍스트에 포함된 citations를 그대로 출처로 사용합니다.
//   (summarizeSingleNote, generateStudyGuideContent, generateDetailedQuizExplanation)
// - 정리 대상으로 결정된 기능(AI 시맨틱 검색 findRelevantNotes, Further Reading
//   getFurtherReading, 사용되지 않던 enhanceNoteContent)은 이 파일에 포함하지 않습니다.
// ============================================================================

import { Note, Source, QuizQuestion, QuizLanguage } from "../types";
import { v4 as uuidv4 } from 'uuid';

const ANTHROPIC_VERSION = '2023-06-01';
const API_URL = 'https://api.anthropic.com/v1/messages';

// 속도가 중요한 백그라운드 퀴즈 생성용 (빠르고 저렴한 모델)
const MODEL_FAST = 'claude-haiku-4-5-20251001';
// 품질이 중요한 요약/주제탐구/OCR/상세설명용
const MODEL_SMART = 'claude-sonnet-5';

// ----------------------------------------------------------------------------
// API 키 조회 (Vite 환경변수 → process.env 순서로 폴백)
// ----------------------------------------------------------------------------
const getApiKey = (): string => {
    let apiKey = "";

    try {
        apiKey = (import.meta as any).env?.VITE_ANTHROPIC_API_KEY || (import.meta as any).env?.ANTHROPIC_API_KEY || "";
    } catch (e) {
        // import.meta가 없는 환경일 수 있음
    }

    if (!apiKey || apiKey === 'undefined') {
        try {
            apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.API_KEY || "";
        } catch (e) {
            // process가 정의되지 않은 브라우저 환경일 수 있음
        }
    }

    if (!apiKey || apiKey === 'undefined' || (typeof apiKey === 'string' && apiKey.includes('TODO'))) {
        console.error("Anthropic API Key가 없거나 유효하지 않습니다.");
        throw new Error("API Key missing or invalid");
    }
    return apiKey;
};

// ----------------------------------------------------------------------------
// 저수준 호출 헬퍼
// ----------------------------------------------------------------------------
interface CallParams {
    model: string;
    messages: { role: 'user' | 'assistant'; content: any }[];
    system?: string;
    tools?: any[];
    tool_choice?: any;
    max_tokens?: number;
    temperature?: number;
}

const callClaude = async (params: CallParams): Promise<any> => {
    const apiKey = getApiKey();

    const body: Record<string, any> = {
        model: params.model,
        max_tokens: params.max_tokens ?? 2048,
        messages: params.messages,
    };
    if (params.system) body.system = params.system;
    if (params.tools) body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;

    // 방어적 처리: web_search 같은 서버 사이드 툴을 함께 쓰면 이 모델/버전 조합에서
    // "temperature is deprecated for this model" 400 에러로 요청 자체가 거부되는 것을
    // 실사용 중 확인했습니다. 앞으로 어떤 호출부가 실수로 web_search + temperature를
    // 같이 넘기더라도 조용히 무시하고 계속 동작하도록, 여기서 한 번 더 걸러줍니다.
    const usesServerTool = Array.isArray(params.tools) && params.tools.some((t: any) => t?.type === 'web_search_20250305');
    if (typeof params.temperature === 'number' && usesServerTool) {
        console.warn("web_search 툴과 temperature를 함께 요청해 temperature를 무시합니다 (API가 400으로 거부함).");
    } else if (typeof params.temperature === 'number') {
        body.temperature = Math.min(params.temperature, 1);
    }

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
            // 브라우저에서 직접 호출하기 위한 필수 헤더 (CORS 허용)
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let errBody: any = null;
        try { errBody = await response.json(); } catch { /* ignore */ }
        const errType = errBody?.error?.type || '';
        const errMsg = errBody?.error?.message || response.statusText;

        if (response.status === 401 || errType === 'authentication_error') {
            throw new Error(`API Key invalid or missing: ${errMsg}`);
        }
        if (response.status === 429 || errType === 'rate_limit_error') {
            throw new Error(`Quota exceeded (429): ${errMsg}`);
        }
        throw new Error(`Claude API error (${response.status} ${errType}): ${errMsg}`);
    }

    const data = await response.json();

    if (data.stop_reason === 'refusal') {
        throw new Error('Safety: content blocked by the model (refusal)');
    }

    return data;
};

// 방어적 처리: 저장 경로상 항상 순수 base64(데이터 URI 접두사 없이)여야 하지만,
// 혹시라도 "data:image/...;base64," 접두사가 섞여 들어오면 Claude API가 이를
// 유효하지 않은 base64로 보고 요청 자체를 거부(400)할 수 있어, 여기서 한 번 더 제거합니다.
const imageBlock = (base64: string) => {
    const cleaned = (base64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    return {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: cleaned }
    };
};

const extractText = (data: any): string => {
    const blocks = data?.content || [];
    return blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
};

// web_search 툴 사용 시 응답 텍스트 블록에 붙는 citations를 모아 출처 목록으로 변환
const extractCitations = (data: any, max = 5): Source[] => {
    const blocks = data?.content || [];
    const unique = new Map<string, Source>();
    blocks.forEach((b: any) => {
        if (b.type === 'text' && Array.isArray(b.citations)) {
            b.citations.forEach((c: any) => {
                if (c.url && !unique.has(c.url)) {
                    unique.set(c.url, { title: c.title || c.url, uri: c.url });
                }
            });
        }
    });
    return Array.from(unique.values()).slice(0, max);
};

// 강제 tool-use로 항상 유효한 JSON 객체를 돌려받기 위한 헬퍼
const callForJson = async (params: {
    model: string;
    messages: { role: 'user' | 'assistant'; content: any }[];
    toolName: string;
    toolDescription: string;
    schema: Record<string, any>;
    maxTokens?: number;
    temperature?: number;
}): Promise<any> => {
    const data = await callClaude({
        model: params.model,
        messages: params.messages,
        tools: [{
            name: params.toolName,
            description: params.toolDescription,
            input_schema: params.schema
        }],
        tool_choice: { type: 'tool', name: params.toolName },
        max_tokens: params.maxTokens,
        temperature: params.temperature
    });

    const toolUse = (data.content || []).find((b: any) => b.type === 'tool_use' && b.name === params.toolName);
    if (!toolUse) {
        throw new Error('Claude did not return the expected structured output');
    }
    return toolUse.input;
};

// ----------------------------------------------------------------------------
// Helper: Format Medical Markdown (LaTeX to HTML/Unicode) — 순수 텍스트 처리, API 호출 없음
// ----------------------------------------------------------------------------
export const formatMedicalMarkdown = (text: string): string => {
    if (!text) return "";
    let processed = text;

    const greekMap: Record<string, string> = {
        'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ε',
        'theta': 'θ', 'lambda': 'λ', 'mu': 'μ', 'pi': 'π', 'sigma': 'σ',
        'tau': 'τ', 'phi': 'φ', 'omega': 'ω', 'Delta': 'Δ'
    };
    Object.entries(greekMap).forEach(([key, val]) => {
        processed = processed.replace(new RegExp(`\\\\${key}(?![a-zA-Z])`, 'g'), val);
    });

    const symbolMap: Record<string, string> = {
        'rightarrow': '→', 'leftarrow': '←', 'approx': '≈', 'neq': '≠',
        'leq': '≤', 'geq': '≥', 'pm': '±', 'times': '×', 'cdot': '·'
    };
    Object.entries(symbolMap).forEach(([key, val]) => {
        processed = processed.replace(new RegExp(`\\\\${key}(?![a-zA-Z])`, 'g'), val);
    });

    processed = processed.replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>');
    processed = processed.replace(/\^([0-9+\-]+)/g, '<sup>$1</sup>');
    processed = processed.replace(/_\{([^}]+)\}/g, '<sub>$1</sub>');
    processed = processed.replace(/([a-zA-Zα-ωΑ-Ω])_(\d+)/g, '$1<sub>$2</sub>');
    processed = processed.replace(/\$/g, '');
    processed = processed.replace(/~/g, '&#126;');

    return processed;
};

// ----------------------------------------------------------------------------
// 메모 내 AI 요약 (핵심 유지 기능)
// ----------------------------------------------------------------------------
export const summarizeSingleNote = async (note: Note): Promise<{ summary: string; sources: Source[] } | null> => {
    try {
        const content: any[] = [];

        if (note.images && note.images.length > 0) {
            note.images.forEach(base64 => content.push(imageBlock(base64)));
        }

        const textContent = note.content || "No text content. Please analyze the image context.";

        const prompt = `
            You are a medical study assistant.
            Analyze the provided medical note content and attached images (if any).

            Context: "${textContent.substring(0, 5000)}"

            Task: Write a concise, ABSTRACT-STYLE Markdown summary of the key medical concepts in this note —
            like a paper abstract, not a full explanation of everything in the note.

            LENGTH (STRICT — this is the most important rule):
            - At most 5~8 short bullet points, one sentence each.
            - Keep the ENTIRE summary under roughly 500 Korean characters (~350 words) in total.
            - Pick only the most clinically important points. Deliberately omit minor/secondary
              details rather than trying to cover everything in the note — a shorter, focused
              summary is strongly preferred over a long, exhaustive one.

            FORMATTING:
            - For mathematical formulas, numbers with units, chemical equations, or special symbols (like >, <, =, ->, 1mm), ALWAYS wrap them in single backticks to format them as inline code.
              - Correct Example: \`> 1mm\`, \`x^2\`, \`H2O\`, \`pH < 7.35\`
              - Do NOT use LaTeX blocks like $$...$$ or raw symbols without backticks.
              - Use ≥ and ≤ instead of \\geq and \\leq.

            SOURCES:
            - Use the web search tool to find at most 2-3 authoritative medical sources (e.g. CDC, NIH, Mayo Clinic, PubMed, UpToDate) that validate these concepts, and cite them inline.
            - Keep research minimal (1-2 searches is usually enough) — citations must not make the summary longer than the length limit above.

            OUTPUT RULES (STRICT):
            - Output ONLY the final summary text itself. Do NOT narrate your process (no "먼저 검색해보겠습니다",
              "추가로 확인해보겠습니다", or similar meta-commentary before/between/after the summary).
            - Output language: Korean (unless the note content is clearly in another language).
        `;
        content.push({ type: 'text', text: prompt });

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
            max_tokens: 1800
        });

        const summary = extractText(data) || "Summary generation failed.";
        const sources = extractCitations(data, 3);

        return { summary, sources };

    } catch (error) {
        console.error("Summarize Single Note Failed", error);
        return null;
    }
};

// ----------------------------------------------------------------------------
// AI 주제 탐구 (Study Guide) — 유지 결정된 부가 기능
// ----------------------------------------------------------------------------
export const generateStudySuggestions = async (notes: Note[], language: string = 'Korean'): Promise<string[]> => {
    try {
        if (notes.length === 0) return [];
        const content: any[] = [];

        notes.forEach(note => {
            if (note.images && note.images.length > 0) {
                note.images.forEach(base64 => content.push(imageBlock(base64)));
            }
        });

        const contextText = notes.map(n =>
            `[Note: ${n.title}]\n${n.content}\n${n.transcription ? '(Extracted Text: ' + n.transcription + ')' : ''}`
        ).join("\n\n---\n\n");

        const prompt = `
            You are a creative medical research assistant.
            Analyze the provided medical notes (and images if any).

            Context: "${contextText.substring(0, 10000)}"

            Task:
            Suggest 3 to 5 **creative, novel, and thought-provoking** "Deep Dive Topics" based on these notes.

            CREATIVITY INSTRUCTIONS:
            1. **Avoid Standard Headers**: Do not use simple titles like "Pneumonia" or "Antibiotics".
            2. **Seek Novelty**: Frame topics as intriguing questions, comparative paradoxes, or deep mechanistic inquiries (e.g., "The immune system's double-edged sword in [Disease]", "Why [Treatment X] fails in [Condition Y]").
            3. **Interdisciplinary Connections**: Try to connect unrelated concepts found in the notes to offer a fresh perspective.

            CRITICAL RULES:
            1. **Relevance**: While being creative, ensure the topic is scientifically grounded in the context provided.
            2. **Output Language: ${language}**.
        `;
        content.push({ type: 'text', text: prompt });

        const input = await callForJson({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            toolName: 'submit_suggestions',
            toolDescription: 'Submit the list of creative deep-dive study topic suggestions.',
            schema: {
                type: 'object',
                properties: {
                    suggestions: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 }
                },
                required: ['suggestions']
            },
            temperature: 1,
            maxTokens: 1000
        });

        return input.suggestions || [];
    } catch (error) {
        console.error("Study Suggestions Failed", error);
        return [];
    }
};

export const generateStudyGuideContent = async (topic: string, notes: Note[], modelLevel: 'fast' | 'detailed' = 'fast', language: string = 'Korean'): Promise<{ content: string; sources: Source[] } | null> => {
    try {
        const content: any[] = [];

        let imageCount = 0;
        const MAX_IMAGES = 3;
        notes.forEach(note => {
            if (imageCount < MAX_IMAGES && note.images && note.images.length > 0) {
                content.push(imageBlock(note.images[0]));
                imageCount++;
            }
        });

        const contextText = notes.map(n =>
            `[Note: ${n.title}]\n${n.content}\n${n.transcription ? '(Extracted Text: ' + n.transcription + ')' : ''}`
        ).join("\n\n---\n\n");

        const taskInstruction = modelLevel === 'detailed'
            ? `Write a **PROFESSIONAL-GRADE, DEEP-DIVE** medical review article for this topic, intended for medical students or residents.

               Required Depth:
               1. **Pathophysiology**: Explain the mechanism at a molecular or cellular level.
               2. **Clinical Presentation**: Distinguish between typical and atypical presentations.
               3. **Diagnosis**: Specific diagnostic criteria, gold standard tests, and relevant lab values.
               4. **Management**: Detailed treatment protocols, first-line vs second-line agents, and mechanisms of action.

               Tone: Academic, precise, and clinically oriented. Avoid superficial summaries. Be thorough,
               but write efficiently (no redundant padding or repeated points) so the full article fits
               within your response and is never cut off mid-section.`
            : `Create an **EXECUTIVE CLINICAL BRIEF** for a Medical Specialist or Researcher.
               - **Target Audience**: Senior Fellows, Attending Physicians, and Clinical Researchers.
               - **Depth**: Go beyond basic textbooks. Focus on recent clinical trial data, emerging pathomechanisms, controversial management guidelines, and novel therapeutic targets.
               - **Style**: Extremely dense, technical, and precise. Use professional medical abbreviations and jargon.
               - **Format**: Structured Executive Summary (Bullet points).
               - **Strict Length**: Roughly 300-500 words total (not counting citations). This is a BRIEF —
                 stay condensed even when citing multiple sources, so it never gets cut off mid-sentence.`;

        const prompt = `
            You are a specialized medical tutor.
            Topic to Explain: "${topic}"

            Potential Context Notes (Warning: These may or may not be relevant):
            "${contextText.substring(0, 15000)}"

            Task:
            ${taskInstruction}

            CRITICAL INSTRUCTIONS:
            1. **STRICT RELEVANCE CHECK**: If a note is directly related to "${topic}", cite it and expand on it. **IF THE NOTES ARE UNRELATED, IGNORE THEM COMPLETELY** and generate the guide from your own medical knowledge plus web search.
            2. **Mandatory Citations**: You MUST use the web search tool to find and cite authoritative medical sources (PubMed, CDC, NIH, etc.). Keep searches efficient (a couple of targeted searches is enough) rather than exhaustive.
            3. **Structure**: Use Markdown headers (##, ###) to organize the guide logically.
            4. **Language**: ${language}.
            5. **No meta-commentary**: Output ONLY the guide itself. Do NOT narrate your research process
               (e.g. do not write things like "Let me search for..." or "먼저 검색해보겠습니다") before,
               between, or after the content.
        `;
        content.push({ type: 'text', text: prompt });

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            // NOTE: 이 모델/버전 조합에서는 web_search 툴과 함께 temperature를 보내면
            // "400 invalid_request_error: `temperature` is deprecated for this model"로
            // 요청 자체가 거부됩니다(실사용 중 발견). 그래서 다른 web_search 호출들처럼
            // temperature 파라미터를 아예 보내지 않습니다.
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: modelLevel === 'detailed' ? 3 : 2 }],
            max_tokens: modelLevel === 'detailed' ? 4500 : 2200
        });

        const text = extractText(data) || "Explanation generation failed.";
        const sources = extractCitations(data, 5);

        return { content: text, sources };

    } catch (error) {
        // 예전엔 여기서 null만 반환하고 실제 에러 메시지를 삼켜버려서, 호출부(주제 탐구
        // 화면)에서 "아무 반응 없음"으로만 보이고 사용자는 원인을 전혀 알 수 없었습니다.
        // 호출부가 이미 try/catch로 감싸고 있으므로, 여기서는 원래 에러를 그대로
        // 다시 던져서 실제 원인(예: API 키 문제, 429 rate limit, 네트워크 오류 등)이
        // 화면까지 전달되도록 합니다.
        console.error("Study Guide Content Gen Failed", error);
        throw error;
    }
};

// ----------------------------------------------------------------------------
// 이미지 OCR / 텍스트 추출 (메모 저장 시 백그라운드로 실행)
// ----------------------------------------------------------------------------
export const extractTextFromImages = async (images: string[]): Promise<string> => {
    try {
        if (!images || images.length === 0) return "";

        const content: any[] = [
            { type: 'text', text: "Extract and transcribe all legible text and identify key medical visual features from these images. Return ONLY the extracted text and key visual descriptors. Do not summarize, just transcribe." },
            ...images.map(imageBlock)
        ];

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            max_tokens: 2000
        });

        return extractText(data);
    } catch (error) {
        console.error("OCR Failed", error);
        return "";
    }
};

// ----------------------------------------------------------------------------
// AI 퀴즈 복습 (핵심 유지 기능): MCQ / OX
// ----------------------------------------------------------------------------
export const generateMedicalQuiz = async (notes: Note[], language: QuizLanguage = 'Korean', signal?: AbortSignal): Promise<QuizQuestion | null> => {
    try {
        if (notes.length === 0) return null;

        const content: any[] = [];
        let imageCount = 0;
        const MAX_IMAGES = 1;

        notes.forEach(note => {
            if (imageCount < MAX_IMAGES && note.images && note.images.length > 0) {
                note.images.forEach(base64 => {
                    if (imageCount < MAX_IMAGES) {
                        content.push(imageBlock(base64));
                        imageCount++;
                    }
                });
            }
        });

        const contextText = notes.map(n =>
            `[Note: ${n.title}]\n${n.content}\n${n.transcription ? '(Extracted Text: ' + n.transcription + ')' : ''}`
        ).join("\n\n---\n\n");

        const prompt = `
            You are a medical professor.
            Analyze the attached images (if any) and the following text context derived from multiple student notes.
            Create a HIGH-QUALITY USMLE Step 2 CK style multiple choice question that integrates concepts from these notes if possible.

            CRITICAL INSTRUCTION:
            - Some notes may consist ONLY of images (e.g., handwritten notes, textbook screenshots, anatomical diagrams).
            - You MUST analyze the visual content of these images deeply to extract medical concepts for the question.
            - If the text context is empty or minimal, rely entirely on the visual information from the images.
            - **Output Language: ${language}** (The question, options, and explanation MUST be written in ${language}).

            Context Text:
            "${contextText.substring(0, 4000)}"

            Task:
            1. Create a challenging clinical scenario based on the provided context.
            2. Provide exactly 5 options (A-E).
            3. CRITICAL: Provide a **comprehensive medical explanation**.
        `;
        content.push({ type: 'text', text: prompt });

        const input = await callForJson({
            model: MODEL_FAST,
            messages: [{ role: 'user', content }],
            toolName: 'submit_quiz_question',
            toolDescription: 'Submit the generated USMLE-style multiple-choice clinical quiz question.',
            schema: {
                type: 'object',
                properties: {
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
                    correctAnswerIndex: { type: 'integer', minimum: 0, maximum: 4 },
                    explanation: { type: 'string' },
                    sources: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { title: { type: 'string' }, uri: { type: 'string' } },
                            required: ['title', 'uri']
                        }
                    }
                },
                required: ['question', 'options', 'correctAnswerIndex', 'explanation']
            },
            maxTokens: 1500
        });

        if (!input || !input.question || !input.options) {
            console.error("Invalid quiz structure from AI", input);
            return null;
        }

        return {
            question: input.question,
            options: input.options,
            correctAnswerIndex: input.correctAnswerIndex,
            explanation: input.explanation,
            sources: input.sources || [],
            id: uuidv4(),
            type: 'MULTIPLE_CHOICE',
            relatedNoteIds: notes.map(n => n.id)
        };

    } catch (error) {
        if ((error as Error).message === "Aborted by user") throw error;
        console.error("Quiz Gen Failed", error);
        return null;
    }
};

export const generateOXQuiz = async (notes: Note[], language: QuizLanguage = 'Korean', signal?: AbortSignal): Promise<QuizQuestion | null> => {
    try {
        if (notes.length === 0) return null;

        const content: any[] = [];
        let imageCount = 0;
        const MAX_IMAGES = 1;

        notes.forEach(note => {
            if (imageCount < MAX_IMAGES && note.images && note.images.length > 0) {
                note.images.forEach(base64 => {
                    if (imageCount < MAX_IMAGES) {
                        content.push(imageBlock(base64));
                        imageCount++;
                    }
                });
            }
        });

        const contextText = notes.map(n =>
            `[Note: ${n.title}]\nContent: ${n.content}\n${n.summary ? '(AI Summary: ' + n.summary + ')' : ''}\n${n.transcription ? '(Extracted Text: ' + n.transcription + ')' : ''}`
        ).join("\n\n---\n\n");

        const targetAnswerIsTrue = Math.random() < 0.5;

        const prompt = `
            Based on the following medical notes (and attached images if any), create a single "True or False" statement for a quick review quiz.

            CRITICAL VISUAL ANALYSIS INSTRUCTION:
            - If a note contains BOTH text and images (charts, histology, diagrams), you MUST analyze the visual content.
            - Do not rely solely on the provided text. Cross-reference the text with the visual data in the images.

            - **You MUST generate a statement that is ${targetAnswerIsTrue ? "TRUE" : "FALSE"}**. This is a strict requirement for balance.
            - **Output Language: ${language}** (The statement and explanation MUST be written in ${language}).

            Note Content:
            "${contextText.substring(0, 4000)}"

            Instructions:
            - Create ONE statement related to the medical facts in these notes.
            - The statement must be medically ${targetAnswerIsTrue ? "accurate (True)" : "inaccurate/false (False)"}.

            ${!targetAnswerIsTrue ? `
            **CRITICAL INSTRUCTION FOR FALSE STATEMENTS:**
            - Do NOT create a simple negation (e.g., do not just add "not").
            - Create a **plausible, confusing, or tricky** false statement.
            - **Techniques to use:**
               1. **Concept Swapping**: Attribute a symptom/drug/mechanism of Disease A to Disease B.
               2. **Nuance Alteration**: Change "increases" to "decreases", or "sympathetic" to "parasympathetic".
               3. **False Association**: Connect a treatment to the wrong condition in a way that sounds medically plausible to a novice.
            - The goal is to test if the user *really* understands the details.
            ` : ''}

            - If False, provide an informative correction (2-3 sentences) explaining the correct medical reasoning.
            - If True, provide an informative confirmation (2-3 sentences) explaining why it is correct.
            - Do NOT be too brief. Give some context.
        `;
        content.push({ type: 'text', text: prompt });

        const input = await callForJson({
            model: MODEL_FAST,
            messages: [{ role: 'user', content }],
            toolName: 'submit_ox_question',
            toolDescription: 'Submit the generated True/False quick-review statement.',
            schema: {
                type: 'object',
                properties: {
                    question: { type: 'string' },
                    isTrue: { type: 'boolean' },
                    explanation: { type: 'string' }
                },
                required: ['question', 'isTrue', 'explanation']
            },
            maxTokens: 800
        });

        if (!input || !input.question) {
            console.error("Invalid OX data", input);
            return null;
        }

        return {
            id: uuidv4(),
            type: 'OX',
            question: input.question,
            options: ['O', 'X'],
            correctAnswerIndex: input.isTrue ? 0 : 1,
            explanation: input.explanation,
            sources: [],
            relatedNoteIds: notes.map(n => n.id)
        };
    } catch (error) {
        if ((error as Error).message === "Aborted by user") throw error;
        console.error("OX Gen Failed", error);
        return null;
    }
};

export const generateDetailedQuizExplanation = async (question: string, isTrue: boolean, language: QuizLanguage = 'Korean'): Promise<{ explanation: string; sources: Source[] } | null> => {
    try {
        const prompt = `
            Role: Medical Specialist presenting clinical evidence to peers.

            Task: validation of the True/False statement below.

            Statement: "${question}"
            Correct Answer: ${isTrue ? "True (O)" : "False (X)"}

            **STRICT GUIDELINES**:
            1. **TONE**: Professional, objective, and dry. **NO TEACHING TONE**. Do NOT use phrases like "It is important to remember", "Student should note", or "Let's look at". Write as if writing for a medical journal.
            2. **SOURCES**: Use the web search tool ONLY to retrieve URL references. Do not waste time summarizing external articles in the text.
            3. **Language**: ${language}.

            Format:
            - **Clinical Rationale**: [Direct explanation of the mechanism/guideline]
            - **Key Evidence**: [Bullet points of key facts]
        `;

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            max_tokens: 1200
        });

        const explanation = extractText(data) || "Detailed explanation generation failed.";
        const sources = extractCitations(data, 3);

        return { explanation, sources };

    } catch (error) {
        console.error("Detailed Explanation Failed", error);
        return null;
    }
};
