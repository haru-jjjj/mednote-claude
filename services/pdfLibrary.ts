// ============================================================================
// PDF 자료실 저장 (§5-75)
// - 이 기기: 메모와 다른 IndexedDB(MediNotePdfDB)에 보관 → 메모 저장소 버전을 건드리지 않음
// - 클라우드: Firestore appSettings의 pdfm-/pdft- 문서 (services/firebaseService.ts)
// - 진행 기록은 구간 단위로 고치고 구간마다 시각(u)을 남겨, 두 기기에서 다른 구간을 풀어도 서로 덮지 않음
// ============================================================================

import type { PdfDoc, PdfSectionProgress } from '../types';
import { mergePdfDocs, sanitizePdfDoc, splitTextsForCloud } from './pdfQuiz';
import {
    savePdfMetaToFirestore, updatePdfFieldsInFirestore, fetchPdfMetasFromFirestore,
    savePdfTextToFirestore, fetchPdfTextFromFirestore, deletePdfFromFirestore,
} from './firebaseService';

const DB_NAME = 'MediNotePdfDB';
const DOCS = 'docs';
const TEXTS = 'texts';

let dbPromise: Promise<IDBDatabase> | null = null;
const openDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(TEXTS)) db.createObjectStore(TEXTS, { keyPath: 'id' });
        };
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
    title: d.title, source: d.source, sections: d.sections, round: d.round ?? null, inPool: d.inPool === false ? false : null, updatedAt: d.updatedAt,
});

const uploadNew = async (d: PdfDoc, texts: Record<string, string>): Promise<PdfDoc> => {
    const parts = splitTextsForCloud(d.sections, texts);
    for (let n = 0; n < parts.length; n++) await savePdfTextToFirestore(d.id, n, parts[n]);
    const withParts = { ...d, textParts: parts.length };
    await savePdfMetaToFirestore(withParts);
    return withParts;
};

// 새 PDF 저장 (이 기기 먼저, 그다음 클라우드). 클라우드 실패는 다음 동기화 때 다시 올림
export const saveNewPdf = async (d: PdfDoc, texts: Record<string, string>): Promise<{ doc: PdfDoc; cloudOk: boolean }> => {
    const parts = splitTextsForCloud(d.sections, texts).length;
    const local = { ...d, textParts: parts };
    await idbPut(TEXTS, { id: d.id, texts });
    await idbPut(DOCS, local);
    setCached(local);
    try {
        await uploadNew(local, texts);
        return { doc: local, cloudOk: true };
    } catch (e) {
        console.warn('PDF 클라우드 저장 실패 (이 기기에는 저장됨)', e);
        return { doc: local, cloudOk: false };
    }
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
    cache = cache.filter(x => x.id !== d.id);
    emit();
    await deletePdfFromFirestore(d.id, d.textParts);
};
