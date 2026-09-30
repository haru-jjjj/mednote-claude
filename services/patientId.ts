// ============================================================================
// 환자 메모의 "내 식별번호" (제목 맨 앞) 읽기 · 같은 번호 메모 합치기
// - 예: "A023 HFrEF f/u", "#A023 ...", "[A023] ...", "P-12 ...", "1234 ..." → A023 / P-12 / 1234
// - 날짜(2026.09.30, 9/30)나 연도(2026)로 시작하는 제목은 번호로 보지 않음
// ============================================================================
import type { Note } from '../types';

const ID_RE = /^[A-Za-z]{0,5}[-_]?\d{1,8}[A-Za-z]{0,3}$/;

// 한 줄의 맨 앞 토큰에서 식별번호를 읽음 (없으면 null). 비교용으로 대문자.
export const extractPatientId = (line: string): string | null => {
    const first = (line || '').trim().split(/\s+/)[0] || '';
    const token = first.replace(/^#+/, '').replace(/^[[(]/, '').replace(/[\])]$/, '').replace(/[:,.]$/, '');
    if (!token || !ID_RE.test(token)) return null;
    if (/^(19|20)\d{2}$/.test(token)) return null; // 연도
    if (!/\d/.test(token)) return null;
    return token.toUpperCase();
};

export const firstLineOf = (text: string) => ((text || '').split('\n').find(l => l.trim()) || '').trim();

// 환자 메모만 번호를 가짐. 제목에서 먼저 찾고, 없으면 본문 첫 줄에서.
export const patientIdOf = (n: Pick<Note, 'tag' | 'title' | 'content' | 'origin'>): string | null => {
    if (n.tag !== 'patient' || n.origin === 'ai') return null;
    return extractPatientId(n.title || '') || extractPatientId(firstLineOf(n.content || ''));
};

// 번호 → 그 번호의 환자 메모들 (오래된 순)
export const buildPatientIndex = (notes: Note[]): Map<string, Note[]> => {
    const map = new Map<string, Note[]>();
    notes.forEach(n => {
        const id = patientIdOf(n);
        if (!id) return;
        const list = map.get(id) || [];
        list.push(n);
        map.set(id, list);
    });
    map.forEach(list => list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
    return map;
};

export const duplicatePatientGroups = (index: Map<string, Note[]>): { id: string; notes: Note[] }[] =>
    Array.from(index.entries())
        .filter(([, list]) => list.length > 1)
        .map(([id, notes]) => ({ id, notes }))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

// ---------------------------------------------------------------------------
// 합치기
// ---------------------------------------------------------------------------
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const dateHeading = (t: number): string => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} (${DAYS[d.getDay()]})`;
};

// 본문을 "첫 줄(번호 줄)"과 나머지로. 첫 줄이 같은 번호로 시작하면 번호를 떼고 남은 글자만 돌려줌.
const splitIdLine = (content: string, id: string): { idLineRest: string | null; body: string } => {
    const lines = (content || '').split('\n');
    const idx = lines.findIndex(l => l.trim());
    if (idx < 0) return { idLineRest: null, body: '' };
    const line = lines[idx].trim();
    if (extractPatientId(line) !== id) return { idLineRest: null, body: (content || '').trim() };
    const rest = line.split(/\s+/).slice(1).join(' ').trim();
    return { idLineRest: rest, body: lines.slice(idx + 1).join('\n').trim() };
};

// 이미 "## 날짜" 소제목으로 정리돼 있는 메모인지 (그렇다면 날짜 소제목을 또 달지 않음)
const hasDateHeadings = (body: string) => /^##\s+(\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}|\d{1,2}[./]\d{1,2}|\d{1,2}월)/m.test(body);

// 같은 번호의 메모들(아무 순서)을 오래된 순으로 날짜 소제목을 달아 하나로
export const buildMergedPatientContent = (notes: Note[], id: string): string => {
    const sorted = [...notes].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const oldest = sorted[0];
    const titleLine = firstLineOf(oldest.content || '') || oldest.title || id;
    const parts: string[] = [titleLine.startsWith('#') ? titleLine : titleLine];
    sorted.forEach((n, i) => {
        const { idLineRest, body } = splitIdLine(n.content || '', id);
        // 가장 오래된 메모의 첫 줄은 맨 위 제목 줄로 이미 들어감
        const lead = i === 0 ? '' : (idLineRest || '');
        const block = [lead, body].filter(Boolean).join('\n');
        if (!block.trim()) return;
        parts.push(hasDateHeadings(body) && !lead ? block : `## ${dateHeading(n.createdAt || Date.now())}\n\n${block}`);
    });
    return parts.join('\n\n').trim() + '\n';
};

// 새로 쓴 내용을 기존 환자 메모 끝에 오늘 날짜 소제목으로 이어붙이기
export const buildAppendedContent = (existing: string, added: string, id: string, when: number): string => {
    const { idLineRest, body } = splitIdLine(added, id);
    const block = [idLineRest || '', body].filter(Boolean).join('\n').trim();
    if (!block) return existing;
    return `${(existing || '').trimEnd()}\n\n## ${dateHeading(when)}\n\n${block}\n`;
};
