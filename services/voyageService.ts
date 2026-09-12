
// ============================================================================
// Voyage AI 임베딩 서비스 (의미 기반 검색 지원)
// ----------------------------------------------------------------------------
// 이 프로젝트의 기존 결정(services/claudeService.ts 참고)과 동일하게,
// 프론트엔드에서 Voyage API를 직접 호출합니다. 즉 VOYAGE_API_KEY도 브라우저
// 번들에 포함되어 노출됩니다.
//
// 주의(보안): Voyage 공식 문서는 "API 키를 브라우저나 앱에 노출하지 말라"고
// 명시적으로 권고합니다. Claude 키를 프론트엔드에 노출하기로 한 결정과는
// 별개의 판단이 필요할 수 있는 부분이니, 개인/소수 인원 전용 배포로만
// 사용하세요.
//
// 검색용으로만 쓰는 임베딩이라 실패해도(키 미설정, 네트워크 오류 등) 메모
// 저장 자체는 절대 막지 않도록 이 서비스의 실패는 전부 호출부에서
// "조용히" 처리(콘솔 로그만 남기고 무시)하는 것을 전제로 설계했습니다.
// ============================================================================

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

// 비용 최적화 모델(100만 토큰당 $0.02). 품질을 더 올리고 싶으면 'voyage-4'로
// 바꾸면 됩니다(가격은 3배, 100만 토큰당 $0.06).
const EMBEDDING_MODEL = 'voyage-4-lite';

// 노트 임베딩 시 안전하게 자를 최대 문자 수. 이 정도만 있어도 "이 메모가 어떤
// 주제인지" 파악하는 임베딩 품질에는 거의 영향이 없고, 비용/속도를 예측 가능하게
// 유지해줍니다.
const MAX_EMBED_CHARS = 8000;

// ----------------------------------------------------------------------------
// API 키 조회 (Vite 환경변수 → process.env 순서로 폴백, claudeService.ts와 동일한 패턴)
// ----------------------------------------------------------------------------
const getVoyageApiKey = (): string => {
    let apiKey = "";

    try {
        apiKey = (import.meta as any).env?.VITE_VOYAGE_API_KEY || (import.meta as any).env?.VOYAGE_API_KEY || "";
    } catch (e) {
        // import.meta가 없는 환경일 수 있음
    }

    if (!apiKey || apiKey === 'undefined') {
        try {
            apiKey = process.env.VITE_VOYAGE_API_KEY || process.env.VOYAGE_API_KEY || "";
        } catch (e) {
            // process가 정의되지 않은 브라우저 환경일 수 있음
        }
    }

    if (!apiKey || apiKey === 'undefined' || (typeof apiKey === 'string' && apiKey.includes('TODO'))) {
        throw new Error("Voyage API Key missing or invalid");
    }
    return apiKey;
};

// Voyage 키가 설정돼 있는지 에러 없이 미리 확인하고 싶을 때 사용
export const hasVoyageApiKey = (): boolean => {
    try {
        getVoyageApiKey();
        return true;
    } catch {
        return false;
    }
};

export type EmbeddingInputType = 'query' | 'document';

// ----------------------------------------------------------------------------
// 여러 텍스트를 한 번에 임베딩.
// Voyage는 요청 하나에 텍스트를 최대 1,000개까지 넣을 수 있지만, 응답/재시도
// 단위를 다루기 쉽게 하기 위해 호출하는 쪽(App.tsx의 백필 로직 등)에서
// 적당한 크기로 나눠서 호출하는 것을 권장합니다.
// ----------------------------------------------------------------------------
export const embedTexts = async (texts: string[], inputType: EmbeddingInputType): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const apiKey = getVoyageApiKey();

    const response = await fetch(VOYAGE_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            input: texts.map(t => (t || '').slice(0, MAX_EMBED_CHARS)),
            model: EMBEDDING_MODEL,
            input_type: inputType,
        }),
    });

    if (!response.ok) {
        let errBody: any = null;
        try { errBody = await response.json(); } catch { /* ignore */ }
        const errMsg = errBody?.error?.message || errBody?.detail || response.statusText;
        throw new Error(`Voyage API error (${response.status}): ${errMsg}`);
    }

    const data = await response.json();

    // OpenAI 호환 응답 형식: { data: [{ embedding: number[], index: number }], ... }
    // 혹시 다른 형태로 오는 경우까지 방어적으로 처리.
    const items: Array<{ embedding: number[]; index?: number }> | null =
        Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.embeddings)
                ? data.embeddings.map((e: number[], i: number) => ({ embedding: e, index: i }))
                : null;

    if (!items) {
        throw new Error("Voyage API: 예상치 못한 응답 형식입니다.");
    }

    // index 기준으로 정렬해서 입력 순서와 항상 일치하도록 보장
    const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map(item => item.embedding);
};

// ----------------------------------------------------------------------------
// 코사인 유사도 (두 임베딩 벡터의 방향 유사성, -1~1. 1에 가까울수록 의미가 비슷함)
// ----------------------------------------------------------------------------
export const cosineSimilarity = (a?: number[], b?: number[]): number => {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ----------------------------------------------------------------------------
// 노트에서 임베딩용 텍스트를 구성 (검색 인덱스와 동일한 필드 사용:
// 제목 / 본문 / AI 요약 / 사진 OCR 텍스트)
// ----------------------------------------------------------------------------
export const buildNoteEmbeddingText = (note: {
    title?: string;
    content?: string;
    summary?: string;
    transcription?: string;
}): string => {
    return [note.title, note.content, note.summary, note.transcription]
        .filter(Boolean)
        .join('\n')
        .trim();
};
