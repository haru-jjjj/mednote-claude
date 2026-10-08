// ============================================================================
// PDF로 OX 빠짐없이 내기 (§5-75) — 순수 함수 (저장·AI 호출 없음, 테스트 가능)
//
// 구간(약 2,600자)마다 처음 출제할 때 AI가 "시험에 낼 만한 요점" 목록을 만들고 요점마다 OX 한 문제를 씀.
// 요점 하나를 풀면 '맞힘/틀림'으로 표시 → 앞 구간부터 안 푼 요점이 하나도 안 남을 때까지 냄 = 한 바퀴.
// 틀린 요점은 같은 문제를 다시 풀 수 있게 남겨 두고, 맞히면 문제는 지우고 요점만 남김(저장 용량 절약).
// ============================================================================

import type { PdfDoc, PdfPoint, PdfQuestion, PdfSectionProgress, PdfSectionMeta, QuizLanguage, QuizQuestion } from '../types';

export type PdfPick =
    | { kind: 'question'; section: PdfSectionMeta; sectionIndex: number; sectionCount: number; question: PdfQuestion }
    // null = 요점 목록부터(OX와 함께 만듦). format MC = 그 요점 하나의 케이스(5지선다) 문제를 만듦 (§5-79)
    | { kind: 'generate'; section: PdfSectionMeta; sectionIndex: number; sectionCount: number; pointIndexes: number[] | null; format: 'OX' | 'MC' }
    | { kind: 'done' };

// 문제 형식 (§5-79): OX / 케이스(임상 응용 5지선다) / 섞어서(문제마다 반반)
export type PdfFormat = 'OX' | 'MC' | 'MIX';
export const qFormat = (q: PdfQuestion): 'OX' | 'MC' => (q.type === 'MC' ? 'MC' : 'OX');

export const activeSections = (doc: PdfDoc): PdfSectionMeta[] =>
    doc.sections.filter(s => !s.excluded && !doc.progress?.[s.key]?.empty);

// 다음에 낼 것: 앞 구간부터, 안 푼(wrong 모드는 틀린) 요점 중 이번 세션에 아직 안 꺼낸 것
// reserved: 이번 세션에서 이미 꺼낸 "구간키#요점번호"
// 출제 순서 (§5-81): seq = 앞 구간·앞 요점부터 / random = 안 푼 요점이 남은 구간 중 무작위, 구간 안에서도 무작위
// 어느 쪽이든 안 푼 요점만 내므로 한 바퀴 돌면 모든 요점을 한 번씩 만남 ("빠짐없이"는 그대로)
export type PdfOrder = 'seq' | 'random';

export const pickPdfQuestion = (
    doc: PdfDoc,
    reserved: Set<string>,
    mode: 'all' | 'wrong',
    language: QuizLanguage,
    format: PdfFormat = 'OX',
    rand: () => number = Math.random,
    order: PdfOrder = 'seq',
    preferKey?: string | null // 무작위일 때: 방금 문제를 만든 구간을 먼저 (이어서 다른 구간을 또 만들며 기다리지 않게)
): PdfPick => {
    const list = doc.sections.filter(s => !s.excluded);
    const counted = activeSections(doc);
    const pickIn = (arr: { p: PdfPoint; i: number }[]) => (order === 'random' ? arr[Math.floor(rand() * arr.length) % arr.length] : arr[0]);

    // 구간 하나에서 낼 것 (없으면 null)
    const sectionPick = (s: PdfSectionMeta): Exclude<PdfPick, { kind: 'done' }> | null => {
        const prog = doc.progress?.[s.key];
        if (prog?.empty) return null;
        const sectionIndex = counted.indexOf(s);
        const base = { section: s, sectionIndex: Math.max(0, sectionIndex), sectionCount: counted.length };
        if (!prog?.pts) {
            if (mode === 'wrong') return null;
            if (reserved.has(`${s.key}#*`)) return null;
            // 요점 목록은 OX 묶음 만들기로 함께 만듦 (케이스 형식이어도 먼저 요점이 필요)
            return { kind: 'generate', ...base, pointIndexes: null, format: 'OX' };
        }
        const want = mode === 'wrong' ? 'wrong' : 'new';
        const pending = prog.pts.map((p, i) => ({ p, i })).filter(x => x.p.st === want && !isSkippedPoint(x.p) && !reserved.has(`${s.key}#${x.i}`));
        if (pending.length === 0) return null;
        const qs = prog.qs || [];
        if (mode === 'wrong') {
            // 틀린 문제 다시: 그때 틀린 문제 그대로(형식·언어 무관)
            const withQ = pending.filter(({ p, i }) => qs.some(x => x.id === p.wq || x.pi === i));
            if (withQ.length) {
                const { p, i } = pickIn(withQ);
                const q = qs.find(x => x.id === p.wq) || qs.find(x => x.pi === i)!;
                return { kind: 'question', ...base, question: q };
            }
            return { kind: 'generate', ...base, pointIndexes: [pending[0].i], format: format === 'MC' ? 'MC' : 'OX' };
        }
        // 형식은 고른 것(섞어서면 요점마다 반반)
        const { i } = pickIn(pending);
        const fmt: 'OX' | 'MC' = format === 'MIX' ? (rand() < 0.5 ? 'MC' : 'OX') : format;
        const q = qs.find(x => x.pi === i && x.lang === language && qFormat(x) === fmt);
        if (q) return { kind: 'question', ...base, question: q };
        if (fmt === 'MC') return { kind: 'generate', ...base, pointIndexes: [i], format: 'MC' };
        // OX는 한 번에: 이 언어의 OX가 없는 안 푼 요점 전부
        const missing = pending.filter(x => !qs.some(q2 => q2.pi === x.i && q2.lang === language && qFormat(q2) === 'OX')).map(x => x.i);
        return { kind: 'generate', ...base, pointIndexes: missing.length ? missing : [i], format: 'OX' };
    };

    if (order === 'seq') {
        for (const s of list) {
            const r = sectionPick(s);
            if (r) return r;
        }
        return { kind: 'done' };
    }

    // 무작위: 구간 순서를 섞음 — 이미 펼친(요점 목록을 만든) 구간에 안 푼 요점이 있으면 그 구간을 마저 풀고,
    // 없으면 아직 안 펼친 구간 중 무작위. 구간 안의 요점 순서도 무작위.
    // (문제마다 새 구간으로 뛰면 거의 매 문제 문제 만들기를 기다려야 하고, 만들어 두고 안 푼 문제가 쌓임)
    if (preferKey) {
        const ps = list.find(s => s.key === preferKey);
        const r = ps ? sectionPick(ps) : null;
        if (r) return r;
    }
    const cands = list.map(sectionPick).filter((x): x is Exclude<PdfPick, { kind: 'done' }> => !!x);
    if (cands.length === 0) return { kind: 'done' };
    const open = cands.filter(c => !(c.kind === 'generate' && c.pointIndexes === null));
    const pool = open.length ? open : cands;
    return pool[Math.floor(rand() * pool.length) % pool.length];
};

export interface GeneratedItem { point: string; statement: string; isTrue: boolean; explanation: string; ok?: boolean }

// 정답 검증에 실패했거나 사용자가 "문제 오류"로 뺀 요점: 실패 횟수를 세고, 2번이면 이번 바퀴에서 건너뜀 (§5-82)
export const MAX_POINT_FAILS = 2;
const bumpFail = (pt: PdfPoint): PdfPoint => {
    const fa = (pt.fa || 0) + 1;
    return { ...pt, fa, x: fa >= MAX_POINT_FAILS ? true : undefined };
};
export const isSkippedPoint = (pt: PdfPoint) => pt.x === true;

// AI 결과를 구간 기록에 넣기
// - pointIndexes가 null(처음): 요점 목록을 새로 만들고 문제를 붙임. 결과가 0개면 "낼 내용 없음" 구간
// - pointIndexes가 있으면: 그 요점들의 문제를 (같은 순서로) 새로 붙임. 같은 언어의 예전 문제는 바꿈
export const applyGenerated = (
    prev: PdfSectionProgress | undefined,
    pointIndexes: number[] | null,
    items: GeneratedItem[],
    language: QuizLanguage,
    makeId: () => string,
    now: number
): PdfSectionProgress => {
    const valid = items.filter(it => it && typeof it.statement === 'string' && it.statement.trim() && typeof it.isTrue === 'boolean');
    if (pointIndexes === null) {
        if (valid.length === 0) return { ...(prev || {}), empty: true, pts: [], qs: [], u: now };
        // 검증에서 정답이 안 맞은 문제(ok === false)는 버리고 요점만 남김 → 다음에 그 요점 문제를 다시 만듦
        const pts: PdfPoint[] = valid.map(it => {
            const pt: PdfPoint = { p: (it.point || '').trim().slice(0, 80) || it.statement.slice(0, 40), st: 'new' };
            return it.ok === false ? bumpFail(pt) : pt;
        });
        const qs: PdfQuestion[] = valid
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => it.ok !== false)
            .map(({ it, i }) => ({ id: makeId(), pi: i, q: it.statement.trim(), t: it.isTrue, ex: (it.explanation || '').trim(), lang: language }));
        return { ...(prev || {}), pts, qs, empty: undefined, u: now };
    }
    const pts = [...(prev?.pts || [])];
    let qs = [...(prev?.qs || [])];
    pointIndexes.forEach((pi, k) => {
        const it = valid[k];
        if (!pts[pi]) return;
        if (!it || it.ok === false) { pts[pi] = bumpFail(pts[pi]); return; } // 못 만들었거나 검증 불일치
        qs = qs.filter(q => !(q.pi === pi && qFormat(q) === 'OX' && (q.lang === language || pts[pi].st === 'new')));
        qs.push({ id: makeId(), pi, q: it.statement.trim(), t: it.isTrue, ex: (it.explanation || '').trim(), lang: language });
    });
    return { ...(prev || {}), pts, qs, u: now };
};

// 케이스(5지선다) 문제 하나를 요점에 붙이기 (§5-79). 같은 요점·언어의 예전 케이스 문제는 바꿈
export interface GeneratedCase { question: string; options: string[]; correctAnswerIndex: number; explanation: string }
export const applyGeneratedCase = (
    prev: PdfSectionProgress | undefined,
    pointIndex: number,
    item: GeneratedCase | null,
    language: QuizLanguage,
    makeId: () => string,
    now: number
): PdfSectionProgress => {
    if (!item || !item.question || !Array.isArray(item.options) || item.options.length < 2) {
        // 못 만들었거나 정답 검증 불일치 → 실패 횟수 (2번이면 이번 바퀴 건너뜀)
        const pts = [...(prev?.pts || [])];
        if (pts[pointIndex]) pts[pointIndex] = bumpFail(pts[pointIndex]);
        return { ...(prev || {}), pts, u: now };
    }
    const qs = (prev?.qs || []).filter(q => !(q.pi === pointIndex && qFormat(q) === 'MC' && q.lang === language));
    const ans = Math.min(Math.max(0, Math.round(item.correctAnswerIndex || 0)), item.options.length - 1);
    qs.push({ id: makeId(), pi: pointIndex, type: 'MC', q: item.question.trim(), t: false, opts: item.options.map(o => String(o)), ans, ex: (item.explanation || '').trim(), lang: language });
    return { ...(prev || {}), qs, u: now };
};

// 문제를 푼 결과 기록: 맞히면 요점 'ok' + 문제 지움, 틀리면 'wrong' + 문제 남김(다시 풀기용)
export const recordPdfAnswer = (prev: PdfSectionProgress | undefined, questionId: string, pointIndex: number, correct: boolean, now: number): PdfSectionProgress => {
    const pts = [...(prev?.pts || [])];
    const pt = pts[pointIndex];
    if (!pt) return { ...(prev || {}), u: now };
    pts[pointIndex] = { ...pt, st: correct ? 'ok' : 'wrong', at: now, wc: (pt.wc || 0) + (correct ? 0 : 1), wq: correct ? undefined : questionId };
    const qs = correct ? (prev?.qs || []).filter(q => q.id !== questionId && q.pi !== pointIndex) : (prev?.qs || []);
    return { ...(prev || {}), pts, qs, u: now };
};

// "문제 오류 — 기록 없이 넘기기" (§5-82): 그 문제를 지우고, 그 문제 때문에 틀림으로 남은 기록이면 되돌림.
// 요점은 그대로 남아 다음에 새 문제로 다시 나옴(같은 요점에서 두 번째면 이번 바퀴 건너뜀)
export const discardPdfQuestion = (prev: PdfSectionProgress | undefined, questionId: string, pointIndex: number, now: number): PdfSectionProgress => {
    const pts = [...(prev?.pts || [])];
    const pt = pts[pointIndex];
    const qs = (prev?.qs || []).filter(q => q.id !== questionId);
    if (pt) {
        const undoWrong = pt.st === 'wrong' && pt.wq === questionId;
        pts[pointIndex] = bumpFail(undoWrong ? { ...pt, st: 'new', wq: undefined, wc: Math.max(0, (pt.wc || 1) - 1) } : pt);
    }
    return { ...(prev || {}), pts, qs, u: now };
};

// 처음부터 다시: 모든 요점을 '아직'으로, 만들어 둔 문제는 지움(새 문장으로 다시 만듦). 틀린 횟수는 유지
export const resetPdfRound = (doc: PdfDoc, now: number): Record<string, PdfSectionProgress> => {
    const out: Record<string, PdfSectionProgress> = {};
    Object.entries(doc.progress || {}).forEach(([k, p]) => {
        out[k] = { ...p, pts: p.pts?.map(x => ({ ...x, st: 'new' as const, fa: undefined, x: undefined, wq: undefined })), qs: [], u: now };
    });
    return out;
};

export interface PdfStats {
    sections: number; // 출제 대상 구간 수
    sectionsDone: number; // 요점을 다 푼 구간
    sectionsStarted: number; // 요점 목록을 만든 구간
    points: number; // 지금까지 만든 요점 수
    ok: number;
    wrong: number;
    pending: number; // 만든 요점 중 아직 안 푼 것
    roundDone: boolean;
    percent: number; // 구간 기준 진행률 (0~100)
}

export const pdfStats = (doc: PdfDoc): PdfStats => {
    const act = doc.sections.filter(s => !s.excluded);
    let sections = 0, sectionsDone = 0, sectionsStarted = 0, points = 0, ok = 0, wrong = 0, pending = 0;
    act.forEach(s => {
        const p = doc.progress?.[s.key];
        if (p?.empty) return;
        sections++;
        if (!p?.pts) return;
        sectionsStarted++;
        const live = p.pts.filter(x => !isSkippedPoint(x));
        const n = live.filter(x => x.st === 'new').length;
        points += live.length;
        ok += p.pts.filter(x => x.st === 'ok').length;
        wrong += p.pts.filter(x => x.st === 'wrong').length;
        pending += n;
        if (n === 0) sectionsDone++;
    });
    return {
        sections, sectionsDone, sectionsStarted, points, ok, wrong, pending,
        roundDone: sections > 0 && sectionsDone === sections,
        percent: sections ? Math.round((sectionsDone / sections) * 100) : 0,
    };
};

// 저장된 문제 → 퀴즈 화면용 문제
export const toQuizQuestion = (doc: PdfDoc, pick: Extract<PdfPick, { kind: 'question' }>): QuizQuestion => {
    const q = pick.question;
    const point = doc.progress?.[pick.section.key]?.pts?.[q.pi]?.p || '';
    return {
        id: q.id,
        type: qFormat(q) === 'MC' ? 'MULTIPLE_CHOICE' : 'OX',
        question: q.q,
        options: qFormat(q) === 'MC' ? (q.opts || []) : ['O', 'X'],
        correctAnswerIndex: qFormat(q) === 'MC' ? (q.ans || 0) : (q.t ? 0 : 1),
        explanation: q.ex,
        sources: [],
        relatedNoteIds: [],
        pdfRef: {
            docId: doc.id,
            docTitle: doc.title,
            docSource: doc.source,
            sectionKey: pick.section.key,
            sectionLabel: pick.section.label,
            sectionIndex: pick.sectionIndex,
            sectionCount: pick.sectionCount,
            pointIndex: q.pi,
            point,
        },
    };
};

// ----------------------------------------------------------------------------
// 기기 간 병합: 제목·출처 등은 updatedAt이 최신인 쪽, 구간 기록은 구간마다 u가 최신인 쪽
// ----------------------------------------------------------------------------
export const mergePdfDocs = (a: PdfDoc | undefined, b: PdfDoc | undefined): PdfDoc | undefined => {
    if (!a) return b;
    if (!b) return a;
    const base = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
    const other = base === a ? b : a;
    const progress: Record<string, PdfSectionProgress> = { ...(other.progress || {}) };
    Object.entries(base.progress || {}).forEach(([k, p]) => {
        const o = progress[k];
        progress[k] = !o || (p?.u || 0) >= (o.u || 0) ? p : o;
    });
    return { ...base, progress, deleted: a.deleted || b.deleted || undefined };
};

const str = (v: any, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
const LANGS: QuizLanguage[] = ['Korean', 'English', 'Japanese'];

// 클라우드·옛 기록에서 읽은 값을 안전한 모양으로
export const sanitizePdfDoc = (x: any): PdfDoc | null => {
    if (!x || typeof x.id !== 'string' || !Array.isArray(x.sections)) return null;
    const sections: PdfSectionMeta[] = x.sections
        .filter((s: any) => s && typeof s.key === 'string' && /^s\d+$/.test(s.key))
        .map((s: any) => ({ key: s.key, label: str(s.label, 40), pageFrom: num(s.pageFrom), pageTo: num(s.pageTo), chars: num(s.chars), head: str(s.head, 80), excluded: s.excluded === true ? true : undefined }));
    const progress: Record<string, PdfSectionProgress> = {};
    Object.entries(x.progress && typeof x.progress === 'object' ? x.progress : {}).forEach(([k, p]: [string, any]) => {
        if (!/^s\d+$/.test(k) || !p || typeof p !== 'object') return;
        progress[k] = {
            pts: Array.isArray(p.pts) ? p.pts.map((t: any) => ({ p: str(t?.p, 120), st: t?.st === 'ok' || t?.st === 'wrong' ? t.st : 'new', at: typeof t?.at === 'number' ? t.at : undefined, wc: typeof t?.wc === 'number' ? t.wc : undefined, wq: typeof t?.wq === 'string' ? t.wq : undefined, fa: typeof t?.fa === 'number' ? t.fa : undefined, x: t?.x === true ? true : undefined })) : undefined,
            qs: Array.isArray(p.qs) ? p.qs.filter((q: any) => q && typeof q.id === 'string' && typeof q.q === 'string' && typeof q.pi === 'number').map((q: any) => ({ id: q.id, pi: q.pi, q: str(q.q, 2000), t: q.t === true, ex: str(q.ex, 4000), lang: LANGS.includes(q.lang) ? q.lang : 'Korean', ...(q.type === 'MC' && Array.isArray(q.opts) ? { type: 'MC' as const, opts: q.opts.map((o: any) => str(o, 1000)), ans: typeof q.ans === 'number' ? q.ans : 0 } : {}) })) : undefined,
            empty: p.empty === true ? true : undefined,
            u: typeof p.u === 'number' ? p.u : undefined,
        };
    });
    return {
        id: x.id,
        title: str(x.title, 300) || '제목 없음',
        source: str(x.source, 500),
        fileName: str(x.fileName, 300),
        pageCount: num(x.pageCount),
        charCount: num(x.charCount),
        createdAt: num(x.createdAt) || Date.now(),
        updatedAt: num(x.updatedAt) || num(x.createdAt) || Date.now(),
        sections,
        progress,
        textParts: Math.max(1, num(x.textParts)),
        round: typeof x.round === 'number' ? x.round : undefined,
        ocr: x.ocr === true ? true : undefined,
        refsFromPage: typeof x.refsFromPage === 'number' ? x.refsFromPage : undefined,
        inPool: x.inPool === false ? false : undefined,
        file: x.file && typeof x.file.path === 'string' ? { path: x.file.path, size: num(x.file.size), at: num(x.file.at) } : undefined,
        deleted: x.deleted === true ? true : undefined,
    };
};

// 클라우드 저장용으로 글을 문서 여러 개로 나눔 (Firestore 문서 하나 1MB 제한 — 한글은 글자당 3바이트라 24만 자씩)
export const splitTextsForCloud = (sections: PdfSectionMeta[], texts: Record<string, string>, maxChars = 240000): Record<string, string>[] => {
    const parts: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    let size = 0;
    sections.forEach(s => {
        const t = texts[s.key] || '';
        if (size > 0 && size + t.length > maxChars) { parts.push(cur); cur = {}; size = 0; }
        cur[s.key] = t;
        size += t.length;
    });
    if (Object.keys(cur).length || parts.length === 0) parts.push(cur);
    return parts;
};

// 새 id (PDF·문제)
export const newPdfId = (prefix: string): string => {
    const rnd = typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
        ? (crypto as any).randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14);
    return `${prefix}${Date.now().toString(36)}${rnd}`;
};

// ----------------------------------------------------------------------------
// PDF 전체 풀 (§5-76): 올린 PDF 여러 개를 한 세션에서 섞어 냄
// - 각 PDF 안에서는 지금처럼 앞 구간부터 빠짐없이(pickPdfQuestion), PDF끼리는 남은 양에 비례한 무작위로 섞음
// - 이미 만들어 둔 문제가 있는 PDF를 조금 더 자주 골라(가중치 ×3) 문제 만드는 기다림을 줄임
// - "PDF 복습에서 빼기"(inPool === false)로 둔 PDF는 풀에서 제외 (그 PDF만 따로 풀기는 가능)
// ----------------------------------------------------------------------------
export const inPdfPool = (d: PdfDoc) => !d.deleted && d.inPool !== false;

export type PoolPick = { doc: PdfDoc; pick: Exclude<PdfPick, { kind: 'done' }> };

export const pickFromPool = (
    docs: PdfDoc[],
    reserved: Map<string, Set<string>>,
    mode: 'all' | 'wrong',
    language: QuizLanguage,
    rand: () => number = Math.random,
    format: PdfFormat = 'OX',
    order: PdfOrder = 'seq',
    prefer?: { docId: string; key: string } | null
): PoolPick | null => {
    const cands: { doc: PdfDoc; pick: PoolPick['pick']; w: number }[] = [];
    docs.forEach(doc => {
        const pick = pickPdfQuestion(doc, reserved.get(doc.id) || new Set(), mode, language, format, rand, order, prefer && prefer.docId === doc.id ? prefer.key : null);
        if (pick.kind === 'done') return;
        const st = pdfStats(doc);
        const remaining = mode === 'wrong' ? Math.max(1, st.wrong) : Math.max(1, st.sections - st.sectionsDone);
        cands.push({ doc, pick, w: remaining * (pick.kind === 'question' ? 3 : 1) });
    });
    if (cands.length === 0) return null;
    const total = cands.reduce((a, c) => a + c.w, 0);
    let x = rand() * total;
    for (const c of cands) {
        x -= c.w;
        if (x < 0) return { doc: c.doc, pick: c.pick };
    }
    const last = cands[cands.length - 1];
    return { doc: last.doc, pick: last.pick };
};

// 풀 전체 진행 (여러 PDF 합계)
export const poolStats = (docs: PdfDoc[]) => {
    const list = docs.filter(inPdfPool).map(pdfStats);
    const sum = (k: keyof PdfStats) => list.reduce((a, s) => a + (s[k] as number), 0);
    const sections = sum('sections');
    const sectionsDone = sum('sectionsDone');
    return {
        docs: list.length,
        docsDone: list.filter(s => s.roundDone).length,
        sections, sectionsDone,
        points: sum('points'), ok: sum('ok'), wrong: sum('wrong'),
        percent: sections ? Math.round((sectionsDone / sections) * 100) : 0,
        allDone: list.length > 0 && list.every(s => s.roundDone || s.sections === 0),
    };
};

// PDF 복습 문제 형식 기억 (퀴즈 첫 화면·자료실 공통, §5-79)
export type PdfQuizFormat = 'QUICK_OX' | 'DETAILED' | 'MIXED';
export const PDF_FORMAT_LABEL: Record<PdfQuizFormat, string> = { QUICK_OX: 'OX', DETAILED: '케이스', MIXED: '섞어서' };
const PDF_FORMAT_KEY = 'medinote_pdf_format';
export const readPdfQuizFormat = (): PdfQuizFormat => {
    try { const v = localStorage.getItem(PDF_FORMAT_KEY); return v === 'DETAILED' || v === 'MIXED' ? v : 'QUICK_OX'; } catch { return 'QUICK_OX'; }
};
export const savePdfQuizFormat = (f: PdfQuizFormat) => { try { localStorage.setItem(PDF_FORMAT_KEY, f); } catch { /* 이번 화면에선 동작 */ } };

// PDF 출제 순서 기억 (§5-81) — 처음 기본값은 무작위
const PDF_ORDER_KEY = 'medinote_pdf_order';
export const readPdfOrder = (): PdfOrder => {
    try { return localStorage.getItem(PDF_ORDER_KEY) === 'seq' ? 'seq' : 'random'; } catch { return 'random'; }
};
export const savePdfOrder = (o: PdfOrder) => { try { localStorage.setItem(PDF_ORDER_KEY, o); } catch { /* 이번 화면에선 동작 */ } };
