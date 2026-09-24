
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
// 독자 프로필: 모든 생성 프롬프트에 공통으로 붙여서, 기초 설명 대신 세부전문의
// 수련 수준(가이드라인 수치·근거·시술 디테일·함정) 중심으로 쓰도록 맞춥니다.
// ----------------------------------------------------------------------------
const READER_PROFILE = `
READER PROFILE (applies to everything you write):
- The reader is a physician in subspecialty (fellowship) training in cardiology at a large
  tertiary academic center in Korea, with advanced focus on electrophysiology and
  interventional cardiology. Their notes also cover general internal medicine and other
  clinical topics they run into at work (e.g., wound care, procedures, ward management).
- Write at that level. Skip textbook basics and definitions they already know. Prioritize:
  exact guideline thresholds and class of recommendation/level of evidence (ACC/AHA, ESC,
  ASE, HRS/EHRA, KSC where relevant), landmark and recent trial data, device and procedural
  specifics, practical pitfalls, and areas of controversy or where guidelines disagree.
- Use standard English medical terms and abbreviations as used in clinical practice without
  spelling out common ones (e.g., LVEF, PVI, CTI, TAVR, CRT-D, GDMT); Korean is fine for the
  connecting prose.
- For topics outside cardiology, keep the same attending-level density but do not invent
  subspecialty depth the note doesn't support.
- If something in the source is uncertain, outdated, or guideline-discordant, say so briefly
  instead of smoothing it over.
`;

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

// 주의: web_search 툴을 쓰면 Claude가 인용(citation)이 붙는 문장/절 단위로
// 응답을 여러 개의 작은 text 블록으로 쪼개서 돌려줍니다 (하나의 문단이 4~5개
// 블록으로 나뉘는 경우도 흔함). 이 블록들은 "원래 하나로 이어지는 텍스트를
// 인용 출처 표시를 위해 나눠놓은 것"일 뿐이라, 줄바꿈 없이 그대로 이어 붙여야
// 원문이 정확히 복원됩니다. 예전에 여기서 '\n'으로 이어붙였더니, 마침표만 딱
// 다음 줄로 넘어가거나 문장 중간이 어색하게 끊기는 등 가독성 문제가 있었습니다
// (블록 사이에 실제로는 없던 줄바꿈이 새로 생겨버렸기 때문).
const extractText = (data: any): string => {
    const blocks = data?.content || [];
    return blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
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

    // AI가 가끔 "- \n문장" 처럼 글머리표(-)만 있는 줄과 실제 내용이 다음 줄로
    // 분리된 형태로 출력할 때가 있습니다. 이 경우 마크다운이 이를 정상적인
    // 목록 항목으로 인식하지 못해, 화면에 "-"만 덩그러니 뜨고 그 아래 문장은
    // 글머리표 없는 일반 문단처럼 보이는 문제가 생깁니다. 목록 기호와 내용을
    // 같은 줄로 합쳐서 정상적인 목록으로 렌더링되게 합니다.
    processed = processed.replace(/^([-*])[ \t]*\n+(?=\S)/gm, '$1 ');

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
    // 이전엔 모든 "~"를 HTML 엔티티(&#126;)로 바꿨는데, 이 문자열이 marked.js를
    // 거치면서 "&"가 다시 이스케이프되어(예: &amp;#126;) 화면에 "20&#126;30ms"처럼
    // 깨진 텍스트로 그대로 노출되는 버그가 있었습니다. "20~30ms"같은 단일 물결표는
    // 마크다운에서 원래 특별한 의미가 없으므로 그대로 두고, 취소선 문법(~~text~~)으로
    // 잘못 해석될 수 있는 "~~" 연속 두 글자만 마크다운 이스케이프(\~\~)로 안전하게
    // 처리합니다(marked가 \~ 를 리터럴 ~ 문자로 올바르게 렌더링합니다).
    processed = processed.replace(/~~/g, '\\~\\~');

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

        const rawText = note.content || "No text content. Please analyze the image context.";
        // 결과지를 여러 건 붙여넣은 메모는 수만~십수만 자가 될 수 있어 넉넉히 보냅니다.
        // (짧은 일반 메모는 원래 길이만큼만 전송되므로 비용 차이는 없음)
        const MAX_SUMMARY_INPUT_CHARS = 150000;
        const isTruncated = rawText.length > MAX_SUMMARY_INPUT_CHARS;
        const textContent = rawText.substring(0, MAX_SUMMARY_INPUT_CHARS);

        const prompt = `
            You are a clinical knowledge assistant.
            ${READER_PROFILE}
            Analyze the provided note content and attached images (if any).

            Context: """${textContent}"""
            ${isTruncated ? `(NOTE: the note was longer than the limit and was cut off after ${MAX_SUMMARY_INPUT_CHARS} characters. Mention in one short line at the end that only the first part was analyzed.)` : ''}

            FIRST, classify the note itself:
            - "DATA": the note is mostly pasted clinical documentation written by others — exam/test
              reading reports (echo, CT, cath, EP study...), device interrogations, procedure records,
              admission/progress/discharge notes, lab results, etc. It may be ONE record or many, in ANY
              format: copied straight from the EMR, from a spreadsheet, split into [1]/[2] blocks or not.
              Don't depend on the layout — judge by the content.
            - "POLISHED": already reasonably organized/detailed notes (e.g. from a textbook,
              lecture slides, or the user's own structured writing).
            - "RUSHED": a quick, informal jotting — short fragments, abbreviations, no structure,
              things the user overheard or picked up on the fly (rounds, a colleague, a quick
              verbal pearl) and typed in a hurry, often without any source or context.

            IF DATA — ignore the POLISHED/RUSHED rules and LENGTH limits below and do this instead:
            - PURPOSE: the reader collects real records to learn HOW experienced physicians document
              things — so that later they can recall "how is this disease/finding usually described,
              which items do they always mention, what wording do they use". It is NOT about keeping or
              reproducing the original layout, and not about the individual patients.
            - Start with ONE line: what kind of records these are and roughly how many
              (e.g. "TTE 판독 32건", "CIED interrogation 9건", "AF ablation 시술기록 19건").
            - Then, grouped by disease / finding / procedure type ("###" heading per group, most
              frequent first), for each group a short bullet list ("- **항목명**: ..." on one line each):
              - **중점 항목**: which measurements/items are consistently reported for it, in the order
                they usually appear (e.g. "Vmax → mean PG → AVA → LVEF"), and what is often omitted.
              - **자주 쓰는 표현**: 2~5 representative phrases QUOTED VERBATIM from the records (keep their
                original Korean/English mix and abbreviations, e.g. "~ 소견 지속됨", "c/w ischemic insult of
                LAD territory"), plus the typical conclusion/impression sentence pattern with the variable
                parts shown as "O" (e.g. "O degenerative AR", "LVEF O% 내외의 O LV dysfunction").
              - **판정·등급 표현**: how severity/grades are expressed and which numbers they hang on;
                add the guideline threshold only when it helps interpret the wording.
              - **예시**: the record numbers where it appears ([3], [7] if the note numbers its records;
                otherwise #3, #7 by order of appearance) — no registration numbers.
            - Then "### 공통 서술 습관": the overall structure/ordering these records follow, frequent
              abbreviations, and habitual wording that cuts across groups (e.g. comparison with the
              previous exam, "~ 내외", "~ 시사").
            - A table is fine where it genuinely makes a comparison clearer, but bullets are the default.
              Table cells single-line.
            - The note may have grown over time (records pasted in several batches, maybe with the
              reader's own comments in between). Treat everything together.
            - Be complete but compact (roughly up to 4,000 Korean characters in total).
            - Web search: at most 2 searches, only if needed to check a guideline threshold you cite.

            Task (POLISHED / RUSHED):
            - If POLISHED: Write a concise, ABSTRACT-STYLE Markdown summary of the key medical
              concepts in this note — like a paper abstract, not a full explanation of everything.
            - If RUSHED: Treat the note's claims as something to VERIFY, not settled fact. Actively
              search for authoritative sources that confirm, refine, or correct what's written, and
              write the summary as verified, well-sourced clinical takeaways — essentially turning
              a rough memo into a properly grounded note. If a claim in the note seems imprecise,
              outdated, or you cannot find support for it, say so briefly (e.g. "⚠️ 최신 가이드라인과
              다를 수 있음") rather than silently repeating it as fact.

            LENGTH (STRICT for POLISHED / RUSHED — this is the most important rule):
            - At most 5~8 short bullet points, one sentence each.
            - Keep the ENTIRE summary under roughly 500 Korean characters (~350 words) in total.
            - Pick only the most clinically important points. Deliberately omit minor/secondary
              details rather than trying to cover everything in the note — a shorter, focused
              summary is strongly preferred over a long, exhaustive one.

            FORMATTING (STRICT — for DATA, only the bullet rule applies; quoted phrases stay exactly as written, no backticks):
            - For mathematical formulas, numbers with units, chemical equations, or special symbols (like >, <, =, ->, 1mm), ALWAYS wrap them in single backticks to format them as inline code.
              - Correct Example: \`> 1mm\`, \`x^2\`, \`H2O\`, \`pH < 7.35\`
              - Do NOT use LaTeX blocks like $$...$$ or raw symbols without backticks.
              - Use ≥ and ≤ instead of \\geq and \\leq.
            - Each bullet MUST be a markdown list line starting with "- " immediately followed by
              its full sentence on the SAME line (e.g. "- Some sentence here."). Never put just "-"
              alone on a line with the sentence starting on the next line.
            - Inside markdown table cells, do NOT use backticks — plain text only.

            SOURCES (POLISHED / RUSHED only — DATA follows its own web-search rule above):
            - Use the web search tool to find authoritative sources (society guidelines such as ACC/AHA, ESC, ASE, HRS; primary trials on PubMed; UpToDate) that validate these concepts, and cite them inline.
              - RUSHED notes: this is the main point of the task — search actively (up to 3 searches) to properly ground the memo in evidence.
              - POLISHED notes: keep research minimal (1-2 searches is usually enough) — citations must not make the summary longer than the length limit above.

            OUTPUT RULES (STRICT):
            - Output ONLY the final summary text itself. Do NOT narrate your process (no "먼저 검색해보겠습니다",
              "추가로 확인해보겠습니다", or similar meta-commentary before/between/after the summary).
            - Do NOT mention the "DATA"/"POLISHED"/"RUSHED" classification itself in the output — it's only for you to decide how to approach the task.
            - Output language: Korean (unless the note content is clearly in another language).
        `;
        content.push({ type: 'text', text: prompt });

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            // RUSHED(급하게 적은 메모) 케이스는 최대 3번까지 검색해 근거를 찾도록 허용합니다.
            // DATA(결과지 여러 건) 케이스는 정리표가 길어질 수 있어 max_tokens를 넉넉히
            // 뒀습니다 — 일반 메모는 프롬프트의 길이 제한 때문에 실제로는 짧게 끝납니다.
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            max_tokens: 8000
        });

        const summary = extractText(data) || "Summary generation failed.";
        const sources = extractCitations(data, 4);

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
            You are a creative clinical research assistant.
            ${READER_PROFILE}
            Analyze the provided notes (and images if any).

            Context: "${contextText.substring(0, 10000)}"

            Task:
            Suggest 3 to 5 **creative, novel, and thought-provoking** "Deep Dive Topics" based on these notes.

            CREATIVITY INSTRUCTIONS:
            1. **Avoid Standard Headers**: Do not use simple titles like "Pneumonia" or "Antibiotics".
            2. **Seek Novelty**: Frame topics as intriguing questions, comparative paradoxes, or deep mechanistic inquiries (e.g., "The immune system's double-edged sword in [Disease]", "Why [Treatment X] fails in [Condition Y]").
            3. **Interdisciplinary Connections**: Try to connect unrelated concepts found in the notes to offer a fresh perspective.

            CRITICAL RULES:
            1. **Relevance**: While being creative, ensure the topic is scientifically grounded in the context provided.
            2. **Level**: Topics must be worth a fellow's time — e.g. guideline discordances, trial results that changed practice, procedural decision points, mechanisms behind device/drug behavior. Nothing a resident would find basic.
            3. **Output Language: ${language}**.
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
            ? `Write a **PROFESSIONAL-GRADE, DEEP-DIVE** review for this topic, written for a subspecialty fellow (not students or residents).

               Required Depth:
               1. **Mechanism**: Pathophysiology or device/procedural mechanism at the level needed to reason through atypical cases.
               2. **Diagnosis & Assessment**: Exact criteria and thresholds (with guideline source and year), pitfalls in measurement/interpretation.
               3. **Management**: Guideline recommendations with class/LOE, key trials behind them (name, population, main result), and where guidelines or experts disagree.
               4. **Practical Pearls**: Procedural or real-world decision points and common errors.

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
            You are a subspecialty-level clinical educator.
            ${READER_PROFILE}
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
// 내 메모에 물어보기 / 여러 메모 정리본 만들기
// - 관련 메모 검색(임베딩)은 화면(AskNotesView)에서 하고, 여기서는 찾은 메모를 근거로
//   답변·정리본을 씁니다. 메모 번호 [메모1], [메모2] ... 는 화면에서 해당 메모로 바로 가는
//   링크로 바뀌므로, 모델이 반드시 이 형식으로 인용하도록 합니다. (메모 안의 결과지 번호
//   [1], [2] 와 헷갈리지 않도록 '메모'를 붙인 별도 형식을 씁니다.)
// - 웹 검색은 쓰지 않습니다: "내 메모 기반" 답이 목적이고, 빠르고 저렴하게 유지.
// ----------------------------------------------------------------------------
const buildNotesContext = (notes: Note[], perNoteChars: number, totalChars: number): string => {
    let used = 0;
    const parts: string[] = [];
    notes.forEach((n, i) => {
        if (used >= totalChars) return;
        const date = new Date(n.createdAt).toLocaleDateString('ko-KR');
        const body = [
            n.content || '',
            n.transcription ? `(사진에서 추출한 텍스트: ${n.transcription})` : '',
            n.summary ? `(이전에 만든 AI 요약: ${n.summary})` : ''
        ].filter(Boolean).join('\n');
        const budget = Math.min(perNoteChars, totalChars - used);
        const clipped = body.length > budget ? body.slice(0, budget) + '\n…(이하 생략)' : body;
        used += clipped.length;
        parts.push(`[메모${i + 1}] ${n.title || '제목 없음'} (${date})\n${clipped}`);
    });
    return parts.join('\n\n=====\n\n');
};

const NOTE_CITATION_RULES = `
CITATIONS (STRICT):
- The notes are labelled [메모1], [메모2], ... Cite the label right after every statement that comes
  from a note, e.g. "... LV threshold가 상승한 경우 [메모3]". Write each citation separately in exactly
  this form (e.g. "[메모1][메모4]"). Never quote note titles as citations, never invent labels not in
  the list, and never use bare numbers like [3] for notes.
- Inside a note, pasted results may be numbered **[1]**, **[2]** ... To point to one of those, write
  e.g. "메모2의 결과 #5" (no brackets) so it is not confused with a note citation.
- Anything NOT supported by the notes but needed for a correct answer: add it briefly and mark it
  "(메모 외 일반 지식)". Keep such additions short and clearly separated from what the notes say.
- If notes contradict each other, or a note looks outdated / guideline-discordant, flag it with "⚠️".
- When the question is about how something is DESCRIBED or DOCUMENTED (e.g. "MR은 판독에서 어떻게
  쓰더라", "interrogation에서 뭘 꼭 보더라"), answer from the pasted records in the notes: quote
  representative phrases verbatim, list the items that are consistently reported (in their usual
  order), and describe the typical conclusion sentence pattern — regardless of how the notes are formatted.
`;

export const answerFromNotes = async (question: string, notes: Note[]): Promise<string> => {
    const prompt = `
        You answer questions using the reader's OWN notes as the primary source.
        ${READER_PROFILE}

        QUESTION: """${question}"""

        THE READER'S NOTES (most relevant first):
        """
        ${buildNotesContext(notes, 6000, 40000)}
        """

        HOW TO ANSWER:
        - Start with the bottom line in 1~2 sentences, then supporting points as short bullets
          ("- " + full sentence on the same line). Use a small table only if comparing options.
        - Keep concrete numbers, thresholds, device settings and procedural details exactly as in
          the notes.
        - If the notes don't really address the question, say so in one line first, then answer
          briefly from general knowledge (marked as such).
        ${NOTE_CITATION_RULES}
        OUTPUT: Korean (medical terms in English as usual). Output only the answer — no preamble,
        no narration of your process.
    `;

    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 2500
    });
    const text = extractText(data);
    if (!text) throw new Error('답변이 비어 있습니다.');
    return text;
};

export const synthesizeNotes = async (topic: string, notes: Note[]): Promise<string> => {
    const prompt = `
        You merge several of the reader's own notes into ONE consolidated reference note.
        ${READER_PROFILE}

        TOPIC: """${topic}"""

        SOURCE NOTES:
        """
        ${buildNotesContext(notes, 8000, 70000)}
        """

        WRITE THE CONSOLIDATED NOTE:
        - Organize by the logic of the topic (e.g. indications → assessment/criteria → strategy/technique
          → pitfalls → follow-up), using "##" / "###" headings. Do NOT add a top-level "#" title.
        - Merge duplicates, but keep every concrete number, threshold, device parameter, drug/dose and
          procedural detail found in the notes. Where the notes differ, show both with citations.
        - Use a markdown table where it genuinely helps (comparisons, criteria); table cells single-line.
        - End with "## 빈 곳 / 더 볼 것": 2~4 bullets on clinically important sub-topics the notes do
          not cover yet (general knowledge, marked as such) — useful for the reader's next study.
        - Ignore notes that turn out to be unrelated to the topic (don't cite them).
        - Length: as long as needed to be complete, but no padding (roughly up to 3,500 Korean characters).
        ${NOTE_CITATION_RULES}
        OUTPUT: Korean (medical terms in English as usual). Output only the note itself.
    `;

    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 6000
    });
    const text = extractText(data);
    if (!text) throw new Error('정리본이 비어 있습니다.');
    return text;
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
            You are an attending physician writing subspecialty board-level questions.
            ${READER_PROFILE}
            Analyze the attached images (if any) and the following text context from the reader's own notes.
            Create ONE high-quality multiple choice question that integrates concepts from these notes if possible.

            QUESTION LEVEL:
            - For cardiology content: cardiovascular disease subspecialty board / fellowship in-training exam level
              (EP and interventional items at the depth expected of a fellow in those areas).
            - For non-cardiology content: internal medicine board level, written for an attending.
            - Test application and judgment, not recall: a clinical vignette with the data an expert would use
              (ECG/EGM findings, echo or hemodynamic values, device parameters, labs) and a decision to make.
            - Distractors must be plausible choices that a less experienced physician would pick
              (e.g. an outdated threshold, the right drug in the wrong setting, a correct step in the wrong order).
            - The keyed answer must be unambiguously correct under current major guidelines; avoid items where
              experts genuinely disagree.

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
            3. CRITICAL: Provide an explanation that states why the answer is correct (with the guideline
               threshold or trial behind it) and, briefly, why each distractor is wrong.
        `;
        content.push({ type: 'text', text: prompt });

        const input = await callForJson({
            model: MODEL_FAST,
            messages: [{ role: 'user', content }],
            toolName: 'submit_quiz_question',
            toolDescription: 'Submit the generated subspecialty board-style multiple-choice clinical quiz question.',
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
            ${READER_PROFILE}
            Based on the following notes (and attached images if any), create a single "True or False" statement for a quick review quiz, pitched at the reader's level above.
            The statement must be unambiguously true or false under current major guidelines — avoid points where experts genuinely disagree.

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
               3. **False Association**: Connect a treatment to the wrong condition in a way that sounds plausible.
               4. **Threshold Shift**: Use a cutoff that is close to, but not, the guideline value (or an outdated one).
               5. **Trial/Class Swap**: Attribute a result to the wrong trial, or state the wrong class of recommendation.
            - The goal is to test whether a fellow *really* knows the details, not to catch a novice.
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
            ${READER_PROFILE}

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
