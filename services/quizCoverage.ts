// ============================================================================
// 퀴즈 출제 범위: 메모를 구역(제목·분량 기준)으로 나누고, 구역마다 몇 번 출제됐는지 기록해
// 아직 덜 나온 구역부터 문제를 냄 → 여러 번 풀다 보면 메모 전체(본문·사진·사진 글자·AI 요약)를 고루 다룸
// - 구역 식별은 내용 해시 → 메모를 고쳐도 바뀐 구역만 "새 구역"이 되고 나머지 기록은 유지
// ============================================================================
import type { Note, QuizCoverageEntry } from '../types';

export type QuizPartKind = 'note' | 'imageText' | 'summary' | 'image';

export interface QuizPart {
    key: string;
    kind: QuizPartKind;
    label: string;
    text: string; // 사진 구역은 사진에서 읽은 글자(있으면)
    imageIndex?: number; // kind === 'image'
    target: number; // 이 구역에서 낼 문제 수 목표 (분량 비례, 1~3)
}

export const PART_MAX_CHARS = 1800;
const PART_MIN_CHARS = 300;
const CHARS_PER_QUESTION = 700;
const MAX_TOPICS_PER_PART = 6;

// FNV-1a 32bit
const hash = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
};

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const shortLabel = (s: string, max = 40) => {
    const t = norm(s.replace(/[#*_`>]/g, ''));
    return t.length > max ? t.slice(0, max) + '…' : t;
};

// "메모 내용으로 저장"으로 생긴 접기 블록 표시·주석은 빼고 글만 남김
const cleanContent = (content: string): string =>
    (content || '')
        // 예전에 옮겼다가 새 요약으로 바뀐 "이전 요약" 블록은 출제하지 않음 (지금은 맞지 않을 수 있음)
        .replace(/<!-- medinote:prev -->[\s\S]*?<!-- \/medinote:prev -->/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<summary>[\s\S]*?<\/summary>/g, '')
        .replace(/<\/?details[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

interface RawSection { label: string; text: string }

// 제목(#~###) 기준으로 나누고, 짧은 구역은 이웃과 합치고, 긴 구역은 문단 단위로 쪼갬
export const splitTextIntoSections = (text: string, baseLabel: string): RawSection[] => {
    const lines = (text || '').split('\n');
    const sections: RawSection[] = [];
    let cur: RawSection = { label: baseLabel, text: '' };
    let inCode = false;
    for (const line of lines) {
        if (/^\s*```/.test(line)) inCode = !inCode;
        const m = !inCode && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) {
            if (cur.text.trim()) sections.push(cur);
            cur = { label: shortLabel(m[2]), text: line + '\n' };
        } else {
            cur.text += line + '\n';
        }
    }
    if (cur.text.trim()) sections.push(cur);

    // 짧은 구역은 이웃과 합치기 (앞 구역에 붙이고, 앞이 안 되면 다음 구역과)
    const isShort = (x: RawSection) => x.text.trim().length < PART_MIN_CHARS;
    const merged: RawSection[] = [];
    for (const s of sections) {
        const prev = merged[merged.length - 1];
        // 크기 상관없이 합침 — 너무 길어지면 아래에서 다시 쪼갬 (제목만 있는 구역이 따로 남지 않게)
        if (prev && (isShort(prev) || isShort(s))) {
            prev.text += s.text;
            if (!prev.label.endsWith(' 외')) prev.label = `${prev.label} 외`;
        } else {
            merged.push({ ...s });
        }
    }

    // 긴 구역 쪼개기: 빈 줄(문단) 기준, 한 문단이 너무 길면 줄 → 글자 기준
    const out: RawSection[] = [];
    merged.forEach(s => {
        const body = s.text.trim();
        if (body.length <= PART_MAX_CHARS) { out.push({ label: s.label, text: body }); return; }
        const pieces: string[] = [];
        let buf = '';
        const push = () => { if (buf.trim()) pieces.push(buf.trim()); buf = ''; };
        const units = body.split(/\n\s*\n/).flatMap(p => {
            if (p.length <= PART_MAX_CHARS) return [p];
            const ls = p.split('\n');
            const res: string[] = [];
            let b = '';
            ls.forEach(l => {
                if (l.length > PART_MAX_CHARS) {
                    if (b) { res.push(b); b = ''; }
                    for (let i = 0; i < l.length; i += PART_MAX_CHARS) res.push(l.slice(i, i + PART_MAX_CHARS));
                } else if ((b + '\n' + l).length > PART_MAX_CHARS) {
                    res.push(b); b = l;
                } else {
                    b = b ? `${b}\n${l}` : l;
                }
            });
            if (b) res.push(b);
            return res;
        });
        units.forEach(u => {
            if ((buf + '\n\n' + u).length > PART_MAX_CHARS) push();
            buf = buf ? `${buf}\n\n${u}` : u;
        });
        push();
        pieces.forEach((p, i) => out.push({ label: `${s.label} (${i + 1}/${pieces.length})`, text: p }));
    });
    return out;
};

const targetFor = (len: number) => Math.min(3, Math.max(1, Math.round(len / CHARS_PER_QUESTION)));

// 메모 → 출제 구역 목록. 사진 구역은 사진이 들어 있는(가볍지 않은) 메모에서만 생김
export const splitNoteParts = (note: Pick<Note, 'content' | 'summary' | 'transcription' | 'images' | 'title'>): QuizPart[] => {
    const parts: QuizPart[] = [];
    const used = new Set<string>();
    const add = (kind: QuizPartKind, label: string, text: string, extra?: Partial<QuizPart>, keySeed?: string) => {
        let key = `${kind[0]}${hash(keySeed ?? norm(text))}`;
        let k = 2;
        while (used.has(key)) key = `${key}_${k++}`;
        used.add(key);
        parts.push({ key, kind, label, text, target: kind === 'image' ? 1 : targetFor(text.length), ...extra });
    };
    const meaningful = (t: string) => t.replace(/^#{1,6}\s.*$/gm, '').replace(/\s+/g, '').length >= 40;
    const bodySections = splitTextIntoSections(cleanContent(note.content || ''), '본문');
    // 제목만 있는 등 거의 빈 구역은 다른 구역이 있으면 빼기
    const bodyUseful = bodySections.filter(s => meaningful(s.text));
    (bodyUseful.length ? bodyUseful : bodySections).forEach(s => add('note', s.label, s.text));
    if ((note.transcription || '').trim()) {
        splitTextIntoSections(note.transcription || '', '사진 글자').forEach(s => add('imageText', `사진 글자 · ${s.label}`, s.text));
    }
    if ((note.summary || '').trim()) {
        splitTextIntoSections(note.summary || '', '요약').forEach(s => add('summary', `AI 요약 · ${s.label}`, s.text));
    }
    (note.images || []).forEach((img, i) => {
        if (typeof img !== 'string' || !img || img.startsWith('http')) return;
        add('image', `사진 #${i + 1}`, '', { imageIndex: i }, `${img.length}:${img.slice(0, 64)}:${img.slice(-64)}`);
    });
    return parts;
};

// 가벼운 메모(목록용, 사진 없음)의 글 구역은 자주 계산하므로 캐시
const partsCache = new Map<string, { sig: string; parts: QuizPart[] }>();
export const textPartsCached = (n: Note): QuizPart[] => {
    const sig = `${n.updatedAt || 0}|${(n.content || '').length}|${(n.summary || '').length}|${n.summarizedAt || 0}|${(n.transcription || '').length}`;
    const hit = partsCache.get(n.id);
    if (hit && hit.sig === sig) return hit.parts;
    const parts = splitNoteParts({ ...n, images: [] });
    partsCache.set(n.id, { sig, parts });
    return parts;
};

const entryOf = (cov: Note['quizCoverage'], key: string): QuizCoverageEntry | undefined =>
    cov && typeof cov === 'object' ? cov[key] : undefined;

// 출제 진행도 (목표 문제 수 기준)
export const coverageProgress = (parts: QuizPart[], cov: Note['quizCoverage']): { done: number; total: number; ratio: number; touched: number } => {
    let done = 0, total = 0, touched = 0;
    parts.forEach(p => {
        const n = entryOf(cov, p.key)?.n || 0;
        done += Math.min(n, p.target);
        total += p.target;
        if (n > 0) touched++;
    });
    return { done, total, touched, ratio: total ? done / total : 1 };
};

// 다음에 낼 구역: 목표 대비 덜 나온 구역 → 오래전에 나온 구역 → 앞쪽 구역 순
export const pickQuizPart = (parts: QuizPart[], cov: Note['quizCoverage'], reserved?: Set<string>): QuizPart | null => {
    if (parts.length === 0) return null;
    const pool = reserved ? parts.filter(p => !reserved.has(p.key)) : parts;
    const list = pool.length ? pool : parts;
    const scored = list.map((p, i) => {
        const e = entryOf(cov, p.key);
        return { p, i, r: (e?.n || 0) / p.target, at: e?.at || 0 };
    });
    scored.sort((a, b) => a.r - b.r || a.at - b.at || a.i - b.i);
    return scored[0].p;
};

export const askedTopicsOf = (cov: Note['quizCoverage'], key: string): string[] => entryOf(cov, key)?.t || [];

// 문제를 푼 뒤 기록. 지금 메모에 없는 구역(고쳐서 사라진 구역)의 기록은 정리
export const recordQuizCoverage = (
    cov: Note['quizCoverage'],
    currentKeys: string[],
    key: string,
    topic: string | undefined,
    now: number
): Record<string, QuizCoverageEntry> => {
    const keep = new Set(currentKeys);
    keep.add(key);
    const out: Record<string, QuizCoverageEntry> = {};
    Object.entries(cov && typeof cov === 'object' ? cov : {}).forEach(([k, v]) => { if (keep.has(k) && v) out[k] = v; });
    const prev = out[key];
    const t = (topic || '').trim().slice(0, 80);
    const topics = [...(prev?.t || []), ...(t ? [t] : [])].slice(-MAX_TOPICS_PER_PART);
    out[key] = { n: (prev?.n || 0) + 1, at: now, ...(topics.length ? { t: topics } : {}) };
    return out;
};

export const sanitizeCoverage = (raw: any): Record<string, QuizCoverageEntry> | undefined => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, QuizCoverageEntry> = {};
    Object.entries(raw).forEach(([k, v]: [string, any]) => {
        if (!v || typeof v.n !== 'number' || typeof v.at !== 'number') return;
        const t = Array.isArray(v.t) ? v.t.filter((x: any) => typeof x === 'string').slice(-MAX_TOPICS_PER_PART) : [];
        out[k] = { n: v.n, at: v.at, ...(t.length ? { t } : {}) };
    });
    return Object.keys(out).length ? out : undefined;
};
