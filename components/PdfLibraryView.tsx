import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Loader2, Upload, Zap, RotateCw, ChevronDown, ChevronUp, Trash2, Pencil, Check, X, Languages, ScanText } from 'lucide-react';
import { PdfDoc, QuizLanguage } from '../types';
import { extractPdfText, buildPdfSections, looksScanned, renderPageJpeg, MAX_OCR_PAGES, BuiltSections } from '../services/pdfExtract';
import { suggestPdfInfo, transcribePdfPages } from '../services/claudeService';
import { saveNewPdf, updatePdfMeta, deletePdf } from '../services/pdfLibrary';
import { pdfStats, resetPdfRound, newPdfId, poolStats, inPdfPool } from '../services/pdfQuiz';

// ============================================================================
// PDF 자료실 (§5-75)
// - PDF를 올리면 글을 뽑아 구간(약 2,600자)으로 나눠 보관 (제목·출처와 함께, 원본 파일은 보관 안 함)
// - "OX 풀기": 구간마다 요점 목록을 만들어 요점 하나당 OX 한 문제 → 앞에서부터 빠짐없이 한 바퀴
// ============================================================================

interface Props {
    docs: PdfDoc[];
    loading: boolean;
    syncError: string | null;
    onBack: () => void;
    onStart: (id: string | null, mode: 'all' | 'wrong', language: QuizLanguage) => void; // null = PDF 전체 풀 (§5-76)
}

type Upload =
    | { step: 'reading'; fileName: string; done: number; total: number }
    | { step: 'scanned'; fileName: string; pages: number; file: File }
    | { step: 'ocr'; fileName: string; done: number; total: number }
    | { step: 'form'; fileName: string; pageCount: number; built: BuiltSections; ocr: boolean; title: string; source: string; suggesting: boolean; edited: boolean }
    | { step: 'saving'; fileName: string };

const LANG_KEY = 'medinote_quiz_language';
const readLang = (): QuizLanguage => { try { const v = localStorage.getItem(LANG_KEY); return v === 'English' || v === 'Japanese' ? v : 'Korean'; } catch { return 'Korean'; } };

const fmtDate = (t: number) => new Date(t).toLocaleDateString();

const PdfLibraryView: React.FC<Props> = ({ docs, loading, syncError, onBack, onStart }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [upload, setUpload] = useState<Upload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ id: string; title: string; source: string } | null>(null);
    const [language, setLanguageState] = useState<QuizLanguage>(readLang);
    const setLanguage = (l: QuizLanguage) => { setLanguageState(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* 이번 화면에선 동작 */ } };
    const cancelRef = useRef(false);
    const pdfRef = useRef<any>(null);

    useEffect(() => () => { cancelRef.current = true; pdfRef.current?.destroy?.(); }, []);

    const closeUpload = () => {
        cancelRef.current = true;
        pdfRef.current?.destroy?.();
        pdfRef.current = null;
        setUpload(null);
    };

    const toForm = (fileName: string, pageCount: number, pages: string[], info: { title?: string }, ocr: boolean) => {
        const built = buildPdfSections(pages);
        if (built.sections.length === 0) {
            setError('PDF에서 글을 찾지 못했습니다.');
            closeUpload();
            return;
        }
        const fallbackTitle = (info.title && info.title.length > 3 && !/^untitled|microsoft word/i.test(info.title)) ? info.title : fileName.replace(/\.pdf$/i, '');
        setUpload({ step: 'form', fileName, pageCount, built, ocr, title: fallbackTitle, source: '', suggesting: true, edited: false });
        // 제목·출처 제안 (첫 두 구간 글로, 짧은 AI 호출) — 그 사이 직접 고쳤으면 덮지 않음
        const first = built.sections.slice(0, 2).map(s => built.texts[s.key]).join('\n\n');
        suggestPdfInfo(first, fileName, info.title)
            .then(r => setUpload(u => (u && u.step === 'form' && u.built === built
                ? { ...u, suggesting: false, ...(u.edited ? {} : { title: r.title || u.title, source: r.source || u.source }) }
                : u)))
            .catch(e => { console.warn('제목·출처 제안 실패', e); setUpload(u => (u && u.step === 'form' ? { ...u, suggesting: false } : u)); });
    };

    const handleFile = async (file: File) => {
        setError(null); setNotice(null);
        cancelRef.current = false;
        if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setError('PDF 파일만 올릴 수 있어요.'); return; }
        setUpload({ step: 'reading', fileName: file.name, done: 0, total: 0 });
        try {
            const ex = await extractPdfText(file, (done, total) => { if (!cancelRef.current) setUpload({ step: 'reading', fileName: file.name, done, total }); });
            if (cancelRef.current) { ex.doc.destroy?.(); return; }
            pdfRef.current = ex.doc;
            if (looksScanned(ex.pages)) {
                setUpload({ step: 'scanned', fileName: file.name, pages: ex.pageCount, file });
                return;
            }
            ex.doc.destroy?.(); pdfRef.current = null;
            toForm(file.name, ex.pageCount, ex.pages, ex.info, false);
        } catch (e: any) {
            console.error(e);
            setError(e?.message || 'PDF를 읽지 못했습니다.');
            closeUpload();
        }
    };

    // 사진(스캔) PDF: 쪽을 그림으로 만들어 3쪽씩 AI가 글자를 읽음
    const runOcr = async (fileName: string, pageCount: number) => {
        const doc = pdfRef.current;
        if (!doc) { closeUpload(); return; }
        const total = Math.min(pageCount, MAX_OCR_PAGES);
        cancelRef.current = false;
        setUpload({ step: 'ocr', fileName, done: 0, total });
        const pages: string[] = [];
        try {
            for (let p = 1; p <= total; p += 3) {
                const imgs: string[] = [];
                for (let k = p; k < p + 3 && k <= total; k++) imgs.push(await renderPageJpeg(doc, k));
                if (cancelRef.current) return;
                const texts = await transcribePdfPages(imgs, p);
                if (cancelRef.current) return;
                pages.push(...texts);
                setUpload({ step: 'ocr', fileName, done: Math.min(total, p + 2), total });
            }
            doc.destroy?.(); pdfRef.current = null;
            if (pageCount > total) setNotice(`앞 ${total}쪽만 읽었습니다 (사진 PDF는 ${MAX_OCR_PAGES}쪽까지).`);
            toForm(fileName, pageCount, pages, {}, true);
        } catch (e: any) {
            console.error(e);
            setError(`글자 읽기 중 오류: ${e?.message || '알 수 없는 오류'}`);
            closeUpload();
        }
    };

    const save = async () => {
        if (!upload || upload.step !== 'form') return;
        const u = upload;
        const now = Date.now();
        const doc: PdfDoc = {
            id: newPdfId('pdf_'),
            title: u.title.trim() || u.fileName.replace(/\.pdf$/i, ''),
            source: u.source.trim(),
            fileName: u.fileName,
            pageCount: u.pageCount,
            charCount: u.built.charCount,
            createdAt: now,
            updatedAt: now,
            sections: u.built.sections,
            progress: {},
            textParts: 1,
            ocr: u.ocr || undefined,
            refsFromPage: u.built.refsFromPage,
        };
        setUpload({ step: 'saving', fileName: u.fileName });
        try {
            const r = await saveNewPdf(doc, u.built.texts);
            setUpload(null);
            setOpenId(null);
            setNotice(r.cloudOk ? `"${doc.title}" 저장됨 · 구간 ${doc.sections.length}개` : `"${doc.title}"을 이 기기에 저장했어요. 클라우드 저장은 인터넷이 연결되면 다시 시도합니다.`);
        } catch (e: any) {
            console.error(e);
            setError(`저장 실패: ${e?.message || '알 수 없는 오류'}`);
            setUpload(u);
        }
    };

    const restart = async (d: PdfDoc) => {
        if (!confirm(`"${d.title}"을 처음부터 다시 풀까요?\n지금까지 푼 기록(맞힘·틀림)을 지우고, 같은 요점을 새 문장으로 다시 냅니다.`)) return false;
        const now = Date.now();
        await updatePdfMeta(d.id, x => ({ progress: resetPdfRound(x, now), round: (x.round || 0) + 1 }));
        return true;
    };

    const remove = async (d: PdfDoc) => {
        if (!confirm(`"${d.title}"을 PDF 자료실에서 지울까요?\n뽑아 둔 글과 푼 기록이 모든 기기에서 지워집니다.`)) return;
        try { await deletePdf(d); } catch (e: any) { alert(`클라우드에서 지우지 못했습니다: ${e?.message || e}`); }
    };

    const toggleExclude = (d: PdfDoc, key: string) =>
        updatePdfMeta(d.id, x => ({ sections: x.sections.map(s => (s.key === key ? { ...s, excluded: s.excluded ? undefined : true } : s)) }));

    const saveEdit = async () => {
        if (!editing) return;
        const { id, title, source } = editing;
        await updatePdfMeta(id, () => ({ title: title.trim() || '제목 없음', source: source.trim() }));
        setEditing(null);
    };

    const busy = !!upload && upload.step !== 'form' && upload.step !== 'scanned';
    const pool = poolStats(docs);
    const togglePool = (d: PdfDoc) => updatePdfMeta(d.id, x => ({ inPool: x.inPool === false ? undefined : false }));

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="h-12 px-2 bg-white border-b border-slate-100 flex items-center gap-1 flex-none">
                <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800" title="뒤로"><ArrowLeft className="w-5 h-5" /></button>
                <h2 className="font-bold text-slate-800 flex items-center gap-1.5"><FileText className="w-4 h-4 text-slate-400" /> PDF 자료실</h2>
                <button
                    onClick={() => fileRef.current?.click()}
                    disabled={!!upload}
                    className="ml-auto mr-1 px-3 py-1.5 rounded-lg bg-accent-700 text-white text-[13px] font-bold hover:bg-accent-800 disabled:opacity-50 flex items-center gap-1.5"
                >
                    <Upload className="w-3.5 h-3.5" /> PDF 올리기
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleFile(f); }}
                />
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
                    {/* 문제 언어 */}
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
                        <span>문제 언어</span>
                        {(['Korean', 'English', 'Japanese'] as QuizLanguage[]).map(l => (
                            <button
                                key={l}
                                type="button"
                                onClick={() => setLanguage(l)}
                                className={`px-2.5 py-1 rounded-lg border font-bold flex items-center gap-1 ${language === l ? 'bg-accent-50 border-accent-300 text-accent-700' : 'bg-white border-slate-200 text-slate-500'}`}
                            >
                                <Languages className="w-3 h-3" />{l === 'Korean' ? '한국어' : l === 'English' ? 'English' : <span lang="ja">日本語</span>}
                            </button>
                        ))}
                    </div>

                    {error && (
                        <div className="p-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600 flex items-start gap-2">
                            <span className="flex-1">{error}</span>
                            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
                        </div>
                    )}
                    {notice && !upload && (
                        <div className="p-3 rounded-xl bg-sage-50 border border-sage-200 text-sm text-sage-700 flex items-start gap-2">
                            <span className="flex-1">{notice}</span>
                            <button onClick={() => setNotice(null)} className="text-sage-500"><X className="w-4 h-4" /></button>
                        </div>
                    )}

                    {/* 올리는 중 */}
                    {upload && (
                        <div className="bg-white border border-accent-200 rounded-2xl p-5">
                            <p className="text-xs font-bold text-slate-400 truncate">{upload.fileName}</p>
                            {upload.step === 'reading' && (
                                <p className="mt-2 text-sm text-slate-600 flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-accent-600" />
                                    글 뽑는 중{upload.total ? ` ${upload.done}/${upload.total}쪽` : '…'}
                                </p>
                            )}
                            {upload.step === 'scanned' && (
                                <div className="mt-2">
                                    <p className="text-sm text-slate-700 font-bold">글자가 거의 없는 PDF예요 (사진·스캔본으로 보임).</p>
                                    <p className="text-[13px] text-slate-500 mt-1 leading-relaxed">
                                        쪽을 그림으로 만들어 AI가 글자를 읽을 수 있어요. {Math.min(upload.pages, MAX_OCR_PAGES)}쪽
                                        {upload.pages > MAX_OCR_PAGES ? ` (앞 ${MAX_OCR_PAGES}쪽만)` : ''} · 예상 비용 약 ${Math.max(0.01, Math.min(upload.pages, MAX_OCR_PAGES) * 0.001).toFixed(2)} 이하.
                                        표·그림 안 글자는 틀릴 수 있어요.
                                    </p>
                                    <div className="flex gap-2 mt-3">
                                        <button onClick={() => runOcr(upload.fileName, upload.pages)} className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold flex items-center gap-1.5">
                                            <ScanText className="w-4 h-4" /> AI로 글자 읽기
                                        </button>
                                        <button onClick={closeUpload} className="px-4 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-500">취소</button>
                                    </div>
                                </div>
                            )}
                            {upload.step === 'ocr' && (
                                <p className="mt-2 text-sm text-slate-600 flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-accent-600" /> AI가 글자 읽는 중 {upload.done}/{upload.total}쪽
                                </p>
                            )}
                            {upload.step === 'saving' && (
                                <p className="mt-2 text-sm text-slate-600 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-accent-600" /> 저장 중…</p>
                            )}
                            {upload.step === 'form' && (
                                <div className="mt-3 space-y-3">
                                    <p className="text-[12px] text-slate-500 leading-relaxed">
                                        {upload.pageCount}쪽 · {upload.built.charCount.toLocaleString()}자 · 구간 {upload.built.sections.length}개
                                        {upload.ocr && ' · AI로 읽은 글'}
                                        {upload.built.refsFromPage ? ` · 참고문헌(p.${upload.built.refsFromPage}~)은 출제에서 뺌` : ''}
                                        {upload.built.truncated && ' · 너무 길어 뒷부분은 잘림'}
                                    </p>
                                    <label className="block">
                                        <span className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
                                            제목 {upload.suggesting && <span className="font-normal text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />PDF 첫 쪽에서 찾는 중</span>}
                                        </span>
                                        <textarea
                                            rows={2}
                                            value={upload.title}
                                            onChange={e => setUpload({ ...upload, title: e.target.value.replace(/\n/g, ' '), edited: true })}
                                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm resize-none focus:outline-none focus:border-accent-400"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="text-xs font-bold text-slate-500">출처 <span className="font-normal text-slate-400">(학회·학술지·연도·DOI·주소 등)</span></span>
                                        <textarea
                                            rows={2}
                                            value={upload.source}
                                            onChange={e => setUpload({ ...upload, source: e.target.value.replace(/\n/g, ' '), edited: true })}
                                            placeholder="예: 2023 ACC/AHA AF Guideline · Circulation 2024;149:e1–e156"
                                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm resize-none focus:outline-none focus:border-accent-400"
                                        />
                                    </label>
                                    <div className="flex gap-2">
                                        <button onClick={save} className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold flex items-center gap-1.5"><Check className="w-4 h-4" /> 저장</button>
                                        <button onClick={closeUpload} className="px-4 py-2 rounded-xl border border-slate-200 text-sm font-bold text-slate-500">취소</button>
                                    </div>
                                </div>
                            )}
                            {busy && upload.step !== 'saving' && (
                                <button onClick={closeUpload} className="mt-3 text-xs font-bold text-slate-400 hover:text-red-500">취소</button>
                            )}
                        </div>
                    )}

                    {/* PDF 전체 풀 (§5-76) */}
                    {docs.length > 0 && (
                        <div className="bg-white border border-accent-200 rounded-2xl p-5">
                            <h3 className="font-bold text-slate-900">PDF 전체로 복습</h3>
                            <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">
                                "PDF 복습에 넣기"가 켜진 PDF {pool.docs}개를 섞어서 냅니다. 각 PDF 안에서는 앞 구간부터 빠짐없이, 남은 양이 많은 PDF가 더 자주 나와요.
                            </p>
                            <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${pool.percent}%` }} />
                            </div>
                            <p className="text-[12px] text-slate-500 mt-1.5">
                                {pool.allDone ? '모두 한 바퀴 끝' : `구간 ${pool.sectionsDone}/${pool.sections} (${pool.percent}%)`} · 맞힘 {pool.ok} · 틀림 {pool.wrong}
                            </p>
                            <div className="flex flex-wrap gap-2 mt-3">
                                <button
                                    onClick={async () => {
                                        if (pool.allDone) {
                                            if (!confirm('복습에 넣은 PDF를 모두 처음부터 다시 풀까요? 같은 요점을 새 문장으로 다시 냅니다.')) return;
                                            for (const d of docs.filter(inPdfPool)) await updatePdfMeta(d.id, x => ({ progress: resetPdfRound(x, Date.now()), round: (x.round || 0) + 1 }));
                                        }
                                        onStart(null, 'all', language);
                                    }}
                                    disabled={pool.docs === 0}
                                    className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 flex items-center gap-1.5 disabled:opacity-40"
                                >
                                    <Zap className="w-4 h-4" /> {pool.allDone ? '모두 처음부터 다시' : pool.sectionsDone + pool.ok + pool.wrong === 0 ? 'PDF 전체로 OX' : '이어서 풀기'}
                                </button>
                                {pool.wrong > 0 && (
                                    <button onClick={() => onStart(null, 'wrong', language)} className="px-4 py-2 rounded-xl bg-white border border-clay-300 text-clay-600 text-sm font-bold hover:bg-clay-50 flex items-center gap-1.5">
                                        <RotateCw className="w-4 h-4" /> 틀린 것 {pool.wrong}개
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* 목록 */}
                    {docs.length === 0 && !upload ? (
                        <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
                            {loading ? (
                                <p className="text-sm text-slate-400 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…</p>
                            ) : (
                                <>
                                    <p className="text-sm text-slate-600 font-bold">아직 올린 PDF가 없어요.</p>
                                    <p className="text-[13px] text-slate-500 mt-2 leading-relaxed">
                                        가이드라인·리뷰 논문 같은 PDF를 올리면 글을 뽑아 보관하고(원본 파일은 저장 안 함),
                                        구간마다 요점을 정리해 요점 하나당 OX 한 문제로 처음부터 끝까지 빠짐없이 냅니다.
                                    </p>
                                </>
                            )}
                        </div>
                    ) : (
                        docs.map(d => {
                            const st = pdfStats(d);
                            const open = openId === d.id;
                            const isEditing = editing?.id === d.id;
                            const notStarted = st.sectionsStarted === 0;
                            return (
                                <div key={d.id} className="bg-white border border-slate-200 rounded-2xl p-5">
                                    {isEditing ? (
                                        <div className="space-y-2">
                                            <textarea rows={2} value={editing!.title} onChange={e => setEditing({ ...editing!, title: e.target.value.replace(/\n/g, ' ') })} className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold resize-none" />
                                            <textarea rows={2} value={editing!.source} onChange={e => setEditing({ ...editing!, source: e.target.value.replace(/\n/g, ' ') })} placeholder="출처" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm resize-none" />
                                            <div className="flex gap-2">
                                                <button onClick={saveEdit} className="px-3 py-1.5 rounded-lg bg-accent-700 text-white text-xs font-bold">저장</button>
                                                <button onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-500">취소</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <h3 className="font-bold text-slate-900 leading-snug">{d.title}</h3>
                                            {d.source && <p className="text-[12px] text-slate-500 mt-1 break-words">{d.source}</p>}
                                        </>
                                    )}
                                    <label className="mt-2 inline-flex items-center gap-2 text-[12px] text-slate-600 cursor-pointer select-none">
                                        <input type="checkbox" checked={inPdfPool(d)} onChange={() => togglePool(d)} className="accent-[#374f66] w-4 h-4" />
                                        PDF 복습에 넣기
                                    </label>
                                    <p className="text-[11px] text-slate-400 mt-1.5">
                                        {d.pageCount}쪽 · 구간 {st.sections}개 · {fmtDate(d.createdAt)} 올림{d.ocr ? ' · AI로 읽은 글' : ''}{(d.round || 0) > 0 ? ` · ${(d.round || 0) + 1}바퀴째` : ''}
                                    </p>

                                    <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                        <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${st.percent}%` }} />
                                    </div>
                                    <p className="text-[12px] text-slate-500 mt-1.5">
                                        {notStarted
                                            ? '아직 안 풀었어요'
                                            : st.roundDone
                                                ? <>한 바퀴 끝 · 요점 {st.points}개 중 맞힘 <b className="text-sage-600">{st.ok}</b> · 틀림 <b className="text-clay-500">{st.wrong}</b></>
                                                : <>구간 {st.sectionsDone}/{st.sections} ({st.percent}%) · 푼 요점 {st.ok + st.wrong}개 (맞힘 {st.ok} · 틀림 {st.wrong})</>}
                                    </p>

                                    <div className="flex flex-wrap gap-2 mt-3">
                                        <button
                                            onClick={async () => { if (st.roundDone) { if (await restart(d)) onStart(d.id, 'all', language); } else onStart(d.id, 'all', language); }}
                                            disabled={st.sections === 0}
                                            className="px-4 py-2 rounded-xl bg-white border border-accent-300 text-accent-700 text-sm font-bold hover:bg-accent-50 flex items-center gap-1.5 disabled:opacity-40"
                                        >
                                            <Zap className="w-4 h-4" /> {notStarted ? '이 PDF만 풀기' : st.roundDone ? '처음부터 다시' : '이 PDF만 이어서'}
                                        </button>
                                        {st.wrong > 0 && (
                                            <button onClick={() => onStart(d.id, 'wrong', language)} className="px-4 py-2 rounded-xl bg-white border border-clay-300 text-clay-600 text-sm font-bold hover:bg-clay-50 flex items-center gap-1.5">
                                                <RotateCw className="w-4 h-4" /> 틀린 것 {st.wrong}개
                                            </button>
                                        )}
                                        <button onClick={() => setOpenId(open ? null : d.id)} className="ml-auto px-2 py-2 text-xs font-bold text-slate-400 hover:text-slate-700 flex items-center gap-1">
                                            구간·설정 {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                        </button>
                                    </div>

                                    {open && (
                                        <div className="mt-3 pt-3 border-t border-slate-100">
                                            <p className="text-[11px] text-slate-400 mb-2">
                                                구간을 누르면 출제에서 빼거나 다시 넣어요 (표지·목차·참고문헌 등).{d.refsFromPage ? ` 참고문헌(p.${d.refsFromPage}~)은 처음부터 뺐어요.` : ''}
                                            </p>
                                            <ul className="space-y-1 max-h-72 overflow-y-auto">
                                                {d.sections.map(s => {
                                                    const p = d.progress[s.key];
                                                    const pts = p?.pts || [];
                                                    const ok = pts.filter(x => x.st === 'ok').length;
                                                    const wrong = pts.filter(x => x.st === 'wrong').length;
                                                    const status = s.excluded ? '뺌' : p?.empty ? '낼 내용 없음' : !p?.pts ? '아직' : `요점 ${pts.length} · 맞힘 ${ok}${wrong ? ` · 틀림 ${wrong}` : ''}`;
                                                    return (
                                                        <li key={s.key}>
                                                            <button
                                                                onClick={() => toggleExclude(d, s.key)}
                                                                className={`w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-50 flex items-baseline gap-2 text-[12px] ${s.excluded ? 'opacity-50' : ''}`}
                                                                title={s.excluded ? '출제에 다시 넣기' : '출제에서 빼기'}
                                                            >
                                                                <span className="w-20 shrink-0 font-bold text-slate-600">{s.label}</span>
                                                                <span className={`flex-1 min-w-0 truncate text-slate-500 ${s.excluded ? 'line-through' : ''}`}>{s.head}</span>
                                                                <span className="shrink-0 text-slate-400">{status}</span>
                                                            </button>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                            <div className="flex flex-wrap gap-2 mt-3">
                                                <button onClick={() => setEditing({ id: d.id, title: d.title, source: d.source })} className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-500 hover:text-slate-800 flex items-center gap-1"><Pencil className="w-3 h-3" /> 제목·출처 고치기</button>
                                                {!notStarted && !st.roundDone && (
                                                    <button onClick={() => restart(d)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-500 hover:text-slate-800 flex items-center gap-1"><RotateCw className="w-3 h-3" /> 처음부터 다시</button>
                                                )}
                                                <button onClick={() => remove(d)} className="ml-auto px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-red-500 flex items-center gap-1"><Trash2 className="w-3 h-3" /> 지우기</button>
                                            </div>
                                            <p className="text-[11px] text-slate-400 mt-2">{d.fileName} · {d.charCount.toLocaleString()}자</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}

                    {syncError && <p className="text-[11px] text-clay-500 px-1">{syncError}</p>}

                    <div className="text-[11px] text-slate-400 leading-relaxed space-y-1 px-1">
                        <p>PDF 전체로 복습: 여러 PDF를 섞어 내되, PDF마다 앞 구간부터 안 푼 요점이 없어질 때까지 냅니다. 특정 PDF만 집중하려면 그 PDF의 "이 PDF만 풀기"를, 다 본 PDF는 "PDF 복습에 넣기"를 꺼 두세요.</p>
                        <p>문제 만드는 방식: 처음 푸는 구간마다 AI(Haiku)가 그 구간의 요점(수치·권고·기준·기전·결과 등)을 모두 뽑아 요점마다 OX 한 문제를 씁니다. 앞 구간부터 안 푼 요점이 없어질 때까지 내고, 맞힌 요점은 이번 바퀴에서 다시 나오지 않습니다. 정답 근거는 그 PDF 구간이고, 문제 화면에서 원문 구간을 바로 볼 수 있습니다.</p>
                        <p>한계: 그림·그래프 속 정보와 표의 칸 구조는 글로 뽑히는 만큼만 들어갑니다. 요점은 AI가 고르므로 아주 사소한 문장까지 하나하나 문제가 되지는 않습니다. 비용은 구간 하나에 약 $0.002 (30쪽 리뷰 약 $0.02~0.03).</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PdfLibraryView;
