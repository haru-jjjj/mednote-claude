// ============================================================================
// PDF 자료실 저장 (§5-75)
// - 이 기기: 메모와 다른 IndexedDB(MediNotePdfDB)에 보관 → 메모 저장소 버전을 건드리지 않음
// - 클라우드: Firestore appSettings의 pdfm-/pdft- 문서 (services/firebaseService.ts)
// - 진행 기록은 구간 단위로 고치고 구간마다 시각(u)을 남겨, 두 기기에서 다른 구간을 풀어도 서로 덮지 않음
// - 원본 PDF(§5-77): 이 기기 IndexedDB(files)에 먼저 넣고 Firebase Storage(pdfs/<id>.pdf)에 올림.
//   올리기에 실패하면 이 기기 사본으로 다음 동기화 때 다시 올림
// - 읽기용 마크다운 정리본(§5-83): 구간마다 IndexedDB(md) + Firestore pdfmd-<id>-<구간키>. 출제·채점은 계속 원래 뽑은 글로
// ============================================================================

import type { PdfDoc, PdfSectionProgress } from '../types';
import { mergePdfDocs, sanitizePdfDoc, splitTextsForCloud } from './pdfQuiz';
import {
    savePdfMetaToFirestore, updatePdfFieldsInFirestore, fetchPdfMetasFromFirestore,
    savePdfTextToFirestore, fetchPdfTextFromFirestore, deletePdfFromFirestore,
    pdfFilePath, uploadPdfFileToStorage, getPdfFileUrl, deletePdfFileFromStorage,
    savePdfMdToFirestore, fetchPdfMdFromFirestore, deletePdfMdFromFirestore,
} from './firebaseService';
import { formatPdfSectionMarkdown, describePdfPageFigures } from './claudeService';
import { mdLooksFaithful, openPdf, loadPdfJs, renderPageJpeg, pageItemsToText, pageVisualInfo, visualReasons, markUncheckedTables, insertFigureSections, FigurePage } from './pdfExtract';

const DB_NAME = 'MediNotePdfDB';
const DOCS = 'docs';
const TEXTS = 'texts';
const FILES = 'files'; // 원본 PDF {id, blob} (§5-77)
const MD = 'md'; // 읽기용 마크다운 {k: "<id>:<구간키>", md} (§5-83)

let dbPromise: Promise<IDBDatabase> | null = null;
const openDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(TEXTS)) db.createObjectStore(TEXTS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(MD)) db.createObjectStore(MD, { keyPath: 'k' });
        };
        // 다른 탭이 옛 버전으로 열고 있으면 그쪽을 닫게 함
        req.onblocked = () => console.warn('PDF 저장소 업그레이드가 다른 탭 때문에 대기 중입니다. 다른 MediNote 탭을 닫아 주세요.');
    });
    return dbPromise;
};

const idbGet = async <T>(store: string, id: string): Promise<T | undefined> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = db.transaction(store, 'readonly').objectStore(store).get(id);
        r.onsuccess = () => resolve(r.result as T | undefined);
        r.onerror = () => reject(r.error);
    });
};
const idbPut = async (store: string, value: any): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = db.transaction(store, 'readwrite').objectStore(store).put(value);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
    });
};
const idbDelete = async (store: string, id: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = db.transaction(store, 'readwrite').objectStore(store).delete(id);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
    });
};
const idbAll = async <T>(store: string): Promise<T[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = db.transaction(store, 'readonly').objectStore(store).getAll();
        r.onsuccess = () => resolve((r.result || []) as T[]);
        r.onerror = () => reject(r.error);
    });
};

// ---------------------------------------------------------------------------
// 화면 갱신용 구독
// ---------------------------------------------------------------------------
const listeners = new Set<(docs: PdfDoc[]) => void>();
let cache: PdfDoc[] = [];
const sortDocs = (list: PdfDoc[]) => [...list].sort((a, b) => b.createdAt - a.createdAt);
const emit = () => listeners.forEach(fn => fn(cache));

export const subscribePdfDocs = (fn: (docs: PdfDoc[]) => void): (() => void) => {
    listeners.add(fn);
    fn(cache);
    return () => { listeners.delete(fn); };
};

const setCached = (d: PdfDoc) => {
    cache = sortDocs([...cache.filter(x => x.id !== d.id), ...(d.deleted ? [] : [d])]);
    emit();
};

export const loadLocalPdfDocs = async (): Promise<PdfDoc[]> => {
    try {
        const all = (await idbAll<any>(DOCS)).map(sanitizePdfDoc).filter((d): d is PdfDoc => !!d && !d.deleted);
        cache = sortDocs(all);
        emit();
    } catch (e) {
        console.warn('PDF 자료 불러오기 실패', e);
    }
    return cache;
};

// 클라우드와 맞추기: 구간별로 최신 기록을 합치고, 이 기기에만 있는(올리기 실패한) 것은 올림
let syncing: Promise<PdfDoc[]> | null = null;
export const syncPdfDocs = (): Promise<PdfDoc[]> => {
    if (syncing) return syncing;
    syncing = (async () => {
        await loadLocalPdfDocs();
        const localAll = new Map<string, PdfDoc>();
        (await idbAll<any>(DOCS).catch(() => [])).map(sanitizePdfDoc).forEach(d => { if (d) localAll.set(d.id, d); });
        const remote = (await fetchPdfMetasFromFirestore()).map(sanitizePdfDoc).filter((d): d is PdfDoc => !!d);
        const remoteIds = new Set(remote.map(d => d.id));
        for (const r of remote) {
            const l = localAll.get(r.id);
            const merged = mergePdfDocs(l, r)!;
            if (merged.deleted) {
                if (l) { await idbDelete(DOCS, r.id).catch(() => undefined); await idbDelete(TEXTS, r.id).catch(() => undefined); }
                continue;
            }
            await idbPut(DOCS, merged);
            // 이 기기의 구간 기록이 더 최신이면 클라우드에 올림
            const push: Record<string, any> = {};
            Object.entries(merged.progress).forEach(([k, p]) => { if ((p.u || 0) > (r.progress[k]?.u || 0)) push[`progress.${k}`] = p; });
            if (merged.updatedAt > r.updatedAt) Object.assign(push, metaFields(merged));
            if (Object.keys(push).length) updatePdfFieldsInFirestore(r.id, push).catch(e => console.warn('PDF 기록 올리기 실패', e));
        }
        // 원본 PDF를 이 기기에만 갖고 있고 아직 못 올린 것 → 다시 올림 (§5-77)
        for (const d of await idbAll<any>(DOCS).catch(() => [])) {
            const doc = sanitizePdfDoc(d);
            if (!doc || doc.deleted || doc.file) continue;
            if (await hasLocalPdfFile(doc.id)) await uploadPdfOriginal(doc.id).catch(e => console.warn('원본 PDF 다시 올리기 실패', e));
        }
        // 클라우드에 없는 것(처음 저장 때 올리기 실패) → 다시 올림
        for (const l of localAll.values()) {
            if (remoteIds.has(l.id) || l.deleted) continue;
            const texts = await idbGet<{ id: string; texts: Record<string, string> }>(TEXTS, l.id).catch(() => undefined);
            if (texts) await uploadNew(l, texts.texts).catch(e => console.warn('PDF 올리기 실패', e));
        }
        return loadLocalPdfDocs();
    })().finally(() => { syncing = null; });
    return syncing;
};

const metaFields = (d: PdfDoc) => ({
    title: d.title, source: d.source, sections: d.sections, round: d.round ?? null, inPool: d.inPool === false ? false : null, file: d.file ?? null, mdKeys: d.mdKeys ?? null, textParts: d.textParts, figAt: d.figAt ?? null, figCount: d.figCount ?? null, updatedAt: d.updatedAt,
});

const uploadNew = async (d: PdfDoc, texts: Record<string, string>): Promise<PdfDoc> => {
    const parts = splitTextsForCloud(d.sections, texts);
    for (let n = 0; n < parts.length; n++) await savePdfTextToFirestore(d.id, n, parts[n]);
    const withParts = { ...d, textParts: parts.length };
    await savePdfMetaToFirestore(withParts);
    return withParts;
};

// 새 PDF 저장 (이 기기 먼저, 그다음 클라우드). 클라우드 실패는 다음 동기화 때 다시 올림
// file이 있으면 원본 PDF도 이 기기에 넣고 Storage에 올림 (§5-77)
export const saveNewPdf = async (
    d: PdfDoc,
    texts: Record<string, string>,
    file?: Blob,
    onFileProgress?: (done: number, total: number) => void
): Promise<{ doc: PdfDoc; cloudOk: boolean; fileError?: string }> => {
    const parts = splitTextsForCloud(d.sections, texts).length;
    const local = { ...d, textParts: parts };
    await idbPut(TEXTS, { id: d.id, texts });
    await idbPut(DOCS, local);
    if (file) await storeLocalPdfFile(d.id, file).catch(e => console.warn('원본 PDF를 이 기기에 넣지 못함', e));
    setCached(local);
    let cloudOk = true;
    try {
        await uploadNew(local, texts);
    } catch (e) {
        console.warn('PDF 클라우드 저장 실패 (이 기기에는 저장됨)', e);
        cloudOk = false;
    }
    let fileError: string | undefined;
    if (file && cloudOk) {
        try {
            await uploadPdfOriginal(d.id, onFileProgress);
        } catch (e) {
            console.warn('원본 PDF 올리기 실패', e);
            fileError = describeStorageError(e);
        }
    }
    return { doc: (await getPdfDoc(d.id)) || local, cloudOk, fileError };
};

// 이 기기의 PDF 전부 (최신 기록, 퀴즈 출제용)
export const getAllPdfDocs = async (): Promise<PdfDoc[]> =>
    (await idbAll<any>(DOCS).catch(() => [])).map(sanitizePdfDoc).filter((d): d is PdfDoc => !!d && !d.deleted);

export const getPdfDoc = async (id: string): Promise<PdfDoc | undefined> => {
    const raw = await idbGet<any>(DOCS, id).catch(() => undefined);
    const d = raw ? sanitizePdfDoc(raw) : null;
    return d && !d.deleted ? d : undefined;
};

// 같은 PDF에 대한 변경은 순서대로 (빠르게 연달아 풀어도 서로 덮지 않게)
const queues = new Map<string, Promise<unknown>>();
const enqueue = <T>(id: string, job: () => Promise<T>): Promise<T> => {
    const prev = queues.get(id) || Promise.resolve();
    const run = prev.catch(() => undefined).then(job);
    queues.set(id, run);
    const done = () => { if (queues.get(id) === run) queues.delete(id); };
    run.then(done, done);
    return run;
};

// 구간 하나의 진행 기록 고치기
export const updatePdfSection = (id: string, key: string, fn: (prev: PdfSectionProgress | undefined) => PdfSectionProgress): Promise<PdfDoc | null> =>
    enqueue(id, async () => {
        const d = await getPdfDoc(id);
        if (!d) return null;
        const next = fn(d.progress[key]);
        const updated: PdfDoc = { ...d, progress: { ...d.progress, [key]: next } };
        await idbPut(DOCS, updated);
        setCached(updated);
        updatePdfFieldsInFirestore(id, { [`progress.${key}`]: next }).catch(e => console.warn('PDF 기록 올리기 실패 (다음에 다시 올림)', e));
        return updated;
    });

// 제목·출처·구간 제외·처음부터 다시 등
export const updatePdfMeta = (id: string, fn: (d: PdfDoc) => Partial<PdfDoc>): Promise<PdfDoc | null> =>
    enqueue(id, async () => {
        const d = await getPdfDoc(id);
        if (!d) return null;
        const patch = fn(d);
        const updated: PdfDoc = { ...d, ...patch, updatedAt: Date.now() };
        await idbPut(DOCS, updated);
        setCached(updated);
        const fields: Record<string, any> = metaFields(updated);
        if (patch.progress) fields.progress = updated.progress;
        updatePdfFieldsInFirestore(id, fields).catch(e => console.warn('PDF 정보 올리기 실패 (다음에 다시 올림)', e));
        return updated;
    });

// 구간 글 (이 기기에 없으면 클라우드에서 받아 보관)
export const getPdfSectionText = async (d: PdfDoc, key: string): Promise<string> => {
    const local = await idbGet<{ id: string; texts: Record<string, string> }>(TEXTS, d.id).catch(() => undefined);
    if (local?.texts && typeof local.texts[key] === 'string') return local.texts[key];
    const texts: Record<string, string> = { ...(local?.texts || {}) };
    for (let n = 0; n < Math.max(1, d.textParts); n++) {
        const part = await fetchPdfTextFromFirestore(d.id, n);
        if (part) Object.assign(texts, part);
    }
    await idbPut(TEXTS, { id: d.id, texts }).catch(() => undefined);
    if (typeof texts[key] !== 'string') throw new Error('이 구간의 글을 찾지 못했습니다. 인터넷 연결을 확인해주세요.');
    return texts[key];
};

export const deletePdf = async (d: PdfDoc): Promise<void> => {
    await idbDelete(DOCS, d.id).catch(() => undefined);
    await idbDelete(TEXTS, d.id).catch(() => undefined);
    await idbDelete(FILES, d.id).catch(() => undefined);
    for (const s2 of d.sections) await idbDelete(MD, `${d.id}:${s2.key}`).catch(() => undefined);
    cache = cache.filter(x => x.id !== d.id);
    emit();
    await deletePdfFromFirestore(d.id, d.textParts);
    await deletePdfFileFromStorage(d.file?.path || pdfFilePath(d.id)).catch(e => console.warn('원본 PDF 지우기 실패', e));
    await deletePdfMdFromFirestore(d.id, d.mdKeys || []).catch(e => console.warn('정리본 지우기 실패', e));
};

// ---------------------------------------------------------------------------
// 원본 PDF (§5-77)
// ---------------------------------------------------------------------------
export const hasLocalPdfFile = async (id: string): Promise<boolean> =>
    !!(await idbGet<{ id: string; blob: Blob }>(FILES, id).catch(() => undefined))?.blob;

export const storeLocalPdfFile = (id: string, blob: Blob): Promise<void> => idbPut(FILES, { id, blob });

// 올리기 실패 이유를 알아듣게
export const describeStorageError = (e: any): string => {
    const code = String(e?.code || '');
    if (code === 'storage/unauthorized') return '원본 PDF를 올릴 권한이 없습니다. Firebase 콘솔 → Storage → 규칙을 CHANGES.md §5-77대로 바꿔 주세요.';
    if (code === 'storage/unknown' || code === 'storage/bucket-not-found' || code === 'storage/project-not-found') return 'Firebase Storage가 아직 준비되지 않았어요. Firebase 콘솔 → Storage → "시작하기"를 눌러 주세요 (위치는 us-central1 권장: 무료 사용량 적용).';
    if (code === 'storage/quota-exceeded') return 'Storage 사용 한도를 넘었습니다. Firebase 콘솔의 사용량·요금을 확인해 주세요.';
    if (code === 'storage/retry-limit-exceeded' || code === 'storage/canceled') return '인터넷 연결이 불안정해 원본 PDF를 올리지 못했습니다. 다음에 앱을 열 때 다시 올립니다.';
    return `원본 PDF를 올리지 못했습니다 (${code || e?.message || e}). 이 기기에 남겨 두고 다음에 다시 올립니다.`;
};

// 이 기기에 넣어 둔 원본을 Storage에 올리고, PDF 정보에 기록 (모든 기기에서 열 수 있게)
const uploadingNow = new Map<string, Promise<PdfDoc | null>>();
export const uploadPdfOriginal = (id: string, onProgress?: (done: number, total: number) => void): Promise<PdfDoc | null> => {
    const running = uploadingNow.get(id);
    if (running) return running;
    const job = (async () => {
        const local = await idbGet<{ id: string; blob: Blob }>(FILES, id);
        if (!local?.blob) throw new Error('이 기기에 원본 PDF가 없습니다.');
        const path = pdfFilePath(id);
        await uploadPdfFileToStorage(path, local.blob, onProgress);
        return updatePdfMeta(id, () => ({ file: { path, size: local.blob.size, at: Date.now() } }));
    })().finally(() => uploadingNow.delete(id));
    uploadingNow.set(id, job);
    return job;
};

// 원본만 지우기 (§5-78): 보관 공간만 비우고 뽑은 글·푼 기록·문제는 그대로 (이 기기 사본도 지워 다시 올라가지 않게)
export const deletePdfOriginal = async (d: PdfDoc): Promise<void> => {
    await deletePdfFileFromStorage(d.file?.path || pdfFilePath(d.id));
    await idbDelete(FILES, d.id).catch(() => undefined);
    await updatePdfMeta(d.id, () => ({ file: undefined }));
};

// 원본 열기: 클라우드 사본(어느 기기에서나) → 없으면 이 기기 사본. page가 있으면 그 쪽으로(#page=, 지원하는 뷰어에서)
// 팝업 차단을 피하려고 창은 누른 순간 먼저 열어 두고 주소를 나중에 넣음
export const openPdfOriginal = async (d: PdfDoc, page?: number): Promise<void> => {
    const win = window.open('', '_blank');
    const hash = page && page > 1 ? `#page=${page}` : '';
    try {
        let url: string | null = null;
        if (d.file?.path) url = await getPdfFileUrl(d.file.path).catch(() => null);
        if (!url) {
            const local = await idbGet<{ id: string; blob: Blob }>(FILES, d.id).catch(() => undefined);
            if (local?.blob) url = URL.createObjectURL(local.blob);
        }
        if (!url) throw new Error(d.file ? '원본 PDF 주소를 받지 못했습니다. 인터넷 연결을 확인해 주세요.' : '이 PDF는 원본이 저장되어 있지 않습니다.');
        if (!win) throw new Error('새 창이 차단됐어요. 브라우저의 팝업 차단을 이 사이트에 대해 풀어 주세요.');
        win.location.href = url + hash;
    } catch (e) {
        win?.close();
        throw e;
    }
};

// ---------------------------------------------------------------------------
// 읽기용 마크다운 정리본 (§5-83)
// ---------------------------------------------------------------------------
// 구간 정리본 (없으면 null → 원래 글을 보여 줌). 이 기기에 없고 정리된 구간이면 클라우드에서 받아 보관
export const getPdfSectionMd = async (d: PdfDoc, key: string): Promise<string | null> => {
    const local = await idbGet<{ k: string; md: string }>(MD, `${d.id}:${key}`).catch(() => undefined);
    if (typeof local?.md === 'string') return local.md;
    if (!(d.mdKeys || []).includes(key)) return null;
    const md = await fetchPdfMdFromFirestore(d.id, key).catch(() => null);
    if (md) await idbPut(MD, { k: `${d.id}:${key}`, md }).catch(() => undefined);
    return md;
};

export interface PdfFormatState { done: number; total: number; failed: number; running: boolean }
const fmtStates = new Map<string, PdfFormatState>();
const fmtListeners = new Set<() => void>();
const fmtEmit = () => fmtListeners.forEach(fn => fn());
export const subscribePdfFormat = (fn: () => void): (() => void) => { fmtListeners.add(fn); return () => { fmtListeners.delete(fn); }; };
export const getPdfFormatState = (id: string): PdfFormatState | undefined => fmtStates.get(id);

// 정리할 구간 (출제에서 뺀 구간·낼 내용 없는 구간은 건너뜀)
export const sectionsToFormat = (d: PdfDoc) =>
    d.sections.filter(s2 => !s2.excluded && !s2.fig && !d.progress?.[s2.key]?.empty && !(d.mdKeys || []).includes(s2.key)); // 그림·표 구간은 이미 마크다운

// 구간마다 AI로 정리 (2개씩 동시에). 원래 글과 같은 내용(글자 양·숫자)으로 확인된 것만 저장
export const formatPdfForReading = async (id: string): Promise<PdfFormatState | undefined> => {
    if (fmtStates.get(id)?.running) return fmtStates.get(id);
    const d = await getPdfDoc(id);
    if (!d) return undefined;
    const targets = sectionsToFormat(d);
    const state: PdfFormatState = { done: 0, total: targets.length, failed: 0, running: targets.length > 0 };
    fmtStates.set(id, state);
    fmtEmit();
    let next = 0;
    const worker = async () => {
        while (next < targets.length) {
            const sec = targets[next++];
            try {
                const latest = (await getPdfDoc(id)) || d;
                const raw = await getPdfSectionText(latest, sec.key);
                const md = await formatPdfSectionMarkdown(raw, { docTitle: latest.title, sectionLabel: sec.label });
                const check = mdLooksFaithful(raw, md);
                if (!check.ok) {
                    console.warn('정리본이 원래 글과 달라 저장하지 않음', sec.label, check);
                    state.failed++;
                } else {
                    await idbPut(MD, { k: `${id}:${sec.key}`, md });
                    await savePdfMdToFirestore(id, sec.key, md).catch(e => console.warn('정리본 클라우드 저장 실패', e));
                    await updatePdfMeta(id, x => ({ mdKeys: Array.from(new Set([...(x.mdKeys || []), sec.key])) }));
                }
            } catch (e) {
                console.warn('구간 정리 실패', sec.label, e);
                state.failed++;
            }
            state.done++;
            fmtEmit();
        }
    };
    try {
        await Promise.all([worker(), worker()]);
    } finally {
        state.running = false;
        fmtEmit();
    }
    return state;
};

// ---------------------------------------------------------------------------
// 그림·표 읽기 (§5-84): 그림·표가 있는 쪽을 그림으로 만들어 AI가 표(값 그대로)·그림(설명)으로 옮기고,
// "p.N 그림·표" 구간으로 추가 (기존 구간·진도는 그대로). 원본 PDF 파일이 필요(이 기기 사본 또는 고른 파일)
// ---------------------------------------------------------------------------
export const MAX_FIGURE_PAGES = 40;
export interface PdfFigureState { done: number; total: number; found: number; running: boolean; error?: string }
const figStates = new Map<string, PdfFigureState>();
export const getPdfFigureState = (id: string): PdfFigureState | undefined => figStates.get(id);
export const NEED_FILE = 'NEED_FILE';

export const readPdfFigures = async (id: string, opts: { file?: Blob; pages?: number[] } = {}): Promise<PdfFigureState | undefined> => {
    if (figStates.get(id)?.running) return figStates.get(id);
    const d0 = await getPdfDoc(id);
    if (!d0) return undefined;
    const blob = opts.file || (await idbGet<{ id: string; blob: Blob }>(FILES, id).catch(() => undefined))?.blob;
    if (!blob) throw new Error(NEED_FILE);
    const state: PdfFigureState = { done: 0, total: 0, found: 0, running: true };
    figStates.set(id, state);
    fmtEmit();
    let pdf: any = null;
    try {
        const lib = await loadPdfJs();
        pdf = await openPdf(await blob.arrayBuffer());
        const limit = d0.refsFromPage ? d0.refsFromPage - 1 : pdf.numPages; // 참고문헌 쪽부터는 안 봄
        const pageTexts = new Map<number, string>();
        const textOf = async (n: number) => {
            if (!pageTexts.has(n)) {
                const pg = await pdf.getPage(n);
                pageTexts.set(n, pageItemsToText((await pg.getTextContent()).items || []));
            }
            return pageTexts.get(n) || '';
        };
        let pages = opts.pages;
        if (!pages) {
            pages = [];
            for (let n = 1; n <= Math.min(limit, pdf.numPages); n++) {
                const pg = await pdf.getPage(n);
                const text = await textOf(n);
                const v = await pageVisualInfo(pg, lib).catch(() => ({ imageFrac: 0, paths: 0 }));
                if (visualReasons(v, text).length) pages.push(n);
            }
        }
        pages = pages.filter(n => n >= 1 && n <= limit).slice(0, MAX_FIGURE_PAGES);
        state.total = pages.length;
        fmtEmit();
        const found: FigurePage[] = [];
        let next = 0;
        const worker = async () => {
            while (next < pages!.length) {
                const n = pages![next++];
                try {
                    const img = await renderPageJpeg(pdf, n, 1600);
                    const text = await textOf(n);
                    const md = await describePdfPageFigures(img, text, n);
                    if (md) { found.push({ page: n, md: markUncheckedTables(md, text) }); state.found++; }
                } catch (e) {
                    console.warn('그림·표 읽기 실패', n, e);
                }
                state.done++;
                fmtEmit();
            }
        };
        await Promise.all([worker(), worker()]);

        // 구간 추가·글 저장 (이 기기 + 클라우드), 정보 갱신
        const latest = (await getPdfDoc(id)) || d0;
        if (latest.sections.length) await getPdfSectionText(latest, latest.sections[0].key).catch(() => '');
        const local = await idbGet<{ id: string; texts: Record<string, string> }>(TEXTS, id).catch(() => undefined);
        const built = insertFigureSections(latest.sections, local?.texts || {}, found);
        await idbPut(TEXTS, { id, texts: built.texts });
        const parts = splitTextsForCloud(built.sections, built.texts);
        for (let k = 0; k < parts.length; k++) await savePdfTextToFirestore(id, k, parts[k]).catch(e => console.warn('글 올리기 실패', e));
        await updatePdfMeta(id, x => {
            // 그사이 바뀐 구간 설정(출제에서 빼기 등)은 살림
            const ex = new Map(x.sections.map(s2 => [s2.key, s2.excluded]));
            return {
                sections: built.sections.map(s2 => (ex.has(s2.key) ? { ...s2, excluded: ex.get(s2.key) } : s2)),
                textParts: parts.length,
                figAt: Date.now(),
                figCount: (x.figCount || 0) + built.added.length,
            };
        });
    } catch (e: any) {
        state.error = e?.message || String(e);
        throw e;
    } finally {
        pdf?.destroy?.();
        state.running = false;
        fmtEmit();
    }
    return state;
};
