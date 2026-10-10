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
    | { kind: 'generate'; section: PdfSectionMeta; sectionIndex: number; sectionCount: number; pointIndexes: number[] | null; format: 'OX' | 'MC' | 'CQ' }
    | { kind: 'done' };

// 문제 형식 (§5-79): OX / 케이스(임상 응용 5지선다) / 섞어서(문제마다 반반)
// CQ = 내용 이해 5지선다 (§5-85). 섞어서 = OX 40% · 케이스 30% · 내용 5지선다 30%
export type PdfFormat = 'OX' | 'MC' | 'CQ' | 'MIX';
export const qFormat = (q: PdfQuestion): 'OX' | 'MC' | 'CQ' => (q.type === 'MC' ? 'MC' : q.type === 'CQ' ? 'CQ' : 'OX');
export const pickMixFormat = (r: number): 'OX' | 'MC' | 'CQ' => (r < 0.4 ? 'OX' : r < 0.7 ? 'MC' : 'CQ');

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
    preferKey?: string | null, // 무작위일 때: 방금 문제를 만든 구간을 먼저 (이어서 다른 구간을 또 만들며 기다리지 않게)
    avoidKeys?: string[] | null, // 무작위일 때: 최근에 낸 구간 (오래된 것 → 최근 순, §5-86c)
    grow: boolean = true // §5-86f: false = 지금 바로 낼 문제가 필요(화면이 기다리는 중) → 만들어 둔 문제 먼저. true = 미리 만들기 중 → 필요하면 새 구간을 펼침
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
            const usable = qs.filter(x => !questionContextless(x)); // §5-86e
            const withQ = pending.filter(({ p, i }) => usable.some(x => x.id === p.wq || x.pi === i));
            if (withQ.length) {
                const { p, i } = pickIn(withQ);
                const q = usable.find(x => x.id === p.wq) || usable.find(x => x.pi === i)!;
                return { kind: 'question', ...base, question: q };
            }
            return { kind: 'generate', ...base, pointIndexes: [pending[0].i], format: format === 'MC' || format === 'CQ' ? format : 'OX' };
        }
        // 형식은 고른 것(섞어서면 요점마다 비율대로)
        const fmt: 'OX' | 'MC' | 'CQ' = format === 'MIX' ? pickMixFormat(rand()) : format;
        // §5-86f: 이미 만들어 둔 문제가 있는 요점부터 (섞어서이고 지금 바로 필요하면 형식 무관)
        const anyFmt = format === 'MIX' && !grow;
        const usable = (x: PdfQuestion) => x.lang === language && !questionContextless(x) && (anyFmt || qFormat(x) === fmt); // §5-86e
        const ready = pending.filter(({ i }) => qs.some(x => x.pi === i && usable(x)));
        if (ready.length) {
            const { i } = pickIn(ready);
            const cand = qs.filter(x => x.pi === i && usable(x));
            return { kind: 'question', ...base, question: cand.find(x => qFormat(x) === fmt) || cand[0] };
        }
        const { i } = pickIn(pending);
        if (fmt !== 'OX') return { kind: 'generate', ...base, pointIndexes: [i], format: fmt };
        // OX는 한 번에: 이 언어의 OX가 없는 안 푼 요점 전부
        const missing = pending.filter(x => !qs.some(q2 => q2.pi === x.i && q2.lang === language && qFormat(q2) === 'OX' && !questionContextless(q2))).map(x => x.i);
        return { kind: 'generate', ...base, pointIndexes: missing.length ? missing : [i], format: 'OX' };
    };

    if (order === 'seq') {
        for (const s of list) {
            const r = sectionPick(s);
            if (r) return r;
        }
        return { kind: 'done' };
    }

    // 무작위 (§5-86c): 문제마다 안 푼 요점이 남은 구간 전체(펼친 구간·안 펼친 구간 모두) 중에서 새로 고름.
    // 최근에 낸 구간(avoidKeys)은 다른 구간이 있으면 피함 → 한 구간만 연달아 나오지 않음. 구간 안의 요점 순서도 무작위.
    // (예전 §5-81은 펼친 구간을 마저 풀어 같은 구간이 10문제씩 이어졌음. 새 구간 문제 만들기는 미리 만들어 두기로 가림)
    if (preferKey) {
        const ps = list.find(s => s.key === preferKey);
        const r = ps ? sectionPick(ps) : null;
        if (r) return r;
    }
    const cands = list.map(sectionPick).filter((x): x is Exclude<PdfPick, { kind: 'done' }> => !!x);
    if (cands.length === 0) return { kind: 'done' };
    const recent = (avoidKeys || []).filter(Boolean);
    const last = recent[recent.length - 1];
    const one = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length) % arr.length];
    const notRecent = cands.filter(c => !recent.includes(c.section.key));
    const notLast = cands.filter(c => c.section.key !== last);
    const base = notRecent.length ? notRecent : notLast.length ? notLast : cands;
    // §5-86f: 만들어 둔 문제가 있는 구간을 돌려 가며 내고(기다림 없음), 그런 구간이 적을 때만 미리 만들기 중에 새 구간을 펼침
    const readyAll = cands.filter(c => c.kind === 'question');
    const readyBase = base.filter(c => c.kind === 'question');
    const genBase = base.filter(c => c.kind === 'generate');
    if (grow) {
        if (genBase.length && readyAll.length < MIN_READY_SECTIONS) return one(genBase);
        return one(readyBase.length ? readyBase : base);
    }
    if (readyBase.length) return one(readyBase);
    const readyNotLast = readyAll.filter(c => c.section.key !== last);
    if (readyNotLast.length) return one(readyNotLast);
    if (readyAll.length && genBase.length === 0) return one(readyAll);
    return one(genBase.length ? genBase : base);
};

// 무작위 순서에서 "만들어 둔 문제가 있는 구간"을 이만큼은 유지 (최근 피하기 3개보다 많게) (§5-86f)
export const MIN_READY_SECTIONS = 4;

export interface GeneratedItem { point: string; statement: string; isTrue: boolean; explanation: string; ok?: boolean; meta?: boolean }

// 정답 검증에 실패했거나 사용자가 "문제 오류"로 뺀 요점: 실패 횟수를 세고, 2번이면 이번 바퀴에서 건너뜀 (§5-82)
export const MAX_POINT_FAILS = 2;
const bumpFail = (pt: PdfPoint): PdfPoint => {
    const fa = (pt.fa || 0) + 1;
    return { ...pt, fa, x: fa >= MAX_POINT_FAILS ? true : undefined };
};
// §5-86e: 문서를 봐야만 풀리는 지칭이 들어간 문제는 AI 판단과 상관없이 코드로 걸러냄 (내지 않고 다시 만듦)
// "이 각주가 가리키는 약", "본 연구", "두 군", "this study", "the footnote" 등. 해설(ex)은 보지 않음
const CONTEXTLESS_RE = new RegExp([
    // 일본어 (日本研究·基本試験 같은 말은 제외)
    'この(脚注|注釈|研究|試験|報告書?|論文|表|図|コホート|解析|調査|症例群)', '(?<![日基資根標])本(研究|試験|報告書?|論文|解析|調査)', '脚注',
    '上記の', '前述の', '下記の', '両群', '非典型群', '典型群と', 'と典型群',
    // 한국어 (앞이 띄어쓰기·문장 처음일 때만: "많이 연구된"·"기본 연구"는 제외)
    '(^|[\\s(“"\'])(이|본) (각주|연구|시험|논문|보고서|표|그림|코호트|분석|조사)', '각주', '위의 표', '앞서 말한', '두 군(?!데)', '(^|\\s)양군',
    // 영어
    '\\bth(is|e present) (study|trial|report|paper|footnote|table|figure|cohort|analysis|survey)\\b', '\\bfootnote', '\\bthe above\\b', '\\bthe authors\\b', '\\bboth groups\\b',
].join('|'), 'i');
export const looksContextless = (text: string | undefined | null): boolean => !!text && CONTEXTLESS_RE.test(text);
const questionContextless = (q: PdfQuestion) => looksContextless(q.q) || (q.opts || []).some(o => looksContextless(o));

// §5-86b: 예전에 만든 요점·문제 중 문서 자체에 관한 것(목적·면책 문구·근거 수준 등)을 한 번 걸러냄
export const META_SCREEN_VERSION = 2; // 2 (§5-86d): 무엇에 관한 문제인지 모르는 문제(근거 없이 "두 군" 등·p값만)도 지우고 다시 만듦
export const needsMetaScreen = (prog: PdfSectionProgress | undefined): boolean =>
    !!prog?.pts?.some(p => !p.m) && (prog?.mc || 0) < META_SCREEN_VERSION;
// metaIdx: 검사에서 문서 자체에 관한 것으로 나온 요점 번호 → 영구 제외 + 그 요점의 문제 지움
// unclearIdx: 요점은 남기고 저장된 문제만 지움 (다음에 새 규칙으로 다시 만듦)
export const applyMetaScreen = (prev: PdfSectionProgress | undefined, metaIdx: number[], now: number, unclearIdx: number[] = []): PdfSectionProgress => {
    const bad = new Set(metaIdx);
    const redo = new Set(unclearIdx);
    const pts = (prev?.pts || []).map((p, i) => (bad.has(i) ? markMeta(p) : redo.has(i) ? { ...p, wq: undefined } : p));
    const qs = (prev?.qs || []).filter(q => !bad.has(q.pi) && !redo.has(q.pi));
    return { ...(prev || {}), pts, qs, mc: META_SCREEN_VERSION, u: now };
};
export const isSkippedPoint = (pt: PdfPoint) => pt.x === true || pt.m === true; // m: 의학 지식이 아닌 요점 — 바퀴를 새로 돌아도 계속 제외 (§5-86)
const markMeta = (pt: PdfPoint): PdfPoint => ({ ...pt, m: true, wq: undefined });

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
    const valid = items.filter(it => it && (it.meta === true || (typeof it.statement === 'string' && it.statement.trim() && typeof it.isTrue === 'boolean')));
    if (pointIndexes === null) {
        // §5-86: 요점 목록을 새로 만들 때 문서 자체에 관한 요점은 아예 넣지 않음 (전부 그런 구간이면 빈 구간)
        const medical = valid.filter(it => !it.meta);
        valid.splice(0, valid.length, ...medical);
        if (valid.length === 0) return { ...(prev || {}), empty: true, pts: [], qs: [], u: now };
        // 검증에서 정답이 안 맞은 문제(ok === false)는 버리고 요점만 남김 → 다음에 그 요점 문제를 다시 만듦
        const bad = (it: GeneratedItem) => it.ok === false || looksContextless(it.statement); // §5-86e
        const pts: PdfPoint[] = valid.map(it => {
            const pt: PdfPoint = { p: (it.point || '').trim().slice(0, 80) || it.statement.slice(0, 40), st: 'new' };
            return bad(it) ? bumpFail(pt) : pt;
        });
        const qs: PdfQuestion[] = valid
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => !bad(it))
            .map(({ it, i }) => ({ id: makeId(), pi: i, q: it.statement.trim(), t: it.isTrue, ex: (it.explanation || '').trim(), lang: language }));
        return { ...(prev || {}), pts, qs, empty: undefined, mc: META_SCREEN_VERSION, u: now }; // 새 목록은 이미 의학 지식만 (§5-86)
    }
    const pts = [...(prev?.pts || [])];
    let qs = [...(prev?.qs || [])];
    pointIndexes.forEach((pi, k) => {
        const it = valid[k];
        if (!pts[pi]) return;
        if (it?.meta) { pts[pi] = markMeta(pts[pi]); qs = qs.filter(q => q.pi !== pi); return; } // §5-86
        if (!it || it.ok === false || looksContextless(it.statement)) { pts[pi] = bumpFail(pts[pi]); return; } // 못 만들었거나 검증 불일치·맥락 없음(§5-86e)
        qs = qs.filter(q => !(q.pi === pi && qFormat(q) === 'OX' && (q.lang === language || pts[pi].st === 'new')));
        qs.push({ id: makeId(), pi, q: it.statement.trim(), t: it.isTrue, ex: (it.explanation || '').trim(), lang: language });
    });
    return { ...(prev || {}), pts, qs, u: now };
};

// 케이스(5지선다) 문제 하나를 요점에 붙이기 (§5-79). 같은 요점·언어의 예전 케이스 문제는 바꿈
export interface GeneratedCase { question: string; options: string[]; correctAnswerIndex: number; explanation: string; meta?: boolean }
export const applyGeneratedCase = (
    prev: PdfSectionProgress | undefined,
    pointIndex: number,
    item: GeneratedCase | null,
    language: QuizLanguage,
    makeId: () => string,
    now: number,
    kind: 'MC' | 'CQ' = 'MC' // MC 케이스 / CQ 내용 이해 5지선다 (§5-85)
): PdfSectionProgress => {
    if (item?.meta) {
        // §5-86: 의학 지식이 아닌 요점 → 영구 제외, 그 요점의 문제도 지움
        const pts = [...(prev?.pts || [])];
        if (pts[pointIndex]) pts[pointIndex] = markMeta(pts[pointIndex]);
        return { ...(prev || {}), pts, qs: (prev?.qs || []).filter(q => q.pi !== pointIndex), u: now };
    }
    if (!item || !item.question || !Array.isArray(item.options) || item.options.length < 2 || looksContextless(item.question) || item.options.some(o => looksContextless(o))) {
        // 못 만들었거나 정답 검증 불일치 → 실패 횟수 (2번이면 이번 바퀴 건너뜀)
        const pts = [...(prev?.pts || [])];
        if (pts[pointIndex]) pts[pointIndex] = bumpFail(pts[pointIndex]);
        return { ...(prev || {}), pts, u: now };
    }
    const qs = (prev?.qs || []).filter(q => !(q.pi === pointIndex && qFormat(q) === kind && q.lang === language));
    const ans = Math.min(Math.max(0, Math.round(item.correctAnswerIndex || 0)), item.options.length - 1);
    qs.push({ id: makeId(), pi: pointIndex, type: kind, q: item.question.trim(), t: false, opts: item.options.map(o => String(o)), ans, ex: (item.explanation || '').trim(), lang: language });
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
        ok += live.filter(x => x.st === 'ok').length;
        wrong += live.filter(x => x.st === 'wrong').length;
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
        type: qFormat(q) === 'OX' ? 'OX' : 'MULTIPLE_CHOICE',
        ...(qFormat(q) === 'CQ' ? { style: 'concept' as const } : {}),
        question: q.q,
        options: qFormat(q) !== 'OX' ? (q.opts || []) : ['O', 'X'],
        correctAnswerIndex: qFormat(q) !== 'OX' ? (q.ans || 0) : (q.t ? 0 : 1),
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
        .map((s: any) => ({ key: s.key, label: str(s.label, 40), pageFrom: num(s.pageFrom), pageTo: num(s.pageTo), chars: num(s.chars), head: str(s.head, 80), excluded: s.excluded === true ? true : undefined, fig: s.fig === true ? true : undefined }));
    const progress: Record<string, PdfSectionProgress> = {};
    Object.entries(x.progress && typeof x.progress === 'object' ? x.progress : {}).forEach(([k, p]: [string, any]) => {
        if (!/^s\d+$/.test(k) || !p || typeof p !== 'object') return;
        progress[k] = {
            pts: Array.isArray(p.pts) ? p.pts.map((t: any) => ({ p: str(t?.p, 120), st: t?.st === 'ok' || t?.st === 'wrong' ? t.st : 'new', at: typeof t?.at === 'number' ? t.at : undefined, wc: typeof t?.wc === 'number' ? t.wc : undefined, wq: typeof t?.wq === 'string' ? t.wq : undefined, fa: typeof t?.fa === 'number' ? t.fa : undefined, x: t?.x === true ? true : undefined, m: t?.m === true ? true : undefined })) : undefined,
            qs: Array.isArray(p.qs) ? p.qs.filter((q: any) => q && typeof q.id === 'string' && typeof q.q === 'string' && typeof q.pi === 'number').map((q: any) => ({ id: q.id, pi: q.pi, q: str(q.q, 2000), t: q.t === true, ex: str(q.ex, 4000), lang: LANGS.includes(q.lang) ? q.lang : 'Korean', ...((q.type === 'MC' || q.type === 'CQ') && Array.isArray(q.opts) ? { type: q.type as 'MC' | 'CQ', opts: q.opts.map((o: any) => str(o, 1000)), ans: typeof q.ans === 'number' ? q.ans : 0 } : {}) })) : undefined,
            empty: p.empty === true ? true : undefined,
            mc: typeof p.mc === 'number' ? p.mc : undefined,
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
        figAt: typeof x.figAt === 'number' ? x.figAt : undefined,
        figCount: typeof x.figCount === 'number' ? x.figCount : undefined,
        mdKeys: Array.isArray(x.mdKeys) ? x.mdKeys.filter((k: any) => typeof k === 'string' && /^s\d+$/.test(k)) : undefined,
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
    prefer?: { docId: string; key: string } | null,
    recent?: { docId: string; key: string }[] | null, // 최근에 낸 구간 (§5-86c)
    grow: boolean = true // §5-86f
): PoolPick | null => {
    const cands: { doc: PdfDoc; pick: PoolPick['pick']; w: number }[] = [];
    docs.forEach(doc => {
        const avoid = (recent || []).filter(r => r.docId === doc.id).map(r => r.key);
        const pick = pickPdfQuestion(doc, reserved.get(doc.id) || new Set(), mode, language, format, rand, order, prefer && prefer.docId === doc.id ? prefer.key : null, avoid, grow);
        if (pick.kind === 'done') return;
        const st = pdfStats(doc);
        const remaining = mode === 'wrong' ? Math.max(1, st.wrong) : Math.max(1, st.sections - st.sectionsDone);
        cands.push({ doc, pick, w: remaining * (pick.kind === 'question' ? 3 : 1) });
    });
    if (cands.length === 0) return null;
    // §5-86f: 지금 바로 필요하면 만들어 둔 문제가 있는 PDF만
    const now = !grow ? cands.filter(c => c.pick.kind === 'question') : [];
    if (now.length) cands.splice(0, cands.length, ...now);
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
// §5-85: 메모 퀴즈·PDF 복습 공통 "문제 형식" (퀴즈 첫 화면 위 선택 하나)
export type PdfQuizFormat = 'QUICK_OX' | 'DETAILED' | 'CONCEPT' | 'MIXED';
export const QUIZ_FORMATS: PdfQuizFormat[] = ['QUICK_OX', 'DETAILED', 'CONCEPT', 'MIXED'];
export const PDF_FORMAT_LABEL: Record<PdfQuizFormat, string> = { QUICK_OX: 'OX', DETAILED: '케이스', CONCEPT: '5지선다', MIXED: '섞어서' };
export const QUIZ_FORMAT_HINT: Record<PdfQuizFormat, string> = {
    QUICK_OX: '참/거짓 문장 — 조건·예외·기준까지 알아야 풀리게',
    DETAILED: '임상 상황을 주고 판단을 묻는 5지선다',
    CONCEPT: '임상 케이스 없이 내용 이해를 묻는 5지선다 (옳은/틀린 것 고르기, 기준·비교 등)',
    MIXED: '문제마다 OX·케이스·5지선다를 섞어서',
};
// 버튼 문구용 ("OX로 시작", "섞어서 시작")
export const QUIZ_FORMAT_WITH: Record<PdfQuizFormat, string> = { QUICK_OX: 'OX로', DETAILED: '케이스 문제로', CONCEPT: '5지선다로', MIXED: '섞어서' };
const PDF_FORMAT_KEY = 'medinote_quiz_format';
const OLD_PDF_FORMAT_KEY = 'medinote_pdf_format';
export const readPdfQuizFormat = (): PdfQuizFormat => {
    try {
        const v = localStorage.getItem(PDF_FORMAT_KEY) ?? localStorage.getItem(OLD_PDF_FORMAT_KEY);
        return v === 'DETAILED' || v === 'CONCEPT' || v === 'MIXED' ? v : 'QUICK_OX';
    } catch { return 'QUICK_OX'; }
};
export const savePdfQuizFormat = (f: PdfQuizFormat) => { try { localStorage.setItem(PDF_FORMAT_KEY, f); } catch { /* 이번 화면에선 동작 */ } };

// PDF 출제 순서 기억 (§5-81) — 처음 기본값은 무작위
const PDF_ORDER_KEY = 'medinote_pdf_order';
export const readPdfOrder = (): PdfOrder => {
    try { return localStorage.getItem(PDF_ORDER_KEY) === 'seq' ? 'seq' : 'random'; } catch { return 'random'; }
};
export const savePdfOrder = (o: PdfOrder) => { try { localStorage.setItem(PDF_ORDER_KEY, o); } catch { /* 이번 화면에선 동작 */ } };
