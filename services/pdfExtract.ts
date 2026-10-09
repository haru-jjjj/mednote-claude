// ============================================================================
// PDF 글 뽑기·구간 나누기 (§5-75)
// - PDF.js(Mozilla)를 필요할 때만 CDN에서 불러옴 → 앱 용량·설치 패키지 변화 없음
//   https://mozilla.github.io/pdf.js/
// - 글이 있는 PDF는 브라우저에서 바로 글을 뽑음(무료). 사진(스캔) PDF는 쪽을 그림으로 만들어 AI가 읽음(선택)
// - 쪽마다 반복되는 머리말·꼬리말(저널 이름·쪽 번호)은 빼고, 뒤쪽의 참고문헌은 출제에서 뺌
// ============================================================================

import type { PdfSectionMeta } from '../types';

const PDFJS_VERSION = '4.10.38';
// legacy 빌드: 오래된 iOS Safari에서도 동작하는 판 (같은 기능)
const PDFJS_BASES = [
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`,
    `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`,
];

let pdfjsPromise: Promise<any> | null = null;
export const loadPdfJs = (): Promise<any> => {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = (async () => {
        let lastErr: any = null;
        for (const base of PDFJS_BASES) {
            try {
                const lib: any = await import(/* @vite-ignore */ `${base}pdf.min.mjs`);
                lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
                return lib;
            } catch (e) {
                lastErr = e;
                console.warn('PDF.js 불러오기 실패, 다른 주소로 시도', base, e);
            }
        }
        throw new Error(`PDF 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인해주세요. (${lastErr?.message || lastErr})`);
    })();
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
    return pdfjsPromise;
};

export const MAX_PDF_BYTES = 60 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const MAX_STORED_CHARS = 400000; // 이보다 길면 뒤를 자름 (약 150~200쪽 분량)
export const MAX_OCR_PAGES = 60;

export interface ExtractedPdf {
    pages: string[]; // 쪽마다 글 (0부터)
    pageCount: number;
    info: { title?: string; author?: string; subject?: string };
    doc: any; // PDF.js 문서 (사진 PDF 읽기에 다시 씀) — 다 쓰면 destroy()
    visuals: PageVisual[]; // 그림·표가 있어 보이는 쪽 (§5-84)
}

export const openPdf = async (file: File | ArrayBuffer): Promise<any> => {
    const lib = await loadPdfJs();
    const data = file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());
    return lib.getDocument({ data, isEvalSupported: false }).promise;
};

// 쪽 하나의 글: PDF.js가 준 조각을 이어 붙이고 줄바꿈 표시(hasEOL)를 살림
export const pageItemsToText = (items: { str?: string; hasEOL?: boolean }[]): string => {
    let out = '';
    for (const it of items) {
        const s = typeof it.str === 'string' ? it.str : '';
        if (s) {
            if (out && !/\s$/.test(out) && !/^\s/.test(s) && /[A-Za-z0-9.,;:)\]]$/.test(out) && /^[A-Za-z0-9(\[]/.test(s)) out += ' ';
            out += s;
        }
        if (it.hasEOL) out += '\n';
    }
    return out;
};

export const extractPdfText = async (file: File, onProgress?: (done: number, total: number) => void): Promise<ExtractedPdf> => {
    if (file.size > MAX_PDF_BYTES) throw new Error(`파일이 너무 큽니다 (${Math.round(file.size / 1024 / 1024)}MB). ${MAX_PDF_BYTES / 1024 / 1024}MB 이하로 올려주세요.`);
    const doc = await openPdf(file);
    const pageCount: number = doc.numPages;
    if (pageCount > MAX_PDF_PAGES) {
        doc.destroy?.();
        throw new Error(`쪽 수가 너무 많습니다 (${pageCount}쪽). ${MAX_PDF_PAGES}쪽 이하로 나눠 올려주세요.`);
    }
    const pages: string[] = [];
    const visuals: PageVisual[] = [];
    const lib = await loadPdfJs();
    for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const text = pageItemsToText(tc.items || []);
        pages.push(text);
        // 그림·표 감지 (§5-84) — 실패해도 글 뽑기는 계속
        try {
            const v = await pageVisualInfo(page, lib);
            const reasons = visualReasons(v, text);
            if (reasons.length) visuals.push({ page: i, reasons });
        } catch (e) { console.warn('그림 감지 실패', i, e); }
        page.cleanup?.();
        onProgress?.(i, pageCount);
    }
    let info: ExtractedPdf['info'] = {};
    try {
        const meta = await doc.getMetadata();
        const i = meta?.info || {};
        info = { title: typeof i.Title === 'string' ? i.Title.trim() : undefined, author: typeof i.Author === 'string' ? i.Author.trim() : undefined, subject: typeof i.Subject === 'string' ? i.Subject.trim() : undefined };
    } catch { /* 정보 없으면 그냥 넘어감 */ }
    return { pages, pageCount, info, doc, visuals };
};

// 사진(스캔) PDF인지: 쪽당 글자가 거의 없으면
export const looksScanned = (pages: string[]): boolean => {
    if (pages.length === 0) return false;
    const total = pages.reduce((a, p) => a + p.replace(/\s/g, '').length, 0);
    return total / pages.length < 80;
};

// 사진 PDF: 쪽을 JPEG(base64, 머리글 없이)로 — AI가 글자를 읽도록
export const renderPageJpeg = async (doc: any, pageNo: number, maxWidth = 1400): Promise<string> => {
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, maxWidth / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const url = canvas.toDataURL('image/jpeg', 0.82);
    page.cleanup?.();
    canvas.width = 0; canvas.height = 0;
    return url.slice(url.indexOf(',') + 1);
};

// ----------------------------------------------------------------------------
// 글 다듬기 (순수 함수 — 테스트 가능)
// ----------------------------------------------------------------------------
const normLine = (l: string) => l.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();

// 쪽마다 반복되는 머리말·꼬리말(위·아래 2줄 중 절반 이상의 쪽에 나오는 80자 이하 줄)과 쪽 번호만 있는 줄을 뺌
export const cleanPages = (pages: string[]): string[] => {
    const split = pages.map(p => p.replace(/\r/g, '').split('\n'));
    const counts = new Map<string, number>();
    split.forEach(lines => {
        const nonEmpty = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim());
        const edge = [...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)];
        new Set(edge.map(x => normLine(x.l))).forEach(k => { if (k) counts.set(k, (counts.get(k) || 0) + 1); });
    });
    const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
    return split.map(lines => {
        const nonEmpty = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim());
        const edgeIdx = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)].map(x => x.i));
        const kept = lines.filter((l, i) => {
            const t = l.trim();
            if (!t) return true;
            if (edgeIdx.has(i) && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t)) return false;
            if (edgeIdx.has(i) && t.length <= 80 && (counts.get(normLine(l)) || 0) >= threshold) return false;
            return true;
        });
        return kept.join('\n')
            .replace(/([A-Za-z])-\n([a-z])/g, '$1$2') // 줄 끝 하이픈으로 끊긴 영어 단어 잇기
            .replace(/([^\n.:;!?。])\n(?=[a-z(])/g, '$1 ') // 문장 중간에서 끊긴 줄 잇기 (다음 줄이 소문자로 시작)
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    });
};

// 참고문헌 시작 위치 (문서 뒤쪽 40% 안에서 "References" 같은 제목 줄) — 없으면 null
const REF_HEADING = /^(?:\d+\.?\s*)?(references|bibliography|literature cited|works cited|참\s*고\s*문\s*헌|文\s*献|参考文献)\s*:?$/i;
export const findReferencesStart = (pages: string[]): { page: number; offset: number } | null => {
    const from = Math.floor(pages.length * 0.6);
    for (let p = Math.max(0, from); p < pages.length; p++) {
        const lines = pages[p].split('\n');
        let off = 0;
        for (const l of lines) {
            if (REF_HEADING.test(l.trim())) return { page: p, offset: off };
            off += l.length + 1;
        }
    }
    return null;
};

export interface BuiltSections {
    sections: PdfSectionMeta[];
    texts: Record<string, string>;
    charCount: number;
    refsFromPage?: number; // 1부터
    truncated: boolean;
}

const TARGET = 2600; // 구간 하나 목표 글자 수 (OX 4~10개 분량)
const MAX = 4200;
const MIN_TAIL = 700;

// 긴 쪽은 문단 단위로 MAX 이하로 쪼갬
const splitLong = (text: string): string[] => {
    if (text.length <= MAX) return [text];
    const paras = text.split(/\n\n+|\n(?=[A-Z가-힣0-9•\-–])/);
    const out: string[] = [];
    let cur = '';
    for (const para of paras) {
        if (para.length > MAX) {
            if (cur) { out.push(cur); cur = ''; }
            for (let i = 0; i < para.length; i += TARGET) out.push(para.slice(i, i + TARGET));
            continue;
        }
        if (cur && cur.length + para.length + 1 > TARGET) { out.push(cur); cur = ''; }
        cur = cur ? `${cur}\n${para}` : para;
    }
    if (cur) out.push(cur);
    return out;
};

const firstLine = (t: string) => (t.split('\n').find(l => l.trim().length >= 3) || '').trim().slice(0, 60);

export const buildPdfSections = (rawPages: string[]): BuiltSections => {
    const pages = cleanPages(rawPages);
    const refs = findReferencesStart(pages);
    let usePages = pages;
    if (refs) {
        usePages = pages.slice(0, refs.page + 1);
        usePages[refs.page] = pages[refs.page].slice(0, refs.offset).trim();
    }
    // 저장 한도
    let total = 0;
    let truncated = false;
    const limited: string[] = [];
    for (const p of usePages) {
        if (total + p.length > MAX_STORED_CHARS) { limited.push(p.slice(0, Math.max(0, MAX_STORED_CHARS - total))); truncated = true; break; }
        limited.push(p);
        total += p.length;
    }

    type Chunk = { from: number; to: number; text: string; piece?: string };
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    limited.forEach((text, i) => {
        const pageNo = i + 1;
        if (!text.trim()) return;
        if (text.length > MAX) {
            if (cur) { chunks.push(cur); cur = null; }
            const parts = splitLong(text);
            parts.forEach((t, k) => chunks.push({ from: pageNo, to: pageNo, text: t, piece: parts.length > 1 ? `${k + 1}/${parts.length}` : undefined }));
            return;
        }
        if (cur && cur.text.length + text.length + 2 > MAX) { chunks.push(cur); cur = null; }
        cur = cur ? { from: cur.from, to: pageNo, text: `${cur.text}\n\n${text}` } : { from: pageNo, to: pageNo, text };
        if (cur.text.length >= TARGET) { chunks.push(cur); cur = null; }
    });
    if (cur) chunks.push(cur);
    // 너무 짧은 마지막 구간은 앞 구간에 붙임
    if (chunks.length >= 2) {
        const last = chunks[chunks.length - 1];
        const prev = chunks[chunks.length - 2];
        if (last.text.length < MIN_TAIL && !last.piece && !prev.piece && prev.text.length + last.text.length <= MAX + MIN_TAIL) {
            chunks.splice(chunks.length - 2, 2, { from: prev.from, to: last.to, text: `${prev.text}\n\n${last.text}` });
        }
    }

    const sections: PdfSectionMeta[] = [];
    const texts: Record<string, string> = {};
    chunks.forEach((c, i) => {
        const key = `s${i}`;
        const label = `p.${c.from}${c.to !== c.from ? `–${c.to}` : ''}${c.piece ? ` (${c.piece})` : ''}`;
        sections.push({ key, label, pageFrom: c.from, pageTo: c.to, chars: c.text.length, head: firstLine(c.text) });
        texts[key] = c.text;
    });
    return {
        sections,
        texts,
        charCount: Object.values(texts).reduce((a, t) => a + t.length, 0),
        refsFromPage: refs ? refs.page + 1 : undefined,
        truncated,
    };
};

// ----------------------------------------------------------------------------
// 읽기용 마크다운 정리본이 원래 글과 같은 내용인지 (§5-83) — 순수 함수
// - 글자(문자·숫자) 양이 원래 글의 88~112% 안
// - 원래 글의 숫자(수치·용량·기간·쪽 등)가 빠지거나 바뀌지 않았는지: 빠진 숫자 ≤ max(1, 2%), 새로 생긴 숫자 ≤ 2%(50개 미만이면 0)
// ----------------------------------------------------------------------------
const stripMd = (md: string) => md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^\s*:?-{3,}:?(\s+:?-{3,}:?)*\s*$/gm, '')
    .replace(/[*_`~]/g, '');
const letterCount = (t: string) => (t.match(/[\p{L}\p{N}]/gu) || []).length;
const numbersOf = (t: string) => (t.match(/\d+(?:[.,]\d+)*/g) || []).map(x => x.replace(/,/g, ''));

export const mdLooksFaithful = (raw: string, md: string): { ok: boolean; ratio: number; missing: number; extra: number } => {
    const plain = stripMd(md || '');
    const a = letterCount(raw || '');
    const b = letterCount(plain);
    const ratio = a ? b / a : 0;
    const bag = new Map<string, number>();
    numbersOf(plain).forEach(n => bag.set(n, (bag.get(n) || 0) + 1));
    let missing = 0;
    const rawNums = numbersOf(raw || '');
    rawNums.forEach(n => { const c = bag.get(n) || 0; if (c > 0) bag.set(n, c - 1); else missing++; });
    let extra = 0;
    bag.forEach(c => { extra += c; });
    const ok = a > 0 && ratio >= 0.88 && ratio <= 1.12
        && missing <= Math.max(1, Math.ceil(rawNums.length * 0.02))
        && extra <= Math.floor(rawNums.length * 0.02); // 새로 생긴 숫자는 사실상 0 — 숫자 하나만 바뀌어도 걸러짐
    return { ok, ratio, missing, extra };
};

// ============================================================================
// 그림·표 (§5-84)
// - 쪽마다 PDF.js 그리기 명령을 훑어 큰 그림(사진·스캔된 그림)의 면적, 선·도형 수(벡터 그래프·표 테두리)를 세고,
//   글에 "Figure 2 / Table 1 / 図1 / 表1 / 그림 1 / 표 1"로 시작하는 줄(캡션)이 있는지 봄
// - 고른 쪽은 그림으로 만들어 AI가 표는 값 그대로 표로, 그림은 설명으로 옮김 → "그림·표 구간"으로 추가
// ============================================================================
export interface PageVisual { page: number; reasons: string[] }
export interface PageVisualInfo { imageFrac: number; paths: number }

const IMAGE_OPS = ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintInlineImageXObjectGroup', 'paintImageMaskXObjectGroup'];

export const pageVisualInfo = async (page: any, lib: any): Promise<PageVisualInfo> => {
    const OPS = lib.OPS;
    const mul = (m1: number[], m2: number[]) => (lib.Util?.transform ? lib.Util.transform(m1, m2) : [
        m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]);
    const vp = page.getViewport({ scale: 1 });
    const pageArea = Math.max(1, vp.width * vp.height);
    const imageOps = new Set(IMAGE_OPS.map(n => OPS[n]).filter((x: any) => typeof x === 'number'));
    const ol = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    let imageArea = 0;
    let paths = 0;
    for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        const args = ol.argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() || ctm;
        else if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) ctm = mul(ctm, args as number[]);
        else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) && args[0].length >= 6) ctm = mul(ctm, args[0]); }
        else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
        else if (fn === OPS.constructPath) paths++;
        else if (imageOps.has(fn)) {
            const w = Math.hypot(ctm[0], ctm[1]);
            const h = Math.hypot(ctm[2], ctm[3]);
            imageArea += w * h;
        }
    }
    return { imageFrac: Math.min(1, imageArea / pageArea), paths };
};

const FIG_CAPTION = /^\s*(?:Figure|Fig\.?|Algorithm|Flowchart|Central Illustration|図|그림)\s*[\dA-Z]/im;
const TABLE_CAPTION = /^\s*(?:Table|表|표)\s*[\dA-Z]/im;

// 감지 이유 (없으면 그림·표 없는 쪽). 로고 같은 작은 그림은 쪽 면적 3% 미만이라 빠짐
export const visualReasons = (v: PageVisualInfo, text: string): string[] => {
    const r: string[] = [];
    if (v.imageFrac >= 0.03) r.push('image');
    if (v.paths >= 120) r.push('drawing');
    if (FIG_CAPTION.test(text || '')) r.push('figure-caption');
    if (TABLE_CAPTION.test(text || '')) r.push('table-caption');
    return r;
};

// AI가 옮긴 표의 숫자가 그 쪽 PDF 글에 실제로 있는지 확인 — 10% 넘게(2개 이상) 없으면 그 표에 "주의" 표시
// (글자가 거의 없는 스캔 쪽은 대조할 글이 없어 건너뜀). "주의" 표시된 표는 문제로 내지 않음
export const markUncheckedTables = (md: string, pageText: string): string => {
    if (letterCount(pageText || '') < 200) return md;
    const have = new Set(numbersOf(pageText));
    const blocks = md.split(/\n(?=###\s)/);
    return blocks.map(b => {
        if (!/^###\s*\[표\]/.test(b.trim())) return b;
        const lines = b.split('\n');
        const nums = numbersOf(lines.slice(1).join('\n'));
        if (nums.length === 0) return b;
        const missing = nums.filter(n => !have.has(n)).length;
        if (missing >= 2 && missing / nums.length > 0.1) {
            return [lines[0], `> 주의: 이 표의 숫자 ${missing}개가 PDF 글에서 확인되지 않아 원본 확인 필요 (문제로 내지 않음)`, ...lines.slice(1)].join('\n');
        }
        return b;
    }).join('\n');
};

// 그림·표 구간을 그 쪽이 들어 있는 구간 바로 뒤에 끼워 넣음 (같은 쪽을 다시 읽었으면 그 구간 글만 바꿈)
export interface FigurePage { page: number; md: string }
export const insertFigureSections = (
    sections: PdfSectionMeta[],
    texts: Record<string, string>,
    figs: FigurePage[]
): { sections: PdfSectionMeta[]; texts: Record<string, string>; added: string[] } => {
    const out = sections.map(s2 => ({ ...s2 }));
    const outTexts = { ...texts };
    const added: string[] = [];
    let nextNo = out.reduce((m, s2) => Math.max(m, Number(s2.key.slice(1)) || 0), -1) + 1;
    [...figs].sort((a, b) => a.page - b.page).forEach(f => {
        const caption = ((f.md.match(/^###\s*(.+)$/m) || [])[1] || '').replace(/\[(표|그림)\]\s*/g, '').trim().slice(0, 60);
        const existing = out.find(s2 => s2.fig && s2.pageFrom === f.page);
        if (existing) {
            outTexts[existing.key] = f.md;
            existing.chars = f.md.length;
            existing.head = caption || existing.head;
            return;
        }
        const key = `s${nextNo++}`;
        const meta: PdfSectionMeta = { key, label: `p.${f.page} 그림·표`, pageFrom: f.page, pageTo: f.page, chars: f.md.length, head: caption || '그림·표', fig: true };
        // 그 쪽이 들어 있는(또는 그 앞의) 마지막 글 구간과, 그 뒤에 이미 붙은 앞쪽 그림·표 구간 다음
        let idx = -1;
        out.forEach((s2, i) => { if (s2.pageFrom <= f.page) idx = i; });
        out.splice(idx + 1, 0, meta);
        outTexts[key] = f.md;
        added.push(key);
    });
    return { sections: out, texts: outTexts, added };
};
