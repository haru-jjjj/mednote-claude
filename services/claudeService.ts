
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

import { Note, Source, QuizQuestion, QuizLanguage, GuidelineCheck } from "../types";
import { applySectionPatch } from "./handoverPatch";
import { threadPlainText, uncitedClaims } from "./threadFormat";
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
- Style: plain, calm text. Do NOT use emoji or decorative symbols (no ⚠️ ✅ ❌ 🔥 📌 ✨ etc.).
  When something needs a flag, write a short bold word instead, e.g. "**주의**", "**확인 필요**",
  "**변경됨**". Arrows (→), ≥/≤ and plain bullets are fine.
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
    // 생각(thinking) 깊이. Sonnet 5 이상에서만 보냄(Haiku 4.5는 지원 안 함). 미지정 시 모델 기본값(high).
    effort?: 'low' | 'medium' | 'high';
}

// Claude Sonnet 5는 "적응형 생각(adaptive thinking)"이 기본으로 켜져 있고, 생각에 쓴 토큰도 max_tokens에
// 포함됩니다. 그래서 max_tokens가 작으면 생각하다가 한도에 걸려 본문(text)이 하나도 없는 응답이 올 수
// 있습니다(실제로 "인계장 결과가 비어 있습니다" 오류의 원인). 이를 막기 위해:
//  1) SMART 모델은 max_tokens를 최소 SMART_MIN_MAX_TOKENS로 올려 보냄 (실제 쓴 만큼만 과금되므로 비용 차이 없음)
//  2) 그래도 본문 없이 한도에 걸리면, 한도를 늘리고 생각 깊이를 낮춰(effort: low) 한 번 더 요청
// 참고: https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
const SMART_MIN_MAX_TOKENS = 16000;
const RETRY_MAX_TOKENS = 32000;

const hasTextOrTool = (data: any) =>
    (data?.content || []).some((b: any) => (b.type === 'text' && (b.text || '').trim()) || b.type === 'tool_use');

const callClaude = async (params: CallParams): Promise<any> => {
    const isSmart = params.model === MODEL_SMART;
    const first = await callClaudeOnce({
        ...params,
        max_tokens: isSmart ? Math.max(params.max_tokens ?? 2048, SMART_MIN_MAX_TOKENS) : params.max_tokens
    });
    if (hasTextOrTool(first) || first?.stop_reason !== 'max_tokens') return first;
    console.warn('생각 단계에서 max_tokens에 걸려 본문이 비어 있어, 한도를 늘리고 effort를 낮춰 다시 요청합니다.');
    return callClaudeOnce({
        ...params,
        max_tokens: RETRY_MAX_TOKENS,
        effort: isSmart ? 'low' : params.effort
    });
};

const callClaudeOnce = async (params: CallParams): Promise<any> => {
    const apiKey = getApiKey();

    const body: Record<string, any> = {
        model: params.model,
        max_tokens: params.max_tokens ?? 2048,
        messages: params.messages,
    };
    if (params.effort && params.model !== MODEL_FAST) body.output_config = { effort: params.effort };
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
    } else if (typeof params.temperature === 'number' && params.model === MODEL_SMART) {
        // Sonnet 5는 temperature를 기본값이 아닌 값으로 보내면 400 → 보내지 않음
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
    // 코드 블록(\`\`\` ... \`\`\`, 예: 작성 템플릿) 안은 원문 그대로 두고 바깥만 변환
    if (text.includes('```')) {
        return text.split(/(```[\s\S]*?```)/g)
            .map((part, i) => (i % 2 === 1 ? part : formatMedicalMarkdownPlain(part)))
            .join('');
    }
    return formatMedicalMarkdownPlain(text);
};

const formatMedicalMarkdownPlain = (text: string): string => {
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

            READER'S TAG FOR THIS NOTE: ${note.tag === 'patient' ? '"환자" (patient note)' : [note.tag === 'memo' ? '"메모" (study memo — NOT a patient case)' : '', note.work ? '"업무" (work note: handover items, ward/procedure workflow, practical procedure tips — NOT a patient case)' : ''].filter(Boolean).join(' + ') || 'none'}
            ${note.work ? `- This is a WORK note. Whatever mode you choose below, keep every actionable detail exactly (steps,
              order of actions, settings, doses, device/catheter names and sizes, extension numbers, who/when to call),
              and organize it so it can be followed on the job. Never use PATIENT for it.` : ''}

            FIRST, classify the note itself:
            - "PATIENT": the note is about ONE specific patient the reader is managing — their history,
              that patient's test results/records over time, a case write-up, admission/progress notes.
              RULES: if the tag is "환자", ALWAYS use PATIENT (even if it contains pasted reports).
              If the tag is "메모" or "업무", NEVER use PATIENT. If there is no tag, use PATIENT only when the note
              is clearly about one specific patient.
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

            IF PATIENT — ignore the DATA/POLISHED/RUSHED rules and LENGTH limits below and do this instead.
            This is educational decision support for a physician; they make the final call.
            Use these "###" sections, in this order:
            ### 케이스 요약
              3~6 bullets: key background, the timeline of key findings WITH DATES and the trend of key
              values (e.g. "LVEF 35% (2025.03) → 48% (2026.07)"), current problem list.
            ### 추정 진단
              The most likely diagnosis/diagnoses, each with the specific findings in the note that
              support it (with dates). Say how confident, and why.
            ### 감별 진단
              2~5 alternatives worth excluding. For each, one line each for: 지지 소견 / 반대 소견 /
              감별에 필요한 검사·정보.
            ### 추가로 확인할 것
              Missing data or tests, and guideline-based next steps worth checking (with the threshold
              or class of recommendation where it matters). Flag anything potentially urgent with a leading "**주의**".
            ### 추가 공부
              2~4 focused topics worth reading for THIS case (a guideline section, a landmark trial, a
              mechanism or procedural point), each with one line on why it matters here.
            - If the note doesn't contain enough to reason about something, say what is missing instead
              of guessing.
            - Bullets "- " with the full sentence on the same line. Up to ~3,000 Korean characters.
            - Web search: up to 3 searches to ground guideline thresholds/recommendations; cite them.

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
              outdated, or you cannot find support for it, say so briefly (e.g. "**주의**: 최신 가이드라인과
              다를 수 있음") rather than silently repeating it as fact.

            LENGTH (STRICT for POLISHED / RUSHED — this is the most important rule):
            - At most 5~8 short bullet points, one sentence each.
            - Keep the ENTIRE summary under roughly 500 Korean characters (~350 words) in total.
            - Pick only the most clinically important points. Deliberately omit minor/secondary
              details rather than trying to cover everything in the note — a shorter, focused
              summary is strongly preferred over a long, exhaustive one.

            FORMATTING (STRICT — for PATIENT and DATA, only the bullet rule applies; quoted phrases stay exactly as written, no backticks):
            - For mathematical formulas, numbers with units, chemical equations, or special symbols (like >, <, =, ->, 1mm), ALWAYS wrap them in single backticks to format them as inline code.
              - Correct Example: \`> 1mm\`, \`x^2\`, \`H2O\`, \`pH < 7.35\`
              - Do NOT use LaTeX blocks like $$...$$ or raw symbols without backticks.
              - Use ≥ and ≤ instead of \\geq and \\leq.
            - Each bullet MUST be a markdown list line starting with "- " immediately followed by
              its full sentence on the SAME line (e.g. "- Some sentence here."). Never put just "-"
              alone on a line with the sentence starting on the next line.
            - Inside markdown table cells, do NOT use backticks — plain text only.

            SOURCES (POLISHED / RUSHED only — PATIENT and DATA follow their own web-search rules above):
            - Use the web search tool to find authoritative sources (society guidelines such as ACC/AHA, ESC, ASE, HRS; primary trials on PubMed; UpToDate) that validate these concepts, and cite them inline.
              - RUSHED notes: this is the main point of the task — search actively (up to 3 searches) to properly ground the memo in evidence.
              - POLISHED notes: keep research minimal (1-2 searches is usually enough) — citations must not make the summary longer than the length limit above.

            OUTPUT RULES (STRICT):
            - Output ONLY the final summary text itself. Do NOT narrate your process (no "먼저 검색해보겠습니다",
              "추가로 확인해보겠습니다", or similar meta-commentary before/between/after the summary).
            - Do NOT mention the "PATIENT"/"DATA"/"POLISHED"/"RUSHED" classification itself in the output — it's only for you to decide how to approach the task.
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
// AI 요약에 질문·추가 사항을 넣어 다시 정리 (요약 전체를 갱신한 버전을 돌려줌)
// - 메모 원문(최신) + 지금 요약 + 이미 반영된 이전 요청 + 새 요청을 함께 보냄
// - 일반 요약과 저널클럽 분석 모두 사용
// ----------------------------------------------------------------------------
export const REFINE_MAX_NOTE_CHARS = 120000;

const mergeSources = (a: Source[], b: Source[], max = 8): Source[] => {
    const map = new Map<string, Source>();
    [...a, ...b].forEach(s => { if (s?.uri && !map.has(s.uri)) map.set(s.uri, s); });
    return Array.from(map.values()).slice(0, max);
};

export const refineNoteSummary = async (
    note: Note,
    params: { currentSummary: string; currentSources: Source[]; request: string; kind?: 'journal'; earlierRequests?: string[] }
): Promise<{ summary: string; sources: Source[] }> => {
    const content: any[] = [];
    (note.images || []).slice(0, 8).forEach(img => content.push(imageBlock(img)));

    const raw = [note.content || '', note.transcription ? `(사진에서 추출한 텍스트)\n${note.transcription}` : '']
        .filter(Boolean).join('\n\n');
    const isTruncated = raw.length > REFINE_MAX_NOTE_CHARS;
    const noteText = raw.substring(0, REFINE_MAX_NOTE_CHARS);
    const isJournal = params.kind === 'journal';
    const label = isJournal ? 'journal club analysis of the paper in the note' : 'AI summary of the note';
    const earlier = (params.earlierRequests || []).filter(Boolean).slice(-8);
    const tag = note.tag === 'patient' ? '"환자" (patient case note)'
        : [note.tag === 'memo' ? '"메모" (study memo)' : '', note.work ? '"업무" (work note: handover items, procedure tips)' : ''].filter(Boolean).join(' + ') || 'none';

    const prompt = `
        You maintain the ${label}. The reader has read the current version and wants it updated with a
        question or an addition of their own.
        ${READER_PROFILE}

        READER'S TAG FOR THIS NOTE: ${tag}

        THE NOTE (latest version — it may have been edited after the current summary was written):
        """${noteText || '(no text — use the attached images)'}"""
        ${isTruncated ? `(The note was cut after ${REFINE_MAX_NOTE_CHARS} characters.)` : ''}

        CURRENT ${isJournal ? 'ANALYSIS' : 'SUMMARY'}:
        """${params.currentSummary}"""
        ${earlier.length ? `\n        EARLIER REQUESTS already reflected in the current version (keep honoring them):\n${earlier.map(r => `        - ${r.replace(/\n+/g, ' ')}`).join('\n')}\n` : ''}
        THE READER'S NEW REQUEST:
        """${params.request}"""

        TASK — return the UPDATED, COMPLETE ${isJournal ? 'analysis' : 'summary'} with the request integrated:
        - If the request is a QUESTION: answer it inside the document. Put the answer where it naturally belongs
          (expand the relevant section or bullet). If it doesn't fit any existing part, add or extend a final
          section "### 추가 질문 정리" with "- **Q.** question" and "  - **A.** answer" (keep earlier Q/As there).
        - If it is an ADDITION or INSTRUCTION (add a point, emphasize, shorten, reorganize, make a table, correct
          something): apply it across the whole document.
        - Keep everything from the current version that the request does not change — never drop content
          silently. Remove or shorten only when the request asks for it.
        - Keep the existing structure, headings and style. Keep the length about the same unless the request
          needs more (then grow only as much as needed).
        - If the note now contains information the current version doesn't cover, integrate it too.
        - If the request conflicts with the note or with current evidence, say so briefly with a leading "**주의**" and the
          reason/source instead of complying blindly. Never invent numbers that are not in the note or a source.
        - Web search: only when the request needs evidence (guideline thresholds/COR·LOE, trials, recent data),
          up to 3 searches; cite what you use.

        FORMAT:
        - Bullets start with "- " with the full sentence on the SAME line.
        - Use ≥ and ≤; no LaTeX. Inside table cells: plain text, single line, no backticks.

        OUTPUT: only the full updated document, in Korean (standard English terms/abbreviations as usual).
        No preamble, no narration of your process, no remarks like "요청을 반영했습니다".
    `;
    content.push({ type: 'text', text: prompt });

    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        max_tokens: 24000
    });
    let summary = extractText(data);
    if (!summary) throw new Error('AI가 정리 결과를 돌려주지 않았습니다. 잠시 후 다시 시도해주세요.');
    // 지금 요약이 "###" 제목으로 시작하는데 결과 앞에 머리말이 붙었으면 첫 제목 앞을 잘라냄
    const firstHeading = summary.indexOf('###');
    if (params.currentSummary.trim().startsWith('###') && firstHeading > 0) summary = summary.slice(firstHeading);
    if (data?.stop_reason === 'max_tokens') {
        summary += '\n\n> 참고: 분량 제한으로 뒷부분이 잘렸을 수 있습니다. 요약 이력에서 이전 버전으로 되돌릴 수 있어요.';
    }
    return { summary, sources: mergeSources(extractCitations(data, 8), params.currentSources || []) };
};

// ----------------------------------------------------------------------------
// 질문 노트: 대화형 질문·답변 (스트리밍으로 답변이 써지는 대로 보여줌)
// - 이전 대화는 최근 것부터 THREAD_HISTORY_CHARS까지만 보냄 (긴 대화도 비용·속도 유지)
// - 근거가 필요한 질문은 웹 검색(최대 3회) 후 출처를 붙임
// 참고: https://docs.claude.com/en/docs/build-with-claude/streaming
// ----------------------------------------------------------------------------
export interface ThreadTurn { role: 'user' | 'assistant'; text: string; quote?: string; images?: string[] }

// 매번 함께 보내는 앞 대화 분량 (길수록 맥락은 좋지만 비용이 늘어남)
const THREAD_HISTORY_CHARS = 20000;
// 앞 대화를 줄일 때는 메시지 6개(약 3번의 질문·답) 단위로 잘라냄 — 한 개씩 밀어내면 매번 맨 앞이 바뀌어
// 프롬프트 캐시가 계속 깨짐. 이렇게 하면 몇 번의 질문 동안 앞부분이 그대로라 캐시를 다시 씀
const THREAD_TRIM_STEP = 6;
// 이전 대화의 사진은 최근 것만 다시 보냄 (매번 모든 사진을 보내면 비용·속도가 커짐)
const THREAD_MAX_IMAGES = 6;

const turnText = (t: ThreadTurn) => {
    const base = t.role === 'user' && t.quote
        ? `(이전 답변에서 이 부분을 짚어서 묻는 질문)\n"""${t.quote}"""\n\n${t.text}`
        : t.text;
    return base;
};

// 1시간 캐시: 답변을 읽고(5분은 금방 지남) 이어서 물어도 앞부분을 다시 0.1배로 읽음. 쓰기는 2배지만 질문마다 새로 붙는 부분에만 듦
const CACHE = { type: 'ephemeral', ttl: '1h' } as const;

// 대화 → API 메시지. 프롬프트 캐싱(같은 앞부분은 다음 질문 때 입력 요금의 0.1배로 읽음)을 위해
// - 모든 내용은 블록 배열로, 같은 대화면 요청마다 앞부분이 글자 하나까지 같게 만듦
// - 캐시 지점: 앞 대화의 마지막 메시지, 이번 질문(다음 요청에서는 앞 대화가 됨)
// - extraInstruction(빠른 모드 안내 등)은 이번 질문 뒤 별도 블록에 두고 캐시 지점 밖으로 (다음 요청의 앞부분과 달라지지 않게)
const buildThreadMessages = (history: ThreadTurn[], question: ThreadTurn, extraInstruction?: string): { role: 'user' | 'assistant'; content: any[] }[] => {
    // 넣을 수 있는 가장 앞 메시지(sMin)를 구한 뒤, 6개 단위로 올림해서 시작점을 고정
    let used = turnText(question).length;
    let sMin = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
        const len = turnText(history[i]).length;
        if (used + len > THREAD_HISTORY_CHARS) break;
        used += len;
        sMin = i;
    }
    const start = sMin === 0 ? 0 : Math.min(history.length, Math.ceil(sMin / THREAD_TRIM_STEP) * THREAD_TRIM_STEP);
    const picked = history.slice(start);
    const omitted = start > 0;

    // 사진: 이번 질문 것을 먼저, 남은 자리만큼 최근 질문 것부터
    let imageBudget = THREAD_MAX_IMAGES;
    const withImages = [...picked, question].map(t => ({ ...t, images: [] as string[], allImages: t.images || [] }));
    for (let i = withImages.length - 1; i >= 0 && imageBudget > 0; i--) {
        const t = withImages[i];
        if (t.role !== 'user' || !t.allImages.length) continue;
        t.images = t.allImages.slice(0, imageBudget);
        imageBudget -= t.images.length;
    }
    const blocksOf = (t: { role: string; text: string; quote?: string; images: string[]; allImages: string[] }): any[] => {
        let text = turnText(t as ThreadTurn);
        const dropped = t.allImages.length - t.images.length;
        if (dropped > 0) text = `(이 질문에 사진 ${t.allImages.length}장을 첨부했었음${t.images.length ? ` — 그중 ${t.images.length}장만 다시 보냄` : ''})\n${text}`;
        return [...t.images.map(img => imageBlock(img)), { type: 'text', text }];
    };
    // 번갈아 오도록 정리: 같은 역할이 연달아 오면 합치고(답이 없던 질문 등), 맨 앞은 user
    const merged: { role: 'user' | 'assistant'; content: any[] }[] = [];
    let questionMsg = -1, questionBlock = -1;
    withImages.forEach((t, idx) => {
        const last = merged[merged.length - 1];
        const blocks = blocksOf(t);
        if (last && last.role === t.role) last.content.push(...blocks);
        else merged.push({ role: t.role, content: blocks });
        if (idx === withImages.length - 1) {
            questionMsg = merged.length - 1;
            questionBlock = merged[questionMsg].content.length - 1;
        }
    });
    while (merged.length && merged[0].role !== 'user') { merged.shift(); questionMsg--; }
    if (omitted && merged.length) merged[0].content.unshift({ type: 'text', text: '(앞부분 대화는 길어서 생략됨)' });

    // 캐시 지점 표시 (복사본에만 — 위 블록 객체는 이 요청에서만 쓰임)
    const mark = (mi: number, bi: number) => {
        const m = merged[mi];
        if (!m || bi < 0 || bi >= m.content.length) return;
        m.content[bi] = { ...m.content[bi], cache_control: CACHE };
    };
    if (questionMsg >= 0) {
        const qm = merged[questionMsg];
        const qBlockIdx = questionBlock + (omitted && questionMsg === 0 ? 1 : 0);
        mark(questionMsg, qBlockIdx);
        if (questionMsg >= 1) mark(questionMsg - 1, merged[questionMsg - 1].content.length - 1);
        if (extraInstruction) qm.content.push({ type: 'text', text: extraInstruction });
    }
    return merged;
};

export type ThreadAnswerMode = 'full' | 'fast';
// 빠른 모드: 시스템 지시·검색 도구는 그대로 두고(캐시 유지) 이번 질문 뒤에만 붙이는 안내
// 짧게 쓰는 것만 줄이고 "검색 먼저"는 그대로 — 근거 없는 빠른 답은 쓰지 않음 (§5-61)
const FAST_MODE_NOTE = `(앱 설정 — 빠른 모드) 이번 답은 짧게: 핵심만 5~8줄.
- 짧아도 근거는 필수: 쓰기 전에 반드시 web_search를 1~3회 해서 이 답의 핵심 수치·권고·시험 결과를 확인하고, 그 검색 결과에서 인용해 쓸 것.
  검색 없이 기억만으로 답하지 말 것. 순수한 기전·정의만 묻는 질문이 아니면 검색을 건너뛰지 말 것.
- 출처를 붙이지 못한 수치·권고·시험 결과는 빼거나 "(출처 미확인)".`;

// 빠른 모드 답이 출처 하나 없이 사실 진술을 담고 돌아왔을 때 한 번 더 요청하며 붙이는 안내
const FAST_RETRY_NOTE = `(앱 확인) 직전 시도는 검색·출처 없이 답해서 앱이 받지 않았음. 이번에는 반드시 먼저 web_search로
핵심 수치·권고·시험 결과를 확인하고, 그 검색 결과에서 인용해 짧게 답할 것.`;

const THREAD_SYSTEM = `
    You are an attending-level colleague in a specialist medical discussion with the reader. The conversation is kept
    as their study notes and will be re-read and quizzed, so OBJECTIVE, VERIFIABLE EVIDENCE IS THE TOP PRIORITY —
    above completeness, above speed, above sounding fluent. An unsupported statement is worse than a missing one.
    ${READER_PROFILE}

    EVIDENCE FIRST (mandatory):
    1. Before writing, list for yourself every factual claim the answer will need: guideline recommendations (COR/LOE),
       diagnostic thresholds, drug doses/levels/interactions, contraindications, trial results (effect size, CI,
       event rates), epidemiology, assay or device behaviour, and anything the reader could act on.
    2. Search for them FIRST (up to 8 searches), with targeted queries — guideline name + year + topic, trial acronym,
       or "PubMed <drug> <effect>". Prefer, in order: current society guideline documents (ACC/AHA, ESC, HRS/EHRA,
       KSC, KDIGO, AASLD …) → the original trial/meta-analysis publication (NEJM, Lancet, JAMA, EHJ, JACC, Circulation,
       PubMed) → drug labels (FDA/EMA) → high-quality reviews. Never use blogs, forums, news or SEO health sites.
    3. Then write, and state each such claim ONLY from what you retrieved, so it carries a citation. In the sentence,
       name the source the way a specialist would: society + guideline + year + COR/LOE, or trial name + journal + year,
       or "FDA label".
    4. Before finishing, re-check every sentence that contains a number, threshold, dose, recommendation, contraindication
       or trial result. If it is not backed by a source you retrieved: search specifically for it. If you still find
       nothing, either drop the sentence (preferred when it is peripheral) or keep it only with "(출처 미확인)".
       "(출처 미확인)" is a last resort after a specific search — never a substitute for searching.
    5. Distinguish clearly: guideline recommendation vs trial finding vs expert opinion/consensus vs your own clinical
       reasoning (label the latter "임상적 추론"). Say when evidence is weak, observational, extrapolated or conflicting,
       and when guidelines (e.g. ACC/AHA vs ESC) disagree.
    6. Never invent numbers, trials, guideline classes or citations. If you are not sure of an exact value, say so.
    7. Do NOT write your own bracket numbers like [1] or a reference list — the app numbers the citations and lists
       the references automatically from your searches.
    - Pure mechanisms/definitions that are textbook-level may be explained without a search, but any specific number
      inside them still needs a source.

    HOW TO ANSWER:
    - Answer the question directly first (1~2 sentences), then the supporting evidence and detail a specialist needs —
      mechanism, thresholds/doses with units, COR/LOE and year, landmark trials with key results, practical pitfalls.
      Fellow/attending-level discussion; skip basics they obviously know. If the reader's premise is wrong or
      outdated, say so directly with the evidence.
    - When the question quotes part of an earlier answer, focus on exactly that part.
    - When photos are attached (ECG, EGM/intracardiac tracing, echo, angiogram, CT, lab table, slide, handwritten note),
      read them directly: describe what you actually see that matters, then answer. Say clearly when image quality or
      cropping limits the reading, and do not invent values that are not visible.
    - Format: Markdown. Use "###" for any headings (never "#" or "##"), bullets "- " with the full sentence on the same
      line, ≥/≤ instead of LaTeX. Tables are fine for comparisons (plain text cells).
    - Write in Korean with standard English medical terms/abbreviations, unless the reader writes in another language.
    - Output only the answer — no narration of your process ("검색해보겠습니다" etc.).
`;

// "근거 보강": 이미 받은 답변에서 출처가 없는 내용을 찾아 검색으로 근거를 붙여 다시 씀
export const THREAD_REINFORCE_INSTRUCTION = (answer: string) => `
(앱 요청 — 근거 보강) 위 질문에 대한 아래 답변에서 출처 없이 쓰인 사실 진술(수치·용량·농도·권고 등급·금기·임상시험 결과·
역학·검사/기기 특성 등)을 하나씩 찾아, 각각을 구체적으로 검색해 근거를 확인한 뒤 답변 전체를 다시 써줘.
- 근거가 확인된 진술은 출처를 붙여 그대로 두거나 근거에 맞게 고쳐.
- 근거와 다르면 근거대로 바로잡고, 무엇이 바뀌었는지 문장 안에서 짧게 밝혀.
- 검색해도 근거를 못 찾은 진술은 지엽적이면 빼고, 꼭 필요하면 "(출처 미확인)"을 붙여.
- 구성과 분량은 원래 답변과 비슷하게. 다시 쓴 답변 본문만 출력.

[원래 답변]
"""
${answer.replace(/\[(\d{1,2})\]/g, '')}
"""`;

type ThreadStreamParams = {
    history: ThreadTurn[];
    question: ThreadTurn;
    mode?: ThreadAnswerMode; // 기본 'full'(근거 중심)
    onText?: (textSoFar: string) => void;
    onStatus?: (status: 'searching' | 'writing' | 'recheck') => void;
    onSources?: (sources: Source[]) => void;
    signal?: AbortSignal;
};
type ThreadStreamResult = { text: string; sources: Source[]; truncated: boolean };

export const streamThreadAnswer = async (params: ThreadStreamParams): Promise<ThreadStreamResult> => {
    const fast = params.mode === 'fast';
    const first = await streamThreadOnce(params, fast ? FAST_MODE_NOTE : undefined);
    // 빠른 모드 안전장치: 수치·권고 같은 사실 진술이 있는데 출처가 하나도 없으면 검색을 요구하며 한 번만 다시 받음
    // (앞 대화·질문은 캐시에서 읽으므로 추가 비용은 대부분 짧은 답 한 번 + 검색)
    if (!fast || first.sources.length > 0 || first.truncated || params.signal?.aborted) return first;
    if (uncitedClaims(first.text).length === 0) return first;
    params.onStatus?.('recheck');
    params.onText?.('');
    params.onSources?.([]);
    try {
        const second = await streamThreadOnce(params, `${FAST_MODE_NOTE}\n\n${FAST_RETRY_NOTE}`);
        return second; // 화면에 이미 다시 받은 답이 흐르고 있으므로 그대로 씀
    } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        console.warn('빠른 답변 근거 재요청 실패 — 첫 답변을 씀', e);
        return first;
    }
};

const streamThreadOnce = async (params: ThreadStreamParams, extraInstruction?: string): Promise<ThreadStreamResult> => {
    const apiKey = getApiKey();
    const fast = params.mode === 'fast';
    const body: Record<string, any> = {
        model: MODEL_SMART,
        max_tokens: fast ? 16000 : 32000,
        // 시스템 지시는 모든 질문에서 같으므로 캐시 (대화가 달라도 이 부분은 0.1배로 읽음)
        system: [{ type: 'text', text: THREAD_SYSTEM, cache_control: CACHE }],
        messages: buildThreadMessages(params.history, params.question, extraInstruction),
        // 검색 도구 정의는 두 모드 모두 같게 (바뀌면 캐시 전체가 무효). 빠른 모드의 검색 횟수는 안내문으로 제한
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
        stream: true
    };
    // 빠른 모드는 생각 깊이 medium (근거 중심은 기본값 high). low는 검색을 아예 건너뛰는 일이 잦아 근거 없는 답이 나왔음 (§5-61)
    // 모드를 바꾸면 그 대화의 캐시는 한 번 새로 씀
    if (fast) body.output_config = { effort: 'medium' };
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body),
        signal: params.signal
    });
    if (!response.ok || !response.body) {
        let errBody: any = null;
        try { errBody = await response.json(); } catch { /* ignore */ }
        const errType = errBody?.error?.type || '';
        const errMsg = errBody?.error?.message || response.statusText;
        if (response.status === 429 || errType === 'rate_limit_error') throw new Error(`Quota exceeded (429): ${errMsg}`);
        throw new Error(`Claude API error (${response.status} ${errType}): ${errMsg}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const blockTypes = new Map<number, string>();
    // 출처 번호: 처음 인용된 순서대로 1, 2, 3 … (같은 주소는 같은 번호)
    const sources = new Map<string, Source & { n: number }>();
    const blockCites = new Map<number, Set<number>>(); // 글 조각 → 그 조각이 인용한 출처 번호들
    let text = '';
    let stopReason = '';
    let buf = '';
    let lastStartedType = '';

    const handle = (evt: any) => {
        switch (evt?.type) {
            case 'content_block_start': {
                const type = evt.content_block?.type || '';
                blockTypes.set(evt.index, type);
                if (type === 'server_tool_use') params.onStatus?.('searching');
                if (type === 'text') {
                    // 검색 앞뒤로 나뉜 글은 문단을 띄워 이어 붙임 (인용 때문에 쪼개진 글 조각은 그대로 붙임)
                    if (text && lastStartedType && lastStartedType !== 'text' && !text.endsWith('\n\n')) text += '\n\n';
                    params.onStatus?.('writing');
                }
                lastStartedType = type;
                break;
            }
            case 'content_block_delta': {
                const d = evt.delta || {};
                if (d.type === 'text_delta' && blockTypes.get(evt.index) === 'text') {
                    text += d.text || '';
                    params.onText?.(text);
                } else if (d.type === 'citations_delta' && d.citation?.url) {
                    const c = d.citation;
                    let src = sources.get(c.url);
                    if (!src) {
                        src = { n: sources.size + 1, title: (c.title || c.url).trim(), uri: c.url };
                        sources.set(c.url, src);
                    }
                    const excerpt = typeof c.cited_text === 'string' ? c.cited_text.replace(/\s+/g, ' ').trim() : '';
                    if (excerpt && !src.snippet) src.snippet = excerpt.length > 220 ? excerpt.slice(0, 220) + '…' : excerpt;
                    const set = blockCites.get(evt.index) || new Set<number>();
                    set.add(src.n);
                    blockCites.set(evt.index, set);
                    params.onSources?.(Array.from(sources.values()).map(({ n, ...s }) => s));
                }
                break;
            }
            case 'content_block_stop': {
                // 인용이 붙은 글 조각이 끝나면 그 뒤에 출처 번호 [n]을 붙임 (끝의 줄바꿈 앞에)
                const nums = blockCites.get(evt.index);
                if (nums && nums.size) {
                    const marker = Array.from(nums).sort((a, b) => a - b).map(n => `[${n}]`).join('');
                    const m = /(\s*)$/.exec(text);
                    const tail = m ? m[1] : '';
                    text = text.slice(0, text.length - tail.length) + marker + tail;
                    params.onText?.(text);
                }
                break;
            }
            case 'message_delta':
                if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
                break;
            case 'error':
                throw new Error(`Claude API error (stream): ${evt.error?.message || evt.error?.type || 'unknown'}`);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
            if (!data) continue;
            let evt: any;
            try { evt = JSON.parse(data); } catch { continue; }
            handle(evt);
        }
    }

    if (stopReason === 'refusal') throw new Error('Safety: content blocked by the model (refusal)');
    text = text.trim();
    if (!text) {
        throw new Error(stopReason === 'max_tokens'
            ? '답변을 쓰기 전에 분량 한도에 걸렸습니다. 질문을 조금 좁혀서 다시 시도해주세요.'
            : 'AI가 답변을 돌려주지 않았습니다. 잠시 후 다시 시도해주세요.');
    }
    const truncated = stopReason === 'max_tokens' || stopReason === 'pause_turn';
    if (truncated) text += '\n\n> 참고: 답변이 중간에 끊겼습니다. "이어서 설명해줘"라고 물어보면 이어집니다.';
    // 번호 순서 그대로 (번호와 목록이 어긋나지 않게 자르지 않음)
    const list = Array.from(sources.values()).sort((a, b) => a.n - b.n).map(({ n, ...s }) => s);
    return { text, sources: list, truncated };
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
// dateMode 'updated': 각 메모에 마지막 수정 날짜를 붙임(인계장처럼 최신 내용을 가려야 할 때)
// labelNumbers: [메모N]의 N을 순서대로가 아니라 지정한 번호로 붙일 때 (인계장처럼 번호가 계속 유지돼야 할 때)
// 여러 메모를 AI에 보낼 때 메모 하나의 본문 (질문 노트는 표시 주석을 빼고 "Q. / A." 글로)
const noteBodyForAI = (n: Note): string => n.kind === 'thread' ? threadPlainText(n.content || '') : [
    n.content || '',
    n.transcription ? `(사진에서 추출한 텍스트: ${n.transcription})` : '',
    n.summary ? `(이전에 만든 AI 요약: ${n.summary})` : ''
].filter(Boolean).join('\n');

const buildNotesContext = (notes: Note[], perNoteChars: number, totalChars: number, dateMode: 'created' | 'updated' = 'created', labelNumbers?: number[]): string => {
    let used = 0;
    const parts: string[] = [];
    notes.forEach((n, i) => {
        if (used >= totalChars) return;
        const date = dateMode === 'updated'
            ? `마지막 수정 ${new Date(n.updatedAt || n.createdAt).toLocaleDateString('ko-KR')}`
            : new Date(n.createdAt).toLocaleDateString('ko-KR');
        const isThreadNote = n.kind === 'thread';
        const body = noteBodyForAI(n);
        const budget = Math.min(perNoteChars, totalChars - used);
        // 앱이 분량 때문에 자른 것임을 분명히 해서, AI가 "메모가 중간에 끊겼다"고 지적하지 않게 함
        const clipped = body.length > budget ? body.slice(0, budget) + '\n…(앱이 분량 제한으로 여기까지만 보냄 — 원래 메모에는 내용이 더 있음. 메모가 끊겼다고 지적하지 말 것)' : body;
        used += clipped.length;
        parts.push(`[메모${labelNumbers?.[i] ?? i + 1}] ${isThreadNote ? '(질문 노트 — 독자가 묻고 AI가 답한 대화) ' : ''}${n.title || '제목 없음'} (${date})\n${clipped}`);
    });
    return parts.join('\n\n=====\n\n');
};

// buildNotesContext가 글자 수 한도 안에 실제로 담는 메모만 남김 (화면의 "참고한 메모"와 AI가 본 메모를 일치시키기 위함)
export const notesWithinContextBudget = (notes: Note[], perNoteChars: number, totalChars: number): Note[] => {
    let used = 0;
    const out: Note[] = [];
    for (const n of notes) {
        if (used >= totalChars) break;
        const len = noteBodyForAI(n).length;
        const budget = Math.min(perNoteChars, totalChars - used);
        used += len > budget ? budget + 80 : len;
        out.push(n);
    }
    return out;
};

// 메모 활용 도구별 글자 수 한도 [메모당, 전체]
export const CONTEXT_BUDGETS = {
    weekly: [2500, 50000],
    gap: [5000, 60000],
    template: [30000, 90000],
    synthesize: [8000, 70000],
    handover: [5000, 90000]
} as const;

// 답이 분량 한도에서 잘렸으면 안내 문구를 붙임
const withTruncationNotice = (text: string, data: any): string =>
    data?.stop_reason === 'max_tokens'
        ? `${text}\n\n> 참고: 분량 한도에 걸려 뒷부분이 잘렸을 수 있습니다. 참고할 메모를 줄여서 다시 만들어보세요.`
        : text;

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
- If notes contradict each other, or a note looks outdated / guideline-discordant, flag it with a leading "**주의**".
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
        ${buildNotesContext(notes, CONTEXT_BUDGETS.synthesize[0], CONTEXT_BUDGETS.synthesize[1])}
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
    return withTruncationNotice(text, data);
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
// 문제 하나 = 메모 하나의 "구역" 하나 (services/quizCoverage.ts).
// 예전엔 메모 3개를 합쳐 5,400자만 보내서 긴 메모의 뒷부분·AI 요약은 거의 출제되지 않았습니다.
// 이제 앱이 아직 덜 나온 구역을 골라 그 구역 전체를 보내고, 이미 낸 요점은 피하게 합니다.
export interface QuizFocus {
    note: Note; // 사진은 빼고 넘겨도 됨 (사진 구역이면 image로 따로 전달)
    part: { key: string; kind: 'note' | 'imageText' | 'summary' | 'image'; label: string; text: string };
    partIndex: number; // 0부터
    partCount: number;
    outline: string[]; // 메모 전체 구역 이름 (맥락용)
    askedTopics: string[]; // 이 구역에서 이미 낸 요점
    image?: string; // 사진 구역일 때 그 사진
}

const PART_KIND_NOTES: Record<QuizFocus['part']['kind'], string> = {
    note: "This part is the reader's own writing.",
    imageText: 'This part is text the app extracted from photos attached to the note.',
    summary: "This part is the AI-written summary attached to the note (it may contain guideline information found by web search). Test it like the reader's own content.",
    image: 'This part is the attached photo (the image above) (figure, ECG, table, slide, handwritten note…). Base the question on what the photo shows.'
};

const buildFocusContext = (f: QuizFocus): string => {
    const asked = f.askedTopics.filter(Boolean);
    return `
            NOTE TITLE: ${f.note.title || 'Untitled'}
            SECTIONS OF THIS NOTE (for context only): ${f.outline.slice(0, 40).join(' / ') || '(one section)'}

            FOCUS PART — "${f.part.label}" (part ${f.partIndex + 1} of ${f.partCount}). ${PART_KIND_NOTES[f.part.kind]}
            """${f.part.text || (f.part.kind === 'image' ? '(no extracted text — use the attached photo)' : '')}"""
            ${asked.length ? `\n            POINTS FROM THIS PART ALREADY TESTED (choose a DIFFERENT point; only if every point is used, re-test the most important one from a new angle):\n${asked.map(t => `            - ${t}`).join('\n')}\n` : ''}
            COVERAGE RULES:
            - The question MUST test a specific point that is stated in the FOCUS PART (a fact, threshold, mechanism,
              step, or judgment written there) — not general knowledge that the part does not contain.
            - Prefer a point not tested before; across many questions the reader wants every part of the note covered.
            - In "topic", name the exact point you tested in ≤ 12 words, in Korean (e.g. "AF 지속 시 CHA2DS2-VASc 기준 항응고").`;
};

const focusImageBlocks = (f: QuizFocus): any[] => (f.image ? [imageBlock(f.image)] : []);

const coverageOf = (f: QuizFocus, topic: any): QuizQuestion['coverage'] => ({
    noteId: f.note.id,
    partKey: f.part.key,
    partLabel: f.part.label,
    partIndex: f.partIndex,
    partCount: f.partCount,
    topic: typeof topic === 'string' ? topic.trim().slice(0, 80) : undefined
});

export const generateMedicalQuiz = async (focus: QuizFocus, language: QuizLanguage = 'Korean'): Promise<QuizQuestion | null> => {
    try {
        const content: any[] = focusImageBlocks(focus);

        const prompt = `
            You are an attending physician writing subspecialty board-level questions.
            ${READER_PROFILE}
            Create ONE high-quality multiple choice question from the FOCUS PART of the reader's own note below.

            QUESTION LEVEL:
            - For cardiology content: cardiovascular disease subspecialty board / fellowship in-training exam level
              (EP and interventional items at the depth expected of a fellow in those areas).
            - For non-cardiology content: internal medicine board level, written for an attending.
            - Test application and judgment, not recall: a clinical vignette with the data an expert would use
              (ECG/EGM findings, echo or hemodynamic values, device parameters, labs) and a decision to make.
              If the point is a plain fact (a definition, a list, a procedural step), still frame it in a short
              clinical context where possible.
            - Distractors must be plausible choices that a less experienced physician would pick
              (e.g. an outdated threshold, the right drug in the wrong setting, a correct step in the wrong order).
            - The keyed answer must be unambiguously correct under current major guidelines; avoid items where
              experts genuinely disagree. If the note itself is outdated on this point, key the CURRENT answer and
              say in the explanation that the note differs.
            - **Output Language: ${language}** (The question, options, and explanation MUST be written in ${language}).
            ${buildFocusContext(focus)}

            Task:
            1. Create a challenging clinical scenario testing one point of the FOCUS PART.
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
                    topic: { type: 'string', description: 'The exact point from the focus part this question tests (≤ 12 words, Korean).' },
                    sources: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { title: { type: 'string' }, uri: { type: 'string' } },
                            required: ['title', 'uri']
                        }
                    }
                },
                required: ['question', 'options', 'correctAnswerIndex', 'explanation', 'topic']
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
            relatedNoteIds: [focus.note.id],
            coverage: coverageOf(focus, input.topic)
        };

    } catch (error) {
        if ((error as Error).message === "Aborted by user") throw error;
        console.error("Quiz Gen Failed", error);
        return null;
    }
};

export const generateOXQuiz = async (focus: QuizFocus, language: QuizLanguage = 'Korean'): Promise<QuizQuestion | null> => {
    try {
        const content: any[] = focusImageBlocks(focus);
        const targetAnswerIsTrue = Math.random() < 0.5;

        const prompt = `
            ${READER_PROFILE}
            Create a single "True or False" statement for a quick review quiz from the FOCUS PART of the reader's own
            note below, pitched at the reader's level above.
            The statement must be unambiguously true or false under current major guidelines — avoid points where experts genuinely disagree.
            ${focus.image ? `
            CRITICAL VISUAL ANALYSIS INSTRUCTION:
            - Analyze the attached photo itself (charts, ECG, histology, diagrams, tables) — do not rely only on the extracted text.` : ''}

            - **You MUST generate a statement that is ${targetAnswerIsTrue ? "TRUE" : "FALSE"}**. This is a strict requirement for balance.
            - **Output Language: ${language}** (The statement and explanation MUST be written in ${language}).
            ${buildFocusContext(focus)}

            Instructions:
            - Create ONE statement about one point of the FOCUS PART.
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
                    explanation: { type: 'string' },
                    topic: { type: 'string', description: 'The exact point from the focus part this statement tests (≤ 12 words, Korean).' }
                },
                required: ['question', 'isTrue', 'explanation', 'topic']
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
            relatedNoteIds: [focus.note.id],
            coverage: coverageOf(focus, input.topic)
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

// ----------------------------------------------------------------------------
// 저널클럽 준비: 메모에 붙여넣은 논문 초록/본문 → 비판적 평가 + 예상 질문
// - 결과는 메모의 요약 칸에 저장됩니다(summaryKind: 'journal'). "내 메모에 물어보기"가
//   메모 요약도 함께 읽으므로, 나중에 여러 논문을 서로 연결해 물어볼 수 있습니다.
// ----------------------------------------------------------------------------
export const JOURNAL_MAX_INPUT_CHARS = 120000;

export const analyzeJournalArticle = async (note: Note): Promise<{ summary: string; sources: Source[] } | null> => {
    try {
        const content: any[] = [];
        (note.images || []).slice(0, 8).forEach(img => content.push(imageBlock(img)));

        const raw = [note.content || '', note.transcription ? `(사진에서 추출한 텍스트)\n${note.transcription}` : '']
            .filter(Boolean).join('\n\n');
        const isTruncated = raw.length > JOURNAL_MAX_INPUT_CHARS;
        const text = raw.substring(0, JOURNAL_MAX_INPUT_CHARS);

        const prompt = `
            You help the reader prepare a journal club presentation in a cardiology fellowship program.
            ${READER_PROFILE}

            THE PAPER (pasted by the reader — may be only the abstract, or the full text, or photos of pages):
            """${text || '(no text — use the attached images)'}"""
            ${isTruncated ? `(The text was cut after ${JOURNAL_MAX_INPUT_CHARS} characters.)` : ''}

            First decide how much you have: ABSTRACT ONLY vs FULL TEXT. With only an abstract, say so as the last
            line of the first section and mark any appraisal point that needs the full text as "(본문 확인 필요)".
            NEVER invent numbers that are not in the text. If the paper cannot be identified from the text,
            say so instead of guessing.

            Use web search (up to 5 searches) to identify the paper (journal, year) and to place it among prior
            trials and current guidelines. Cite what you use.

            Write in Korean (standard English terms/abbreviations as usual), with these "###" sections in order:
            ### 한 줄 결론
              What the study found and how much it should change practice, in 1~2 sentences.
            ### 연구 질문 · 설계
              - PICO (population with key inclusion/exclusion, intervention, comparator, primary outcome)
              - Design (RCT/observational/meta-analysis, blinding, allocation concealment, superiority vs
                non-inferiority with the margin), sample size, follow-up, funding/sponsor if stated.
            ### 핵심 결과
              - Primary endpoint with effect size and 95% CI (HR/RR/OR) and absolute event rates.
              - ARR and NNT (or ARI and NNH) — ONLY when absolute rates are given; show the arithmetic
                in one line (e.g. "ARR = 12.1% − 9.8% = 2.3% → NNT ≈ 44 (중앙 추적 2.1년)").
              - Key secondary and safety endpoints. Keep it to what matters.
              - A compact table is fine for endpoints (cells single-line, no backticks).
            ### 비뚤림 위험 · 한계
              Walk through the relevant issues as bullets: randomization/concealment, blinding and outcome
              adjudication, attrition and ITT vs per-protocol, early stopping, composite endpoint driven by a soft
              component, surrogate endpoints, multiplicity/subgroups, crossover, generalizability of the
              control arm (e.g. suboptimal GDMT), industry sponsorship. For a meta-analysis: heterogeneity,
              study quality, publication bias. End with an overall judgment (low / some concerns / high).
            ### 적용 가능성
              Who in our practice this applies to and who it doesn't (age, comorbidity, Asian/Korean patients,
              device/procedure availability, reimbursement if clearly relevant).
            ### 기존 연구 · 가이드라인과의 관계
              How it fits with the landmark prior trials (name them with year and one-line result) and what
              current guidelines (ACC/AHA, ESC, HRS, KSC as relevant; give the year and COR/LOE) say — does
              this paper support, extend, or contradict them? If it was published after the latest guideline,
              say what could change.
            ### 예상 질문 & 답변
              6~8 questions an attending is likely to ask at journal club (methodology, statistics, clinical
              application, "would you change practice?", comparison with trial X), each as
              "- **Q.** question" followed by "  - **A.** concise model answer (2~4 sentences)".
            ### 발표 포인트
              3 bullets: what to emphasize on slides.

            FORMAT: bullets "- " with the full sentence on the same line. Use ≥/≤, no LaTeX.
            OUTPUT: start directly with "### 한 줄 결론" — no narration of your process, no preamble.
        `;
        content.push({ type: 'text', text: prompt });

        const data = await callClaude({
            model: MODEL_SMART,
            messages: [{ role: 'user', content }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
            max_tokens: 24000
        });
        let summary = extractText(data);
        if (!summary) return null;
        // 검색 전에 모델이 붙인 머리말("먼저 찾아보겠습니다" 등)은 첫 섹션 제목 앞에서 잘라냄
        const firstHeading = summary.indexOf('###');
        if (firstHeading > 0) summary = summary.slice(firstHeading);
        if (data?.stop_reason === 'max_tokens') {
            summary += '\n\n> 참고: 분량 제한으로 뒷부분이 잘렸을 수 있습니다. "저널클럽 분석 다시 하기"로 다시 만들 수 있어요.';
        }
        return { summary, sources: extractCitations(data, 8) };
    } catch (error) {
        console.error("Journal club analysis failed", error);
        return null;
    }
};

// ----------------------------------------------------------------------------
// 오래된 메모 가이드라인 점검: 메모의 수치·권고가 지금도 맞는지 최신 가이드라인과 비교
// - 결과 첫 줄의 STATUS 표시로 상태(변경/일치/불확실)를 읽고, 나머지는 보고서로 저장합니다.
// ----------------------------------------------------------------------------
export const parseGuidelineStatus = (raw: string): { status: GuidelineCheck['status']; report: string } => {
    const text = (raw || '').trim();
    // 웹 검색 전에 모델이 한두 문장을 먼저 쓰는 경우가 있어, 맨 앞이 아니어도 STATUS 줄을 찾고
    // 그 앞의 글은 버립니다.
    // (검색 결과 블록 사이 텍스트가 줄바꿈 없이 붙어 "…하겠습니다.STATUS: CHANGED"가 될 수 있어 줄 시작을 요구하지 않음)
    const m = /[*_#]*\bSTATUS[ \t*_]*[:：][ \t*_]*(CHANGED|OK|UNCERTAIN)\b[^\n]*(?:\n|$)/i.exec(text);
    if (!m) return { status: 'uncertain', report: text };
    const key = m[1].toUpperCase();
    const status: GuidelineCheck['status'] = key === 'CHANGED' ? 'changed' : key === 'OK' ? 'ok' : 'uncertain';
    return { status, report: text.slice(m.index + m[0].length).trim() };
};

export const checkNoteAgainstGuidelines = async (note: Note): Promise<GuidelineCheck> => {
    const written = new Date(note.updatedAt || note.createdAt).toLocaleDateString('ko-KR');
    const today = new Date().toLocaleDateString('ko-KR');
    const raw = [note.content || '', note.transcription ? `(사진에서 추출한 텍스트)\n${note.transcription}` : '']
        .filter(Boolean).join('\n\n').substring(0, 30000);

    const prompt = `
        You check whether an older study note of the reader is still consistent with CURRENT guidelines and evidence.
        ${READER_PROFILE}

        The note was last edited on ${written}. Today is ${today}.
        NOTE TITLE: ${note.title || '(untitled)'}
        NOTE:
        """${raw}"""

        STEPS:
        1. Pick out the specific, checkable claims: numeric thresholds and cut-offs, targets, drug doses,
           durations (e.g. DAPT), indications/contraindications, class of recommendation / level of evidence,
           and conclusions attributed to trials. Ignore vague or purely descriptive statements.
        2. Use web search (up to 5 searches) to find the most recent applicable guideline or focused update
           (ACC/AHA, ESC, HRS/EHRA, ASE, KSC, KDIGO, ADA ... as relevant) and pivotal newer trials.
        3. Compare each claim with what is current.

        OUTPUT FORMAT (STRICT):
        - The FIRST line must be exactly one of:
          "STATUS: CHANGED"   — at least one claim is now outdated or wrong
          "STATUS: OK"        — the checkable claims are still current
          "STATUS: UNCERTAIN" — couldn't verify the key claims (not enough checkable content, or no clear source)
        - Then, in Korean (standard English terms as usual):
          One line with the bottom line.
          ### 바뀐 내용
            One bullet per changed claim: "- **메모**: (what the note says, briefly quoted) → **현재**: (what
            is recommended now) — (guideline/trial name, year, COR/LOE if applicable)". Omit this section if none.
          ### 지금도 맞는 내용
            Short bullets; group minor items together.
          ### 확인하지 못한 것
            Only if relevant.
        - Be concise (roughly up to 1,500 Korean characters). Bullets "- " with the sentence on the same line.
        - Output only the result — no narration of your process.
    `;

    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        max_tokens: 4000
    });
    const text = extractText(data);
    if (!text) throw new Error('점검 결과가 비어 있습니다.');
    const { status, report } = parseGuidelineStatus(text);
    return { checkedAt: Date.now(), status, report, sources: extractCitations(data, 6) };
};

// ============================================================================
// 메모 활용 화면 (쌓인 메모를 다시 쓰는 도구들)
// ============================================================================

// ---- 이번 주 돌아보기 (빠른 모델) ----
export const generateWeeklyDigest = async (
    notes: Note[],
    extra: { days: number; dueCount: number; wrongQuestions: { question: string; explanation?: string }[] }
): Promise<string> => {
    const wrongText = extra.wrongQuestions.slice(0, 10).map((w, i) =>
        `${i + 1}. ${w.question.slice(0, 300)}${w.explanation ? `\n   해설: ${w.explanation.slice(0, 300)}` : ''}`
    ).join('\n');
    const prompt = `
        You write a short weekly review of the reader's own study/work notes.
        ${READER_PROFILE}

        NOTES WRITTEN OR EDITED IN THE LAST ${extra.days} DAYS (labelled [메모1], [메모2], ...):
        """
        ${buildNotesContext(notes, CONTEXT_BUDGETS.weekly[0], CONTEXT_BUDGETS.weekly[1])}
        """
        QUIZ QUESTIONS THE READER GOT WRONG THIS WEEK:
        """
        ${wrongText || '(none)'}
        """
        Notes due for spaced review today: ${extra.dueCount}
        Items marked "(질문 노트 …)" are Q&A conversations: the questions show what the reader was curious about this
        week; treat the answers' key points as what they learned, and note open questions worth following up.

        Write in Korean (standard English terms as usual) with these "###" sections:
        ### 이번 주 한눈에
          1~2 sentences: how many notes, what themes.
        ### 핵심 정리
          Group by theme; per theme 1~3 bullets with the most important concrete points (numbers, thresholds,
          decisions) and their citations.
        ### 서로 이어지는 점
          1~3 bullets connecting notes to each other (e.g. a case note that illustrates a guideline note). Skip if none.
        ### 다시 볼 것
          Weak spots from the wrong answers, and anything in the notes that looks uncertain or guideline-discordant (marked "**주의**").
        ### 다음 주 제안
          2~3 concrete things to study or check next, each with one line on why.
        Keep it under ~1,500 Korean characters. Bullets "- " with the sentence on the same line.
        ${NOTE_CITATION_RULES}
        OUTPUT: only the review itself.
    `;
    const data = await callClaude({
        model: MODEL_FAST,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 3000
    });
    const text = extractText(data);
    if (!text) throw new Error('돌아보기 결과가 비어 있습니다.');
    return withTruncationNotice(text, data);
};

// ---- 빈 곳 찾기: 주제의 표준 목차와 내 메모 비교 ----
export const findCoverageGaps = async (topic: string, notes: Note[]): Promise<{ text: string; sources: Source[] }> => {
    const prompt = `
        You compare what the reader's notes cover against the standard structure of a topic, to find gaps.
        ${READER_PROFILE}

        TOPIC: """${topic}"""

        THE READER'S NOTES THAT SEEM RELATED (labelled [메모1], [메모2], ...; some may be unrelated — ignore those):
        """
        ${notes.length > 0 ? buildNotesContext(notes, CONTEXT_BUDGETS.gap[0], CONTEXT_BUDGETS.gap[1]) : '(no related notes found)'}
        """

        STEPS:
        1. Build the reference outline of the topic: if the topic names a guideline, use that guideline's actual
           section structure (search to confirm the current version and year). Otherwise use the structure of the
           most relevant current major guideline or a standard review. Use web search (up to 4 searches).
           8~15 items, at the level of clinically meaningful subsections (e.g. "Stroke risk assessment",
           "OAC choice & dosing", "Rhythm control — ablation indications").
        2. For each item, judge how well the notes cover it: **충분** / **일부** / **없음** (write the word, no symbols).

        OUTPUT (Korean, standard English terms as usual):
        - First line: "기준: (guideline/source name, year)".
        - ### 항목별 현황
          A markdown table: | 항목 | 상태 | 내 메모 | 비고 |  — "내 메모" lists the citations; "비고" says briefly
          what is covered or what is missing (one line, plain text, no backticks).
        - ### 먼저 채울 곳
          3~5 bullets, most important first: what to add, the key numbers/recommendations (with COR/LOE) worth
          writing down, and why it matters clinically.
        ${NOTE_CITATION_RULES}
        Output only the result — no narration of your process.
    `;
    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        max_tokens: 6000
    });
    let text = extractText(data);
    if (!text) throw new Error('빈 곳 찾기 결과가 비어 있습니다.');
    const start = text.indexOf('기준:');
    if (start > 0 && start < 400) text = text.slice(start);
    return { text: withTruncationNotice(text, data), sources: extractCitations(data, 6) };
};

// ---- 작성 템플릿: 붙여넣은 판독문·시술기록에서 실제로 쓸 수 있는 틀 만들기 ----
export const buildDocumentationTemplate = async (target: string, notes: Note[]): Promise<string> => {
    const prompt = `
        The reader has pasted real clinical documentation written by experienced physicians (reading reports,
        procedure records, progress notes...). Build a reusable WRITING TEMPLATE from them.
        ${READER_PROFILE}

        WHAT THE TEMPLATE IS FOR: """${target || '(not specified — infer the most common document type in the notes)'}"""

        SOURCE NOTES (labelled [메모1], [메모2], ...):
        """
        ${buildNotesContext(notes, CONTEXT_BUDGETS.template[0], CONTEXT_BUDGETS.template[1])}
        """

        OUTPUT (Korean prose; keep the documents' own language mix inside the template):
        ### 언제 쓰는 틀인지
          One or two lines.
        ### 템플릿
          ONE fenced code block (\`\`\`text ... \`\`\`) containing the template exactly as it would be written,
          in the usual order of items, with the wording the records actually use. Put blanks as [ ] with a short hint,
          e.g. "LVEF [  ]%", "AV Vmax [  ] m/s, mean PG [  ] mmHg". Include typical optional lines as
          "(해당 시) ...". No patient identifiers.
        ### 항목별 작성 요령
          Bullets per item: which values are always reported, typical phrasing variants QUOTED VERBATIM from the
          records (with citations), and how severity/conclusion sentences are usually formed.
        ### 자주 빠뜨리는 것
          2~5 bullets (items present in some records but missing in others, or guideline-relevant items worth adding).
        If the notes contain several different document types, build the template for the one that matches the
        target best and mention the others in one line at the end.
        ${NOTE_CITATION_RULES}
        Output only the result.
    `;
    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 9000
    });
    const text = extractText(data);
    if (!text) throw new Error('템플릿 결과가 비어 있습니다.');
    return withTruncationNotice(text, data);
};

// ---- 케이스·시술 기록: 환자 메모에서 시술·진단·배운 점을 구조화해서 뽑기 (빠른 모델, 10개씩) ----
export const extractCaseLogBatch = async (
    notes: Note[]
): Promise<{ index: number; procedures: string[]; diagnoses: string[]; memorable: boolean; learningPoint: string }[]> => {
    const context = notes.map((n, i) => {
        const body = [n.content || '', n.transcription ? `(사진 텍스트: ${n.transcription})` : '', n.summary ? `(AI 요약: ${n.summary})` : '']
            .filter(Boolean).join('\n');
        return `[Note ${i + 1}] ${n.title || ''} (${new Date(n.createdAt).toLocaleDateString('ko-KR')})\n${body.slice(0, 2500)}`;
    }).join('\n\n=====\n\n');

    const prompt = `
        These are a cardiology fellow's own notes about individual patients. For EACH note, extract:
        - procedures: procedures actually PERFORMED on this patient that are mentioned in the note (not ones only
          considered or planned). Use short canonical English names, consistently, e.g. "CAG", "PCI",
          "CTO PCI", "TAVR", "AF ablation (PVI)", "AFL ablation (CTI)", "PSVT ablation", "VT ablation",
          "EPS", "PPM implantation", "ICD implantation", "CRT-D implantation", "Leadless PPM", "LAAO",
          "TEE", "TTE", "Pericardiocentesis", "IABP", "ECMO", "Temporary pacing", "Cardioversion", "RHC".
          Add the specific type in parentheses only when stated (e.g. "PPM implantation (LBBAP)").
        - diagnoses: main diagnoses of this patient, short canonical English (e.g. "STEMI", "NSTEMI",
          "Severe AS", "HFrEF", "Persistent AF", "Complete AV block", "VT storm").
        - memorable: true only if the case has a clear learning point (complication, unusual presentation,
          rare diagnosis, difficult decision, instructive pitfall).
        - learningPoint: if memorable, ONE Korean sentence (English terms as usual) stating the learning point;
          otherwise "".
        Return one entry per note, using its number. If a note has nothing, return empty lists.

        NOTES:
        """
        ${context}
        """
    `;
    const input = await callForJson({
        model: MODEL_FAST,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        toolName: 'submit_case_log',
        toolDescription: 'Submit the extracted procedures, diagnoses and learning points for each note.',
        schema: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            note_number: { type: 'integer', minimum: 1 },
                            procedures: { type: 'array', items: { type: 'string' } },
                            diagnoses: { type: 'array', items: { type: 'string' } },
                            memorable: { type: 'boolean' },
                            learningPoint: { type: 'string' }
                        },
                        required: ['note_number', 'procedures', 'diagnoses', 'memorable', 'learningPoint']
                    }
                }
            },
            required: ['items']
        },
        maxTokens: 4000
    });
    const items = Array.isArray(input?.items) ? input.items : [];
    return items
        .filter((it: any) => Number.isInteger(it?.note_number) && it.note_number >= 1 && it.note_number <= notes.length)
        .map((it: any) => ({
            index: it.note_number - 1,
            procedures: Array.isArray(it.procedures) ? it.procedures.filter((x: any) => typeof x === 'string') : [],
            diagnoses: Array.isArray(it.diagnoses) ? it.diagnoses.filter((x: any) => typeof x === 'string') : [],
            memorable: !!it.memorable,
            learningPoint: typeof it.learningPoint === 'string' ? it.learningPoint : ''
        }));
};

// ---- 인계장: '업무' 메모로 만든 인계장 문서를 새로 만들거나, 바뀐 메모만 반영해 갱신 ----
// - [메모N] 번호는 인계장마다 고정(한 번 붙은 번호는 계속 같은 메모)이라, 갱신할 때 새/수정 메모만 보내도
//   기존 항목의 인용이 그대로 맞습니다.
// 인계장에 보낼 메모 조각. 메모는 자르지 않고 통째로 보내되, 아주 긴 메모만 여러 조각(part)으로 나눔
export interface HandoverItem {
    label: number;   // 고정 번호 [메모N]
    title: string;
    date: number;    // 마지막 수정 시각
    text: string;    // 메모 본문(해당 조각)
    part: number;    // 1부터
    parts: number;   // 전체 조각 수
}

export const updateHandoverDocument = async (params: {
    current: string;            // 지금 인계장 (처음이면 '')
    items: HandoverItem[];      // 이번에 반영할 새/수정 업무 메모(또는 그 조각)
    modifiedLabels: number[];   // 그중 "수정된" 메모의 번호 (예전 항목을 새 내용으로 바꿔야 함)
    removedLabels: number[];    // 삭제됐거나 업무 분류가 풀린 메모의 번호 (그 메모만 근거인 항목은 삭제)
    purpose: string;
    purposeChanged?: boolean;   // 용도·받는 사람이 바뀜 → 분류 순서·"한눈에"를 새 용도에 맞게
}): Promise<string> => {
    const { current, items, modifiedLabels, removedLabels, purpose, purposeChanged } = params;
    const today = new Date().toLocaleDateString('ko-KR');
    const lbl = (ns: number[]) => ns.map(n => `[메모${n}]`).join(' ');
    const isFirst = !current.trim();
    // 처음 만들 때·용도가 바뀌었을 때만 전체를 쓰고, 그 외에는 "바뀐 ## 구역만" 받아서 앱이 끼워 넣음
    const patchMode = !isFirst && !purposeChanged;
    const prompt = `
        You maintain ONE handover document (인계장) built from the reader's WORK notes: handover items,
        ward / on-call workflow, cath lab / EP lab workflow, and practical procedure tips written by a cardiology fellow.
        A colleague (or the reader later) should be able to read it top to bottom and act on it.
        ${READER_PROFILE}

        PURPOSE / AUDIENCE: """${purpose || '일반 업무 인계 (따로 지정 없음)'}"""
        TODAY: ${today}

        ${isFirst ? 'There is no document yet — build it from the notes below.' : `CURRENT HANDOVER DOCUMENT (citations like [메모3] are permanent labels of the source notes):
        """
        ${current}
        """`}

        ${items.length > 0 ? `NOTES TO ${isFirst ? 'USE' : 'INTEGRATE (new or modified since the last update)'} (each with its permanent label and last-modified date, oldest first; the COMPLETE text of each note is given):
        """
        ${items.map(it => `[메모${it.label}] ${it.title || '제목 없음'} (마지막 수정 ${new Date(it.date).toLocaleDateString('ko-KR')})${it.parts > 1 ? ` — part ${it.part}/${it.parts}` : ''}\n${it.text}`).join('\n\n=====\n\n')}
        """` : ''}
        ${items.some(it => it.parts > 1) ? `LONG NOTES SPLIT INTO PARTS: a label marked "part k/n" is one piece of a long note. For k > 1 it CONTINUES the same note — add its content and do NOT remove items that came from earlier parts of that note.` : ''}
        NOTE ABOUT OLD TRUNCATION: earlier versions of this app sent only the first part of long notes, cut with
        "(이하 생략)". If the current document has items (usually under "## 확인 필요") saying a note ends with
        "(이하 생략)", is cut off, or that later steps are missing because of that, those were caused by the app —
        remove them, and use the complete note text provided now. Never write that a note "ends with (이하 생략)".
        ${modifiedLabels.length > 0 ? `MODIFIED NOTES: ${lbl(modifiedLabels)} — these notes were edited. Re-derive every item that cites them from the new content above: update changed details, remove items that are no longer in the note, keep the rest.` : ''}
        ${purposeChanged && !isFirst ? `THE PURPOSE / AUDIENCE CHANGED: reorder the categories and rewrite "## 한눈에" for the new purpose, but keep each item's wording and citations.` : ''}
        ${removedLabels.length > 0 ? `REMOVED NOTES: ${lbl(removedLabels)} — deleted or no longer marked as work. Delete items that cite only these labels; for items that also cite other notes, just drop these labels.` : ''}

        ${isFirst ? '' : `UPDATE RULES:
        - Keep every item that is not affected EXACTLY as it is (same wording, same citations, same position${patchMode ? '' : ' — except for reordering asked by the PURPOSE CHANGED note'}) — the reader may have edited it by hand.
        - Put new items into the matching existing category/subcategory; create a new "##"/"###" only when nothing fits.
        - Refresh "## 한눈에" and "## 확인 필요" if they should change.`}

        STRUCTURE (Korean, with the usual English terms/abbreviations):
        - "## 한눈에": 3~6 bullets — the most important or time-sensitive items.
        - Then everything grouped by category: "##" major categories, "###" subcategories. Typical categories:
          병동·당직 업무 / 시술 (subcategories per procedure, e.g. CAG·PCI, EP study·ablation, device implantation,
          structural) / 약물·오더 / 검사·예약 / 장비·물품 / 전산(EMR)·서류 / 연락처·절차 / 기타. Only categories
          with content, ordered by practical importance (adapt to the purpose).
        - Items: "- **짧은 항목명**: 내용" on one line where possible; step-by-step procedures as numbered sub-steps.
          Keep EXACTLY as written: numbers, doses, settings, catheter/device names and sizes, extension/phone numbers,
          names and roles, timing.
        - FIDELITY FIRST: do not add clinical content that is not in the notes; if a short clarification is truly
          needed for safety, mark it "(메모 외 보충)".
        - Merge duplicates. When notes conflict, keep the most recently modified one and add
          "**주의** 이전 메모와 다름: …" with both citations.
        - Cite right after each item using ONLY the permanent labels, e.g. "... [메모3]" or "[메모2][메모5]".
          Never invent labels.
        - End with "## 확인 필요" for outdated, conflicting or incomplete items (omit if none).
        ${patchMode ? `OUTPUT FORMAT (STRICT) — return ONLY the "##" sections that change, NOT the whole document:
        - For every "##" section you change or add, output that WHOLE section (its "##" line, all its "###"
          subsections and every item, including the unchanged items inside it), wrapped exactly like this:
          @@@SECTION
          ## 섹션 제목
          ...
          @@@END
        - When replacing an existing section, copy its "##" title EXACTLY as in the current document.
        - To delete a whole "##" section, output one line: @@@DELETE ## 섹션 제목
        - Do NOT output sections that stay exactly the same. No other text before, between or after the blocks.` :
        `OUTPUT: only the handover document — no preamble, no narration, no summary of what changed.`}
    `;
    const data = await callClaude({
        model: MODEL_SMART,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        // 한국어는 글자당 토큰이 많고, 생각(thinking)도 이 한도에 포함됨 → 넉넉히 (Sonnet 5 출력 최대 128K)
        max_tokens: patchMode ? 32000 : 48000,
        // 정리·재배열 작업이라 깊은 생각보다 본문이 중요 → 생각은 짧게
        effort: 'low'
    });
    let text = extractText(data);
    if (!text) throw new Error(`인계장 결과가 비어 있습니다 (중단 사유: ${data?.stop_reason || '알 수 없음'}). 잠시 후 다시 시도해보세요.`);
    if (data?.stop_reason === 'max_tokens') {
        const err: any = new Error('한 번에 반영할 내용이 많아 분량 한도에 걸렸습니다. 기존 인계장은 그대로 두었어요.');
        err.code = 'MAX_TOKENS'; // 호출한 쪽에서 더 작게 나눠 다시 시도
        throw err;
    }
    if (patchMode) {
        const patched = applySectionPatch(current, text);
        if (patched) return patched.doc;
        // 형식을 안 지키고 전체 문서를 돌려준 경우: 충분히 길면 전체로 받아들임
        const first = text.indexOf('## ');
        if (first >= 0 && first < 300 && text.length > current.length * 0.6) return text.slice(first);
        throw new Error('AI 응답 형식이 맞지 않아 반영하지 않았습니다. 기존 인계장은 그대로 두었어요. 다시 시도해주세요.');
    }
    const first = text.indexOf('## ');
    if (first > 0 && first < 300) text = text.slice(first);
    return text;
};
