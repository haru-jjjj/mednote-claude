// ============================================================================
// 질문/주제와 관련된 메모 찾기 (내 메모에 물어보기 · 메모 활용 화면 공용)
// - Voyage 임베딩이 있으면 의미 기반, 없거나 실패하면 키워드 기반
// - 결과는 사진까지 포함된 전체 메모로 다시 읽어서 돌려줌
// ============================================================================
import { Note } from '../types';
import { getNoteFromDB } from './storage';
import { cosineSimilarity, embedTexts, hasVoyageApiKey } from './voyageService';

// 한국어 조사(에서, 으로, 는 ...)가 붙은 채로는 본문과 잘 안 맞아서 끝의 조사를 떼고 비교
const stripParticle = (t: string) => {
    const stripped = t.replace(/(에서|에게|으로|이랑|하고|까지|부터|로|은|는|이|가|을|를|의|와|과|도|에|랑)$/, '');
    return stripped.length >= 2 ? stripped : t;
};

export const keywordRank = (query: string, notes: Note[], limit: number): Note[] => {
    const terms = query.toLowerCase().split(/[\s,./()?!]+/).map(stripParticle).filter(t => t.length >= 2);
    if (terms.length === 0) return [];
    return notes
        .map(n => {
            const title = (n.title || '').toLowerCase();
            const body = `${n.content || ''} ${n.summary || ''} ${n.transcription || ''}`.toLowerCase();
            const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0), 0);
            return { n, score };
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(r => r.n);
};

export const hydrateNotes = async (list: Note[]): Promise<Note[]> => {
    const out: Note[] = [];
    for (const n of list) {
        try {
            out.push((await getNoteFromDB(n.id)) || n);
        } catch {
            out.push(n);
        }
    }
    return out;
};

export const findRelatedNotes = async (
    query: string,
    notes: Note[],
    limit: number,
    threshold = 0.3
): Promise<{ list: Note[]; how: string }> => {
    const withEmb = notes.filter(n => n.embedding && n.embedding.length > 0);
    let ranked: Note[] = [];
    let how = '';
    if (hasVoyageApiKey() && withEmb.length > 0) {
        try {
            const [qv] = await embedTexts([query], 'query');
            if (qv) {
                ranked = withEmb
                    .map(n => ({ n, sim: cosineSimilarity(qv, n.embedding) }))
                    .filter(r => r.sim >= threshold)
                    .sort((a, b) => b.sim - a.sim)
                    .slice(0, limit)
                    .map(r => r.n);
                how = '의미 기반 검색';
            }
        } catch (e) {
            console.warn('임베딩 검색 실패, 키워드 검색으로 대체:', e);
        }
    }
    if (ranked.length === 0) {
        ranked = keywordRank(query, notes, limit);
        how = '키워드 검색';
    }
    return { list: await hydrateNotes(ranked), how };
};
