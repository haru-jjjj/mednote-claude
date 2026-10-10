
import React, { useState, useEffect, useMemo } from 'react';
import { Note, QuizState, QuizQuestion, Source, QuizLanguage, PdfDoc } from '../types';
import { BrainCircuit, CheckCircle2, XCircle, ArrowRight, AlertTriangle, BookOpen, RotateCw, ExternalLink, Sparkles, Loader2, Zap, Trophy, Play, ArrowLeft, Layers, Microscope, Languages, FileText, X, Calendar, ChevronDown, ChevronUp, Trash2, FileUp, Shuffle } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { generateDetailedQuizExplanation, formatMedicalMarkdown } from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';
import { sourceKindOf, SOURCE_KIND_LABEL, sourceKindClass } from '../services/sourceKind';
import { collectWrongAnswers, WrongAnswerWithNote, REVIEW_PERIODS, ReviewPeriod, notesInPeriod, periodInfo, stripInlineOptions, stripOptionLabel } from '../services/studyUtils';
import { isRestingUntilDue } from '../services/quizCoverage';
import { pdfStats, resetPdfRound, poolStats, inPdfPool, PdfQuizFormat, PDF_FORMAT_LABEL, QUIZ_FORMATS, QUIZ_FORMAT_HINT, QUIZ_FORMAT_WITH, readPdfQuizFormat, savePdfQuizFormat, PdfOrder, readPdfOrder, savePdfOrder, imagesForSection } from '../services/pdfQuiz';
import { PdfImageStrip } from './PdfImages';
import { getPdfDoc, getPdfSectionText, getPdfSectionMd, updatePdfMeta, openPdfOriginal } from '../services/pdfLibrary';

const PERIOD_KEY = 'medinote_quiz_period';
const readPeriod = (): ReviewPeriod => {
  try { const v = localStorage.getItem(PERIOD_KEY); return REVIEW_PERIODS.some(p => p.key === v) ? (v as ReviewPeriod) : '1w'; } catch { return '1w'; }
};

interface QuizViewProps {
  notes: Note[];
  quizState: QuizState;
  onStart: (mode: 'DETAILED' | 'QUICK_OX' | 'CONCEPT' | 'MIXED', language: QuizLanguage, source?: 'RANDOM' | 'REVIEW' | 'PERIOD', period?: ReviewPeriod, opts?: { periodAll?: boolean }) => void;
  onNext: (wasCorrect: boolean, chosenIndex: number | null) => void;
  onStop: () => void;
  onEndSession: () => void;
  onRetry: () => void;
  onBack: () => void;
  reviewDueCount: number;
  onStartWrongReview: (entries: WrongAnswerWithNote[]) => void;
  onDeleteWrongAnswer: (noteId: string, questionId: string) => void;
  onOpenNote: (id: string) => void;
  isFetchingAll?: boolean;
  pdfDocs: PdfDoc[];
  onOpenPdfLibrary: () => void;
  onDiscard: () => void; // 문제 오류 — 기록 없이 넘기기 (§5-82)
  onStartPdf: (pdfId: string | null, mode: 'all' | 'wrong', language: QuizLanguage, format?: PdfQuizFormat, order?: PdfOrder) => void; // null = 전체 풀 (§5-76), order §5-81
}

const WRONG_LIST_PAGE = 10;

// 일본어 글이면 lang="ja"를 달아 일본어 글꼴로 보이게 (§5-74). 가나가 있으면 일본어로 봄
const hasKana = (s: string) => /[\u3040-\u30ff]/.test(s || '');
const langAttrOf = (language: QuizLanguage | undefined, sample: string): 'ja' | 'en' | 'ko' =>
    hasKana(sample) || language === 'Japanese' ? 'ja' : language === 'English' ? 'en' : 'ko';

const QuizView: React.FC<QuizViewProps> = ({ notes, quizState, onStart, onNext, onStop, onEndSession, onRetry, onBack, reviewDueCount, onStartWrongReview, onDeleteWrongAnswer, onOpenNote, isFetchingAll, pdfDocs, onOpenPdfLibrary, onStartPdf, onDiscard }) => {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  
  // Language Selection State
  // 마지막으로 고른 언어 기억 (§5-73: 화면을 다시 열면 한국어로 돌아가 버리던 문제)
  const [selectedLanguage, setSelectedLanguageState] = useState<QuizLanguage>(() => {
      try { const v = localStorage.getItem('medinote_quiz_language'); return v === 'English' || v === 'Japanese' ? v : 'Korean'; } catch { return 'Korean'; }
  });
  const setSelectedLanguage = (l: QuizLanguage) => { setSelectedLanguageState(l); try { localStorage.setItem('medinote_quiz_language', l); } catch { /* 이번 화면에선 동작 */ } };
  // 기간별 복습: 고른 기간(마지막 선택 기억)과 기간별 메모 수
  const [period, setPeriodState] = useState<ReviewPeriod>(readPeriod);
  const setPeriod = (p: ReviewPeriod) => { setPeriodState(p); try { localStorage.setItem(PERIOD_KEY, p); } catch { /* 저장 안 돼도 이번 화면에선 동작 */ } };
  // 기간별 메모 수 + 그중 맞혀서 다음 복습일까지 쉬는 메모 수 (§5-72)
  const periodStats = useMemo(() => {
      const now = Date.now();
      const out = {} as Record<ReviewPeriod, { all: number; resting: number }>;
      REVIEW_PERIODS.forEach(p => {
          const list = notesInPeriod(notes, p.key, now);
          out[p.key] = { all: list.length, resting: list.filter(n => isRestingUntilDue(n, now)).length };
      });
      return out;
  }, [notes]);
  const periodCounts = useMemo(() => {
      const out = {} as Record<ReviewPeriod, number>;
      REVIEW_PERIODS.forEach(p => { out[p.key] = periodStats[p.key].all - periodStats[p.key].resting; });
      return out;
  }, [periodStats]);

  // States for Deep Dive (Detailed Explanation)
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [enhancedExplanation, setEnhancedExplanation] = useState<{text: string, sources: Source[]} | null>(null);

  // State for Viewing Source Notes
  const [showSourceNotes, setShowSourceNotes] = useState(false);
  const [hydratedSourceNotes, setHydratedSourceNotes] = useState<Note[]>([]);
  
  // PDF 복습 문제 형식 (§5-79): OX / 케이스 / 섞어서 — 자료실과 공통으로 기억
  const [pdfFormat, setPdfFormatState] = useState<PdfQuizFormat>(readPdfQuizFormat);
  const setPdfFormat = (f: PdfQuizFormat) => { setPdfFormatState(f); savePdfQuizFormat(f); };
  // PDF 출제 순서 (§5-81): 앞에서부터 / 무작위
  const [pdfOrder, setPdfOrderState] = useState<PdfOrder>(readPdfOrder);
  const setPdfOrder = (o: PdfOrder) => { setPdfOrderState(o); savePdfOrder(o); };

  // PDF 문제: 근거가 된 PDF 구간 원문 보기 (§5-75)
  // md: 읽기용 정리본(§5-83, 있으면 기본으로 보여 줌), showRaw: 원래 뽑은 글로 보기
  const [pdfSourceText, setPdfSourceText] = useState<{ label: string; text: string | null; md?: string | null; showRaw?: boolean; error?: string } | null>(null);
  const openPdfSource = async (q: QuizQuestion) => {
      const ref = q.pdfRef;
      if (!ref) return;
      setPdfSourceText({ label: `${ref.docTitle} · ${ref.sectionLabel}`, text: null });
      try {
          const d = await getPdfDoc(ref.docId);
          if (!d) throw new Error('PDF를 찾지 못했습니다 (지워졌을 수 있어요).');
          const text = await getPdfSectionText(d, ref.sectionKey);
          // 그림·표 구간은 글 자체가 마크다운 (§5-84)
          const isFig = !!d.sections.find(x => x.key === ref.sectionKey)?.fig;
          const md = isFig ? text : await getPdfSectionMd(d, ref.sectionKey).catch(() => null);
          setPdfSourceText({ label: `${ref.docTitle} · ${ref.sectionLabel}`, text, md });
      } catch (e: any) {
          setPdfSourceText({ label: `${ref.docTitle} · ${ref.sectionLabel}`, text: '', error: e?.message || '원문을 불러오지 못했습니다.' });
      }
  };
  const currentPdf = quizState.source === 'PDF' ? pdfDocs.find(d => d.id === quizState.pdfId) : undefined;

  // State for Full Screen Image Viewing
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  // 오답 노트
  const wrongAnswers = useMemo(() => collectWrongAnswers(notes), [notes]);
  const [wrongVisible, setWrongVisible] = useState(WRONG_LIST_PAGE);
  const [expandedWrongId, setExpandedWrongId] = useState<string | null>(null);

  // Reset local state when question changes
  useEffect(() => {
      setSelectedOption(null);
      setIsRevealed(false);
      setEnhancedExplanation(null);
      setIsDetailLoading(false);
      setShowSourceNotes(false);
      setHydratedSourceNotes([]);
      setPdfSourceText(null);
  }, [quizState.currentQuestion?.id]);

  // Load full notes (with images) when Source Notes modal is opened
  useEffect(() => {
      if (showSourceNotes && quizState.currentQuestion?.relatedNoteIds) {
          const loadFullNotes = async () => {
              const ids = quizState.currentQuestion!.relatedNoteIds!;
              const loaded: Note[] = [];
              
              for (const id of ids) {
                  // Try to get from DB first to ensure we have images
                  try {
                      const fullNote = await getNoteFromDB(id);
                      if (fullNote) {
                          loaded.push(fullNote);
                      } else {
                          // Fallback to props
                          const partial = notes.find(n => n.id === id);
                          if (partial) loaded.push(partial);
                      }
                  } catch (e) {
                      console.error("Failed to load source note", id, e);
                      const partial = notes.find(n => n.id === id);
                      if (partial) loaded.push(partial);
                  }
              }
              setHydratedSourceNotes(loaded);
          };
          loadFullNotes();
      }
  }, [showSourceNotes, quizState.currentQuestion, notes]);

  const handleOptionClick = (index: number) => {
      if (!isRevealed) setSelectedOption(index);
  };

  const handleCheckAnswer = () => {
      if (selectedOption !== null) setIsRevealed(true);
  };

  const handleNext = () => {
      if (!quizState.currentQuestion) return;
      const isCorrect = selectedOption === quizState.currentQuestion.correctAnswerIndex;
      onNext(isCorrect, selectedOption);
  };

  const handleRequestDetail = async () => {
      if (!quizState.currentQuestion || isDetailLoading) return;
      setIsDetailLoading(true);
      
      const isTrue = quizState.currentQuestion.correctAnswerIndex === 0;
      // Pass the language from quizState to ensure explanation matches quiz language
      const result = await generateDetailedQuizExplanation(quizState.currentQuestion.question, isTrue, quizState.language);
      
      if (result) {
          setEnhancedExplanation({
              text: result.explanation,
              sources: result.sources
          });
      }
      setIsDetailLoading(false);
  };

  const renderMarkdown = (text: string) => {
      try {
          if (!text) return { __html: '' };
          let formatted = text.replace(/###/g, '\n\n###');
          // Apply medical formatting
          formatted = formatMedicalMarkdown(formatted);
          // breaks:false(CommonMark 기본값) — AI가 생성한 글은 문장 중간에 줄바꿈이
          // 섞여 있어도(특히 web_search 인용 처리 과정에서) 그걸 강제 줄바꿈으로
          // 보여주지 않고 자연스럽게 한 문단으로 이어지도록 합니다.
          const html = marked.parse(formatted, { breaks: false, gfm: true }) as string;
          return { __html: DOMPurify.sanitize(html) };
      } catch (e) { return { __html: text }; }
  };

  // Get labels based on current language
  const getLabels = () => {
      switch (quizState.language) {
          case 'English': return { source: 'Source Notes', close: 'Close' };
          case 'Japanese': return { source: '元のメモ', close: '閉じる' };
          default: return { source: '원본 메모', close: '닫기' };
      }
  };

  const labels = getLabels();

  // Helper to get image src
  const getImageSrc = (imgString: string) => {
      if (imgString.startsWith('http')) return imgString;
      return `data:image/jpeg;base64,${imgString}`;
  };

  // State 1: Mode Selection (Not Active)
  if (!quizState.isActive) {
      return (
          <div className="h-full bg-slate-50 overflow-y-auto animate-in fade-in">
              <div className="min-h-full flex flex-col items-center justify-center p-6">
                  <div className="w-full max-w-4xl mx-auto">
                      <div className="text-center mb-10">
                          <div className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-sm border border-slate-200 mb-6">
                              <BrainCircuit className="w-8 h-8 text-accent-600" />
                          </div>
                          <h2 className="text-2xl font-bold text-slate-900 mb-3">AI 퀴즈 복습</h2>
                          <p className="text-slate-500 mb-6 text-base">언어와 문제 형식을 고르고, 아래에서 복습할 범위를 시작하세요.</p>
                          
                          {/* Language Selection */}
                          <div className="inline-flex flex-wrap justify-center items-center bg-white border border-slate-200 rounded-xl p-1 shadow-sm gap-1">
                               {(['Korean', 'English', 'Japanese'] as QuizLanguage[]).map((lang) => (
                                   <button
                                      type="button"
                                      key={lang}
                                      onClick={() => setSelectedLanguage(lang)}
                                      className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2
                                        ${selectedLanguage === lang
                                            ? 'bg-accent-700 text-white shadow-sm'
                                            : 'text-slate-500 hover:bg-slate-100'}`}
                                   >
                                       <Languages className="w-3.5 h-3.5 shrink-0" />
                                       {lang === 'Korean' ? '한국어' : lang === 'English' ? 'English' : <span lang="ja">日本語</span>}
                                   </button>
                               ))}
                          </div>

                          {/* 문제 형식 (§5-85): 아래 모든 복습(오늘·기간·PDF·무작위)에 공통 */}
                          <div className="mt-3 flex flex-col items-center gap-1.5">
                              <div className="inline-flex flex-wrap justify-center items-center bg-white border border-slate-200 rounded-xl p-1 shadow-sm gap-1">
                                  {QUIZ_FORMATS.map(f => (
                                      <button
                                          type="button"
                                          key={f}
                                          onClick={() => setPdfFormat(f)}
                                          className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${pdfFormat === f ? 'bg-accent-700 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}
                                      >
                                          {PDF_FORMAT_LABEL[f]}
                                      </button>
                                  ))}
                              </div>
                              <p className="text-xs text-slate-400">{QUIZ_FORMAT_HINT[pdfFormat]}</p>
                          </div>
                      </div>
                      
                      {/* 오늘의 복습: 복습일이 된 메모로만 문제를 냄 (메모 1개당 1문제) */}
                      <div className={`mb-6 rounded-2xl border p-5 md:p-6 ${reviewDueCount > 0 ? 'bg-accent-50/70 border-accent-200' : 'bg-white border-slate-200'}`}>
                          <div className="flex items-start gap-3">
                              <div className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${reviewDueCount > 0 ? 'bg-accent-100 text-accent-700' : 'bg-slate-100 text-slate-400'}`}>
                                  <Calendar className="w-5 h-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                  <h3 className="text-lg font-bold text-slate-900">
                                      오늘의 복습 {reviewDueCount > 0 && <span className="text-accent-700">{reviewDueCount}개</span>}
                                  </h3>
                                  <p className="text-sm text-slate-500 leading-relaxed mt-1">
                                      {reviewDueCount > 0
                                          ? '복습일이 된 메모로 한 문제씩 냅니다. 맞히면 다음 복습이 3일 → 8일 → 20일 → 50일…로 늘고, 틀리면 내일 다시 나옵니다.'
                                          : '오늘 복습할 메모가 없어요. 아래 퀴즈를 풀면 문제에 쓰인 메모마다 다음 복습일이 자동으로 잡힙니다.'}
                                      {isFetchingAll && ' (예전 메모 불러오는 중…)'}
                                  </p>
                                  {reviewDueCount > 0 && (
                                      <div className="flex flex-wrap gap-2 mt-3">
                                          <button
                                              type="button"
                                              onClick={() => onStart(pdfFormat, selectedLanguage, 'REVIEW')}
                                              className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5"
                                          >
                                              <Play className="w-4 h-4" /> {QUIZ_FORMAT_WITH[pdfFormat]} 복습 시작
                                          </button>
                                      </div>
                                  )}
                              </div>
                          </div>
                      </div>

                      {/* 기간별 복습: 고른 기간에 새로 쓰거나 고친 메모로만 냄 */}
                      <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
                          <div className="flex items-start gap-3">
                              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-slate-100 text-slate-500">
                                  <Layers className="w-5 h-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                  <h3 className="text-lg font-bold text-slate-900">기간별 복습</h3>
                                  <p className="text-sm text-slate-500 leading-relaxed mt-1">
                                      고른 기간에 쓰거나 고친 메모(질문 노트 포함)로만 냅니다. 맞힌 메모는 다음 복습일까지 빼고, 아직 안 물어본 부분이나 틀린 메모를 냅니다.
                                  </p>
                                  <div className="flex flex-wrap gap-1.5 mt-3">
                                      {REVIEW_PERIODS.map(p => (
                                          <button
                                              key={p.key}
                                              type="button"
                                              onClick={() => setPeriod(p.key)}
                                              className={`px-3 py-1.5 rounded-lg border text-sm font-bold transition-colors ${period === p.key ? 'bg-accent-50 border-accent-300 text-accent-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}
                                          >
                                              {p.label} <span className={`text-xs font-normal ${period === p.key ? 'text-accent-600' : 'text-slate-400'}`}>{periodCounts[p.key]}</span>
                                          </button>
                                      ))}
                                  </div>
                                  <p className="text-xs text-slate-400 mt-2">
                                      {periodStats[period].all === 0
                                          ? `${periodInfo(period).long} 동안 쓰거나 고친 메모가 없어요.`
                                          : periodCounts[period] > 0
                                              ? `${periodInfo(period).long} 풀 메모 ${periodCounts[period]}개${periodStats[period].resting ? ` · 맞혀서 다음 복습일까지 쉬는 메모 ${periodStats[period].resting}개는 빼고 냄` : ''}`
                                              : `${periodInfo(period).long} 메모 ${periodStats[period].all}개를 모두 맞혔어요. 다음 복습일이 되면 다시 나옵니다.`}
                                      {isFetchingAll && ' (예전 메모 불러오는 중…)'}
                                  </p>
                                  <div className="flex flex-wrap gap-2 mt-3">
                                      <button
                                          type="button"
                                          onClick={() => onStart(pdfFormat, selectedLanguage, 'PERIOD', period, { periodAll: periodCounts[period] === 0 })}
                                          disabled={periodStats[period].all === 0}
                                          className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                          <Play className="w-4 h-4" /> {periodCounts[period] === 0 && periodStats[period].all > 0 ? `맞힌 메모도 ${QUIZ_FORMAT_WITH[pdfFormat]} 다시 풀기` : `${QUIZ_FORMAT_WITH[pdfFormat]} 시작`}
                                      </button>
                                  </div>
                              </div>
                          </div>
                      </div>

                      {/* PDF 복습 (§5-75, §5-76): 올린 PDF 전체를 한 풀로 — PDF끼리 섞고, 각 PDF 안에서는 앞에서부터 빠짐없이 */}
                      {(() => {
                          const ps = poolStats(pdfDocs);
                          const outCount = pdfDocs.length - ps.docs;
                          return (
                              <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
                                  <div className="flex items-start gap-3">
                                      <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-slate-100 text-slate-500">
                                          <FileText className="w-5 h-5" />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-2">
                                              <h3 className="text-lg font-bold text-slate-900">PDF 복습</h3>
                                              <button type="button" onClick={onOpenPdfLibrary} className="ml-auto shrink-0 text-xs font-bold text-accent-700 hover:text-accent-800 flex items-center gap-1">
                                                  <FileUp className="w-3.5 h-3.5" /> PDF 자료실{pdfDocs.length > 0 ? ` ${pdfDocs.length}` : ''}
                                              </button>
                                          </div>
                                          <p className="text-sm text-slate-500 leading-relaxed mt-1">
                                              {pdfDocs.length === 0
                                                  ? 'PDF를 올리면 구간마다 요점을 정리해 요점 하나당 한 문제(위에서 고른 형식)로, 처음부터 끝까지 빠짐없이 냅니다.'
                                                  : `올린 PDF ${ps.docs}개를 섞어서 냅니다. 안 푼 요점만 내서 한 바퀴 돌면 모든 요점을 빠짐없이 만나고, 맞힌 요점은 이번 바퀴에 다시 안 나와요.`}
                                          </p>
                                          {pdfDocs.length > 0 && (
                                              <>
                                                  <div className="mt-3 flex items-center gap-2">
                                                      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                                          <div className="h-full rounded-full bg-accent-500" style={{ width: `${ps.percent}%` }} />
                                                      </div>
                                                      <span className="text-[11px] text-slate-400 shrink-0">{ps.allDone ? '모두 한 바퀴 끝' : `${ps.percent}%`}</span>
                                                  </div>
                                                  <p className="text-[11px] text-slate-400 mt-1">
                                                      구간 {ps.sectionsDone}/{ps.sections} · 맞힘 {ps.ok} · 틀림 {ps.wrong}{outCount > 0 ? ` · 복습에서 뺀 PDF ${outCount}개` : ''}
                                                  </p>
                                                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                                                      <span className="text-[11px] text-slate-400 mr-1">출제 순서</span>
                                                      {(['random', 'seq'] as PdfOrder[]).map(o => (
                                                          <button
                                                              key={o}
                                                              type="button"
                                                              onClick={() => setPdfOrder(o)}
                                                              className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${pdfOrder === o ? 'bg-accent-50 border-accent-300 text-accent-700' : 'bg-white border-slate-200 text-slate-500'}`}
                                                          >
                                                              {o === 'random' ? '무작위' : '앞에서부터'}
                                                          </button>
                                                      ))}
                                                  </div>
                                                  <div className="flex flex-wrap gap-2 mt-3">
                                                      <button
                                                          type="button"
                                                          onClick={() => (ps.allDone ? onOpenPdfLibrary() : onStartPdf(null, 'all', selectedLanguage, pdfFormat, pdfOrder))}
                                                          disabled={ps.docs === 0}
                                                          className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                                                      >
                                                          <Zap className="w-4 h-4" /> {ps.allDone ? '다 풀었어요 — 자료실에서 다시' : ps.sectionsDone + ps.ok + ps.wrong === 0 ? 'PDF 전체 풀기' : '이어서 풀기'}
                                                      </button>
                                                      {ps.wrong > 0 && (
                                                          <button type="button" onClick={() => onStartPdf(null, 'wrong', selectedLanguage, pdfFormat, pdfOrder)} className="px-4 py-2 rounded-xl bg-white border border-clay-300 text-clay-600 text-sm font-bold hover:bg-clay-50 flex items-center gap-1.5">
                                                              <RotateCw className="w-4 h-4" /> 틀린 것 {ps.wrong}개
                                                          </button>
                                                      )}
                                                  </div>
                                              </>
                                          )}
                                      </div>
                                  </div>
                              </div>
                          );
                      })()}

                      {/* 무작위 퀴즈: 위에서 고른 형식으로 */}
                      <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6">
                          <div className="flex items-start gap-3">
                              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-slate-100 text-slate-500">
                                  <Shuffle className="w-5 h-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                  <h3 className="text-lg font-bold text-slate-900">무작위 퀴즈</h3>
                                  <p className="text-sm text-slate-500 leading-relaxed mt-1">전체 메모에서 냅니다. 복습일이 된 메모와 아직 안 푼 메모가 더 자주 나옵니다. 해설과 근거 자료가 함께 나옵니다.</p>
                                  <div className="flex flex-wrap gap-2 mt-3">
                                      <button
                                          type="button"
                                          onClick={() => onStart(pdfFormat, selectedLanguage)}
                                          disabled={notes.length === 0}
                                          className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                          <Play className="w-4 h-4" /> {QUIZ_FORMAT_WITH[pdfFormat]} 시작
                                      </button>
                                  </div>
                              </div>
                          </div>
                      </div>

                      {notes.length === 0 && (
                          <div className="mt-8 p-4 bg-red-50 text-red-600 text-center rounded-xl text-sm font-medium">
                              You need to add some notes before starting the quiz.
                          </div>
                      )}

                      {/* 오답 노트 */}
                      <div className="mt-8 bg-white rounded-2xl border border-slate-200 p-5 md:p-6">
                          <div className="flex flex-wrap items-center gap-3 mb-1">
                              <div className="w-10 h-10 shrink-0 rounded-xl bg-clay-50 text-clay-500 flex items-center justify-center">
                                  <XCircle className="w-5 h-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                  <h3 className="text-lg font-bold text-slate-900">오답 노트 {wrongAnswers.length > 0 && <span className="text-clay-500">{wrongAnswers.length}</span>}</h3>
                                  <p className="text-xs text-slate-500">틀린 문제는 해설·원본 메모와 함께 자동 저장됩니다. 다시 풀어서 맞히면 빠집니다.</p>
                              </div>
                              {wrongAnswers.length > 0 && (
                                  <button
                                      type="button"
                                      onClick={() => onStartWrongReview(wrongAnswers)}
                                      className="px-4 py-2 rounded-xl bg-clay-500 text-white text-sm font-bold hover:bg-clay-600 transition-colors flex items-center gap-1.5 whitespace-nowrap"
                                  >
                                      <RotateCw className="w-4 h-4" /> 틀린 문제 다시 풀기
                                  </button>
                              )}
                          </div>
                          {wrongAnswers.length === 0 ? (
                              <p className="text-sm text-slate-400 mt-3">아직 틀린 문제가 없어요.</p>
                          ) : (
                              <div className="mt-4 space-y-2">
                                  {wrongAnswers.slice(0, wrongVisible).map(w => {
                                      const isOpen = expandedWrongId === w.id;
                                      const optLabel = (i: number) => w.type === 'OX' ? (i === 0 ? 'O' : 'X') : (i >= 0 ? String.fromCharCode(65 + i) : '—');
                                      return (
                                          <div key={w.id} className="border border-slate-200 rounded-xl overflow-hidden" lang={langAttrOf(w.language, `${w.question} ${w.explanation || ''}`)}>
                                              <button
                                                  type="button"
                                                  onClick={() => setExpandedWrongId(isOpen ? null : w.id)}
                                                  className="w-full text-left p-3 hover:bg-slate-50 transition-colors flex items-start gap-2"
                                              >
                                                  <span className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${w.type === 'OX' ? 'bg-accent-100 text-accent-700' : 'bg-accent-100 text-accent-700'}`}>
                                                      {w.type === 'OX' ? 'OX' : w.style === 'concept' ? '5지선다' : '케이스'}
                                                  </span>
                                                  <span className={`flex-1 min-w-0 text-sm text-slate-700 ${isOpen ? '' : 'line-clamp-2'}`}>
                                                      {(w.type === 'OX' ? w.question : stripInlineOptions(w.question)).replace(/[#*`>]/g, '')}
                                                  </span>
                                                  {isOpen ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                                              </button>
                                              <div className="px-3 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                                                  <span>내 답 <b className="text-red-500">{optLabel(w.chosenIndex)}</b> · 정답 <b className="text-sage-600">{optLabel(w.correctAnswerIndex)}</b></span>
                                                  {(w.wrongCount || 1) > 1 && <span className="text-clay-500 font-bold">{w.wrongCount}번 틀림</span>}
                                                  <span>{new Date(w.wrongAt).toLocaleDateString()}</span>
                                                  <button type="button" onClick={() => onOpenNote(w.noteId)} className="text-accent-500 hover:text-accent-700 font-bold truncate max-w-[180px]" title="원본 메모 열기">
                                                      {w.noteTitle}
                                                  </button>
                                                  <button
                                                      type="button"
                                                      onClick={() => { if (confirm('이 문제를 오답 노트에서 뺄까요?')) onDeleteWrongAnswer(w.noteId, w.id); }}
                                                      className="ml-auto p-1 text-slate-300 hover:text-red-500"
                                                      title="오답 노트에서 빼기"
                                                  >
                                                      <Trash2 className="w-3.5 h-3.5" />
                                                  </button>
                                              </div>
                                              {isOpen && (
                                                  <div className="px-3 pb-3 border-t border-slate-100 bg-slate-50/60">
                                                      {w.type !== 'OX' && (
                                                          <ol className="mt-2 space-y-1 text-sm">
                                                              {w.options.map((o, i) => (
                                                                  <li key={i} className={`flex gap-2 ${i === w.correctAnswerIndex ? 'text-sage-700 font-bold' : i === w.chosenIndex ? 'text-red-600 line-through' : 'text-slate-500'}`}>
                                                                      <span className="shrink-0">{String.fromCharCode(65 + i)}.</span>
                                                                      <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(formatMedicalMarkdown(stripOptionLabel(o))) }} />
                                                                  </li>
                                                              ))}
                                                          </ol>
                                                      )}
                                                      {w.explanation && (
                                                          <div className="prose prose-sm prose-slate max-w-none mt-3" dangerouslySetInnerHTML={renderMarkdown(w.explanation)} />
                                                      )}
                                                      {w.sources && w.sources.length > 0 && (
                                                          <div className="flex flex-wrap gap-2 mt-2">
                                                              {w.sources.map((src, i) => (
                                                                  <a key={i} href={src.uri} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent-600 bg-white border border-slate-200 rounded px-2 py-1 truncate max-w-[220px] hover:border-accent-300">
                                                                      {src.title || src.uri}
                                                                  </a>
                                                              ))}
                                                          </div>
                                                      )}
                                                  </div>
                                              )}
                                          </div>
                                      );
                                  })}
                                  {wrongAnswers.length > wrongVisible && (
                                      <button type="button" onClick={() => setWrongVisible(v => v + WRONG_LIST_PAGE)} className="w-full py-2 text-xs font-bold text-slate-500 hover:text-slate-700">
                                          더 보기 ({wrongAnswers.length - wrongVisible}개 더)
                                      </button>
                                  )}
                              </div>
                          )}
                      </div>
                  </div>
              </div>
          </div>
      );
  }

  // State 2-a: 더 낼 문제가 없음 (오늘 복습 끝 / 오답 다시 풀기 끝)
  if (!quizState.currentQuestion && quizState.noMoreQuestions && !quizState.isGenerating && !quizState.error && quizState.source === 'PDF') {
      const { correct, total } = quizState.stats;
      const wrongMode = quizState.pdfMode === 'wrong';
      const isPool = !quizState.pdfId;
      // 한 PDF / 전체 풀(§5-76) 공통으로 쓰는 요약
      const one = currentPdf ? pdfStats(currentPdf) : null;
      const pool = isPool ? poolStats(pdfDocs) : null;
      const sum = isPool
          ? (pool ? { points: pool.points, ok: pool.ok, wrong: pool.wrong, roundDone: pool.allDone, left: pool.sections - pool.sectionsDone } : null)
          : (one ? { points: one.points, ok: one.ok, wrong: one.wrong, roundDone: one.roundDone, left: one.sections - one.sectionsDone } : null);
      const startId = isPool ? null : (currentPdf?.id || null);
      const restartDone = async () => {
          if (!confirm(isPool ? '다 푼 PDF를 처음부터 다시 풀까요? 같은 요점을 새 문장으로 다시 냅니다.' : '처음부터 다시 풀까요? 같은 요점을 새 문장으로 다시 냅니다.')) return;
          const targets = isPool ? pdfDocs.filter(d => inPdfPool(d) && pdfStats(d).roundDone) : (currentPdf ? [currentPdf] : []);
          for (const d of targets) await updatePdfMeta(d.id, x => ({ progress: resetPdfRound(x, Date.now()), round: (x.round || 0) + 1 }));
          onStartPdf(startId, 'all', quizState.language, (quizState.mode || 'QUICK_OX') as PdfQuizFormat, quizState.pdfOrder || 'seq');
      };
      return (
          <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 text-center animate-in fade-in">
              <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center mb-6">
                  <Trophy className="w-8 h-8 text-accent-500" />
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-1">
                  {wrongMode ? '틀린 문제 다시 풀기 끝' : isPool ? 'PDF 전체 한 바퀴 끝' : 'PDF 한 바퀴 끝'}
              </h2>
              <p className="text-sm text-slate-500 mb-3 max-w-sm">{isPool ? `PDF 복습에 넣은 PDF ${pool?.docs || 0}개` : currentPdf?.title}</p>
              {total > 0 && <p className="text-slate-500 text-sm mb-2">이번에 {total}문제 중 <b className="text-slate-800">{correct}</b>개 정답</p>}
              {sum && (
                  <p className="text-slate-400 text-xs mb-8 max-w-sm leading-relaxed">
                      지금까지 만든 요점 {sum.points}개 · 맞힘 {sum.ok} · 틀림 {sum.wrong}
                      {!sum.roundDone
                          ? ` — 아직 안 푼 구간이 ${sum.left}개 있어요.`
                          : sum.wrong > 0 ? ' — 틀린 요점은 같은 문제로 다시 풀 수 있어요.' : ' — 모두 맞혔어요.'}
                  </p>
              )}
              <div className="flex flex-col gap-3 w-full max-w-xs">
                  {sum && sum.wrong > 0 && (
                      <button type="button" onClick={() => onStartPdf(startId, 'wrong', quizState.language, (quizState.mode || 'QUICK_OX') as PdfQuizFormat, quizState.pdfOrder || 'seq')} className="w-full bg-white border border-clay-300 text-clay-600 hover:bg-clay-50 py-3 rounded-xl font-bold transition-all">
                          틀린 것 {sum.wrong}개 다시 풀기
                      </button>
                  )}
                  {sum && !sum.roundDone && (
                      <button type="button" onClick={() => onStartPdf(startId, 'all', quizState.language, (quizState.mode || 'QUICK_OX') as PdfQuizFormat, quizState.pdfOrder || 'seq')} className="w-full bg-white border border-accent-300 text-accent-700 hover:bg-accent-50 py-3 rounded-xl font-bold transition-all">
                          남은 구간 이어서 풀기
                      </button>
                  )}
                  {sum?.roundDone && (
                      <button type="button" onClick={restartDone} className="w-full bg-white border border-accent-300 text-accent-700 hover:bg-accent-50 py-3 rounded-xl font-bold transition-all">
                          처음부터 다시 (새 문장으로)
                      </button>
                  )}
                  <button type="button" onClick={() => { onEndSession(); onOpenPdfLibrary(); }} className="w-full bg-accent-700 text-white hover:bg-accent-800 py-3 rounded-xl font-bold shadow-sm transition-all">
                      PDF 자료실로
                  </button>
                  <button type="button" onClick={onEndSession} className="w-full text-slate-400 hover:text-slate-600 py-2 text-sm font-medium transition-colors">
                      퀴즈 첫 화면으로
                  </button>
              </div>
          </div>
      );
  }

  if (!quizState.currentQuestion && quizState.noMoreQuestions && !quizState.isGenerating && !quizState.error) {
      const { correct, total } = quizState.stats;
      // 기간별 복습이 "남은 메모가 모두 맞혀서 쉬는 중"이라 끝났는지 (§5-72)
      const ps = quizState.source === 'PERIOD' && quizState.period ? periodStats[quizState.period] : null;
      const periodAllRested = !!ps && !quizState.periodAll && ps.all > 0 && ps.resting >= ps.all;
      const title = quizState.source === 'WRONG'
          ? '오답 다시 풀기 완료'
          : quizState.source === 'PERIOD'
              ? (periodAllRested
                  ? `${periodInfo(quizState.period).long} 메모를 모두 맞혔어요`
                  : total === 0 ? `${periodInfo(quizState.period).long} 동안 쓰거나 고친 메모가 없어요` : `${periodInfo(quizState.period).long} 복습 — 더 낼 메모가 없어요`)
              : total === 0 ? '오늘 복습할 메모가 없어요' : '오늘의 복습 완료';
      return (
          <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 text-center animate-in fade-in">
              <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center mb-6">
                  <Trophy className="w-8 h-8 text-accent-500" />
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-2">{title}</h2>
              {total > 0 && (
                  <p className="text-slate-500 text-sm mb-2">{total}문제 중 <b className="text-slate-800">{correct}</b>개 정답</p>
              )}
              <p className="text-slate-400 text-xs mb-8 max-w-sm leading-relaxed">
                  {quizState.source === 'WRONG'
                      ? '맞힌 문제는 오답 노트에서 빠졌고, 또 틀린 문제는 그대로 남아 있습니다.'
                      : periodAllRested
                      ? '맞힌 메모는 다음 복습일(3일 → 8일 → 20일 …)이 되면 다시 나옵니다. 지금 다시 풀고 싶으면 아래 버튼을 누르세요.'
                      : quizState.source === 'PERIOD' && total === 0
                      ? '기간을 더 길게 골라 보세요.'
                      : '틀린 문제는 오답 노트에 저장됐고, 해당 메모는 내일 다시 복습 목록에 나옵니다.'}
              </p>
              <div className="flex flex-col gap-3 w-full max-w-xs">
                  {periodAllRested && quizState.mode && (
                      <button
                          type="button"
                          onClick={() => onStart(quizState.mode!, quizState.language, 'PERIOD', quizState.period, { periodAll: true })}
                          className="w-full bg-white border border-accent-300 text-accent-700 hover:bg-accent-50 py-3 rounded-xl font-bold transition-all"
                      >
                          맞힌 메모도 다시 풀기
                      </button>
                  )}
                  <button type="button" onClick={onEndSession} className="w-full bg-accent-700 text-white hover:bg-accent-800 py-3 rounded-xl font-bold shadow-sm transition-all">
                      퀴즈 첫 화면으로
                  </button>
                  <button type="button" onClick={onStop} className="w-full text-slate-400 hover:text-slate-600 py-2 text-sm font-medium transition-colors">
                      메모 목록으로
                  </button>
              </div>
          </div>
      );
  }

  // State 2: Active but loading first question or next question not ready
  if (!quizState.currentQuestion) {
       return (
          <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 text-center animate-in fade-in">
              <div className="relative mb-8">
                  <div className="w-20 h-20 border-4 border-slate-200 rounded-full"></div>
                  <div className="w-20 h-20 border-4 border-accent-600 rounded-full border-t-transparent animate-spin absolute top-0 left-0"></div>
                  <div className="absolute inset-0 flex items-center justify-center">
                      <Sparkles className="w-6 h-6 text-accent-600" />
                  </div>
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-2">
                  {quizState.error ? '문제가 발생했습니다' : (quizState.mode === 'QUICK_OX' ? 'OX 문제 만드는 중...' : quizState.mode === 'MIXED' ? '문제 만드는 중...' : quizState.mode === 'CONCEPT' ? '5지선다 문제 만드는 중...' : '케이스 문제 만드는 중...')}
              </h2>
              <p className="text-slate-400 text-sm mb-8">
                  {quizState.error ? quizState.error : quizState.source === 'PDF' ? 'PDF 구간의 요점을 정리해 문제를 만들고 있습니다.\n구간마다 처음 한 번만 시간이 걸려요 (10~30초).' : 'AI가 메모를 분석하여 문제를 만들고 있습니다.\n잠시만 기다려주세요.'}
              </p>
              
              <div className="flex flex-col gap-3 w-full max-w-xs">
                  {quizState.error ? (
                    <button 
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRetry(); }} 
                        className="w-full bg-accent-600 text-white hover:bg-accent-700 py-3 rounded-xl font-bold shadow-sm transition-all flex items-center justify-center gap-2"
                    >
                        <RotateCw className="w-4 h-4" /> 다시 시도하기
                    </button>
                  ) : (
                    <button type="button" onClick={onBack} className="w-full bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 hover:border-slate-400 py-3 rounded-xl font-bold shadow-sm transition-all flex items-center justify-center gap-2">
                        <Layers className="w-4 h-4" /> 메모 보면서 기다리기
                    </button>
                  )}
                  <button type="button" onClick={onStop} className="w-full text-slate-400 hover:text-red-500 py-2 text-sm font-medium transition-colors">
                      {quizState.error ? '나가기' : '생성 취소'}
                  </button>
              </div>
          </div>
       );
  }

  // State 3: Active Question
  const currentQ = quizState.currentQuestion;
  const isOX = currentQ.type === 'OX';

  return (
    <div
        className="h-full flex flex-col bg-slate-50 overflow-hidden relative"
        lang={langAttrOf(quizState.language, [currentQ.question, ...(currentQ.options || []), currentQ.explanation || ''].join(' '))}
    >
        {/* Header */}
        <div className="h-12 px-4 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 z-10 shadow-sm">
            <div className="flex items-center gap-3">
                <button type="button" onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors" title="뒤로 (퀴즈 유지)">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className={`p-2 rounded-lg ${isOX ? 'bg-accent-50 text-accent-600' : 'bg-accent-50 text-accent-600'}`}>
                    {isOX ? <Zap className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
                </div>
                <div>
                    <h2 className="font-bold text-slate-800 text-base md:text-lg">
                        {quizState.source === 'PDF' ? <span className="block max-w-[52vw] md:max-w-md truncate">{quizState.pdfId ? 'PDF' : 'PDF 복습'} · {currentQ.pdfRef?.docTitle || currentPdf?.title || ''}</span> : quizState.source === 'REVIEW' ? '오늘의 복습' : quizState.source === 'WRONG' ? '오답 다시 풀기' : quizState.source === 'PERIOD' ? `기간 복습 · ${periodInfo(quizState.period).long}` : (isOX ? 'OX 빠른 복습' : currentQ.style === 'concept' ? '5지선다' : '케이스 문제')}
                    </h2>
                    <div className="text-[11px] text-slate-400 flex items-center gap-1">
                        <Trophy className="w-3 h-3" /> Score: {quizState.stats.correct}/{quizState.stats.total}
                    </div>
                </div>
            </div>
            <button type="button" onClick={onStop} className="text-[11px] font-bold text-slate-400 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors">
                End Session
            </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-4 md:p-8 pb-32">
                {/* Question Card */}
                <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 md:p-10 mb-6 animate-in slide-in-from-right duration-300">
                    <span className={`inline-block px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider mb-4 
                        ${isOX ? 'bg-accent-100 text-accent-700' : 'bg-accent-100 text-accent-700'}`}>
                        {isOX ? '참 / 거짓' : currentQ.style === 'concept' ? '5지선다' : '케이스'}
                    </span>
                    {/* PDF 문제: 어느 자료의 문제인지 (§5-86d) */}
                    {currentQ.pdfRef?.docTitle && (
                        <p className="text-[12px] text-slate-400 leading-snug -mt-1 mb-2 line-clamp-2 break-words">{currentQ.pdfRef.docTitle}</p>
                    )}
                    {/* Render Question with Medical Formatting */}
                    {/* 케이스 문제는 긴 임상 상황이라 왼쪽 정렬·보통 굵기로, 본문에 섞여 온 보기는 잘라냄 (§5-80) */}
                    <h3 className={`${isOX ? 'text-xl md:text-2xl text-center py-6 font-bold' : 'text-base md:text-lg text-left font-medium'} text-slate-900 leading-relaxed`} dangerouslySetInnerHTML={renderMarkdown(isOX ? currentQ.question : stripInlineOptions(currentQ.question))}>
                    </h3>
                    
                    {/* OX Specific UI */}
                    {isOX && (
                        <div className="flex gap-4 mt-6">
                            {['O', 'X'].map((opt, idx) => {
                                const isSelected = selectedOption === idx;
                                const isCorrect = currentQ.correctAnswerIndex === idx;
                                let btnClass = "flex-1 aspect-square md:aspect-auto md:h-24 rounded-xl text-2xl font-black border-2 transition-all flex items-center justify-center shadow-sm active:scale-95";
                                
                                if (isRevealed) {
                                    if (isCorrect) btnClass += " bg-sage-500 border-sage-500 text-white opacity-100";
                                    else if (isSelected) btnClass += " bg-red-500 border-red-500 text-white opacity-100";
                                    else btnClass += " bg-slate-50 border-slate-200 text-slate-300 opacity-50";
                                } else {
                                    if (opt === 'O') btnClass += isSelected ? " border-accent-500 bg-accent-600 text-white" : " border-slate-200 hover:border-accent-300 hover:bg-accent-50 text-accent-500";
                                    else btnClass += isSelected ? " border-red-500 bg-red-500 text-white" : " border-slate-200 hover:border-red-300 hover:bg-red-50 text-red-500";
                                }

                                return (
                                    <button 
                                        type="button"
                                        key={opt} 
                                        onClick={() => handleOptionClick(idx)}
                                        disabled={isRevealed}
                                        className={btnClass}
                                    >
                                        {opt}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Multiple Choice Specific UI */}
                    {!isOX && (
                        <div className="space-y-3 mt-6">
                             {currentQ.options.map((option, idx) => {
                                let statusClass = "border-slate-200 hover:border-accent-400 hover:bg-accent-50 text-slate-700";
                                const isSelected = selectedOption === idx;
                                const isCorrect = currentQ.correctAnswerIndex === idx;
                                if (isRevealed) {
                                    if (isCorrect) statusClass = "border-sage-500 bg-sage-50 text-sage-900 ring-1 ring-sage-500 font-bold";
                                    else if (isSelected && !isCorrect) statusClass = "border-red-500 bg-red-50 text-red-900 ring-1 ring-red-500";
                                    else statusClass = "border-slate-100 text-slate-400 opacity-60";
                                } else if (isSelected) statusClass = "border-accent-600 bg-accent-50 ring-1 ring-accent-600 text-accent-900 font-medium";

                                return (
                                    <button type="button" key={idx} onClick={() => handleOptionClick(idx)} disabled={isRevealed} className={`w-full text-left p-4 rounded-lg border transition-all flex items-start gap-3 ${statusClass}`}>
                                        <div className={`w-6 h-6 rounded-full border flex-shrink-0 flex items-center justify-center text-[11px] font-bold ${isRevealed && isCorrect ? 'border-sage-600 bg-sage-600 text-white' : isRevealed && isSelected && !isCorrect ? 'border-red-500 bg-red-500 text-white' : isSelected ? 'border-accent-600 bg-accent-600 text-white' : 'border-slate-300 text-slate-400'}`}>
                                            {String.fromCharCode(65 + idx)}
                                        </div>
                                        <span className="text-base" dangerouslySetInnerHTML={{__html: DOMPurify.sanitize(formatMedicalMarkdown(stripOptionLabel(option)))}}></span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
                
                {/* Explanation */}
                {isRevealed && (
                    <div className="bg-slate-100 rounded-3xl p-6 md:p-8 animate-in fade-in slide-in-from-bottom-4 relative">
                        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                            <div className="flex items-center gap-2 font-bold text-slate-800 shrink-0">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white ${selectedOption === currentQ.correctAnswerIndex ? 'bg-sage-500' : 'bg-red-500'}`}>
                                    {selectedOption === currentQ.correctAnswerIndex ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                                </div>
                                <span>{selectedOption === currentQ.correctAnswerIndex ? '정답' : '오답'}</span>
                            </div>
                            
                            <div className="flex gap-2 ml-auto">
                                {/* View Source Notes Button */}
                                {quizState.currentQuestion?.relatedNoteIds && quizState.currentQuestion.relatedNoteIds.length > 0 && (
                                    <button 
                                        type="button"
                                        onClick={() => setShowSourceNotes(true)}
                                        className="whitespace-nowrap text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 px-3 py-2 rounded-full flex items-center gap-1.5 transition-all shadow-sm"
                                    >
                                        <FileText className="w-3.5 h-3.5" />
                                        {labels.source}
                                    </button>
                                )}

                                {/* OX Deep Dive Button */}
                                {isOX && !enhancedExplanation && (
                                    <button 
                                        type="button"
                                        onClick={handleRequestDetail}
                                        disabled={isDetailLoading}
                                        className="whitespace-nowrap text-[11px] font-bold text-accent-600 bg-accent-50 hover:bg-accent-100 border border-accent-200 px-3 py-2 rounded-full flex items-center gap-1.5 transition-all disabled:opacity-50 shadow-sm"
                                    >
                                        {isDetailLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Microscope className="w-3.5 h-3.5" />}
                                        {isDetailLoading ? "해설 만드는 중..." : "자세한 해설"}
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="prose prose-sm prose-slate max-w-none mb-6">
                            {isOX && !enhancedExplanation ? (
                                <p className="text-base text-slate-700 leading-relaxed font-medium" dangerouslySetInnerHTML={{__html: DOMPurify.sanitize(formatMedicalMarkdown(currentQ.explanation || ''))}}></p>
                            ) : (
                                <div dangerouslySetInnerHTML={renderMarkdown(enhancedExplanation ? enhancedExplanation.text : (currentQ.explanation || ""))} />
                            )}
                        </div>
                        
                        {/* Sources */}
                        {(!isOX && currentQ.sources && currentQ.sources.length > 0) || (enhancedExplanation && enhancedExplanation.sources && enhancedExplanation.sources.length > 0) ? (
                             <div className="mt-6 pt-4 border-t border-slate-200">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1">
                                    <BookOpen className="w-3.5 h-3.5" /> 참고 자료
                                </h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {(enhancedExplanation ? enhancedExplanation.sources : currentQ.sources)?.map((src, i) => (
                                        <a 
                                            key={i} 
                                            href={src.uri} 
                                            target="_blank" 
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 hover:border-accent-300 hover:shadow-sm transition-all group"
                                        >
                                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-accent-100 group-hover:text-accent-600 transition-colors shrink-0">
                                                <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-accent-600" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-xs font-bold text-slate-700 truncate group-hover:text-accent-700">
                                                    {src.title || "Reference Source"}
                                                </div>
                                                <div className="text-[10px] text-slate-400 truncate">
                                                    <span className={`inline-block mr-1 px-1.5 rounded border font-bold ${sourceKindClass(sourceKindOf(src))}`}>{SOURCE_KIND_LABEL[sourceKindOf(src)]}</span>
                                                    {src.uri}
                                                </div>
                                            </div>
                                        </a>
                                    ))}
                                </div>
                             </div>
                        ) : null}

                        {currentQ.pdfRef && (
                            <div className="mt-6 pt-4 border-t border-slate-200">
                                <h4 className="text-xs font-bold text-slate-400 mb-2 flex items-center gap-1">
                                    <FileText className="w-3.5 h-3.5" /> 근거 (PDF)
                                </h4>
                                <p className="text-[13px] text-slate-700 font-bold">{currentQ.pdfRef.docTitle}</p>
                                {currentQ.pdfRef.docSource && (
                                    /^https?:\/\//.test(currentQ.pdfRef.docSource)
                                        ? <a href={currentQ.pdfRef.docSource} target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent-600 break-all hover:underline">{currentQ.pdfRef.docSource}</a>
                                        : <p className="text-[12px] text-slate-500 break-words">{currentQ.pdfRef.docSource}</p>
                                )}
                                <p className="text-[11px] text-slate-400 mt-1">
                                    {currentQ.pdfRef.sectionLabel} · 구간 {currentQ.pdfRef.sectionIndex + 1}/{currentQ.pdfRef.sectionCount}
                                    {currentQ.pdfRef.point ? ` · 요점: ${currentQ.pdfRef.point}` : ''}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => openPdfSource(currentQ)}
                                        className="text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
                                    >
                                        <FileText className="w-3.5 h-3.5" /> 이 구간 원문 보기
                                    </button>
                                    {(() => {
                                        // 원본 PDF가 보관돼 있으면 그 쪽으로 열기 (§5-77)
                                        const ref = currentQ.pdfRef!;
                                        const d = pdfDocs.find(x => x.id === ref.docId);
                                        if (!d?.file) return null;
                                        const page = d.sections.find(x => x.key === ref.sectionKey)?.pageFrom;
                                        return (
                                            <button
                                                type="button"
                                                onClick={() => openPdfOriginal(d, page).catch(e => alert(e?.message || '원본을 열지 못했습니다.'))}
                                                className="text-[11px] font-bold text-accent-700 bg-white hover:bg-accent-50 border border-accent-200 px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
                                            >
                                                <ExternalLink className="w-3.5 h-3.5" /> 원본 PDF{page ? ` p.${page}` : ''}
                                            </button>
                                        );
                                    })()}
                                </div>
                                {(() => {
                                    // 이 구간 쪽의 그림 (§5-87)
                                    const ref = currentQ.pdfRef!;
                                    const d = pdfDocs.find(x => x.id === ref.docId);
                                    return d ? <PdfImageStrip docId={d.id} images={imagesForSection(d, ref.sectionKey)} label="이 구간 그림" /> : null;
                                })()}
                            </div>
                        )}

                        {currentQ.coverage && (
                            <p className="mt-6 text-[11px] text-slate-400">
                                출제 구역: {currentQ.coverage.partLabel} ({currentQ.coverage.partIndex + 1}/{currentQ.coverage.partCount})
                                {currentQ.coverage.topic ? ` · ${currentQ.coverage.topic}` : ''}
                            </p>
                        )}

                        <div className="mt-8 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-4">
                            {/* 정답·해설이 이상한 문제: 점수·복습 기록 없이 넘김 (§5-82) */}
                            <button
                                type="button"
                                onClick={() => {
                                    const msg = currentQ.pdfRef
                                        ? '이 문제를 기록 없이 넘길까요?\n문제는 지우고, 이 요점은 다음에 새 문제로 다시 나옵니다. (같은 요점에서 두 번 빼면 이번 바퀴에서 건너뜀)'
                                        : currentQ.replayOfNoteId ? '이 문제를 오답 노트에서 빼고 넘길까요?' : '이 문제를 점수·복습 기록 없이 넘길까요?';
                                    if (confirm(msg)) onDiscard();
                                }}
                                className="self-start sm:self-auto text-[11px] font-bold text-slate-400 hover:text-red-500 flex items-center gap-1 shrink-0"
                                title="정답이나 해설이 틀린 문제"
                            >
                                <AlertTriangle className="w-3.5 h-3.5" /> 문제 오류 · 기록 없이 넘기기
                            </button>
                            <button type="button" onClick={handleNext} className="self-end sm:self-auto whitespace-nowrap bg-accent-700 hover:bg-accent-800 text-white px-8 py-4 rounded-xl font-bold shadow-lg active:scale-95 transition-all flex items-center gap-2">
                                {quizState.questionQueue.length === 0 && quizState.noMoreQuestions ? '결과 보기' : '다음 문제'} {quizState.questionQueue.length > 0 && <span className="text-xs bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{quizState.source === 'WRONG' ? `${quizState.questionQueue.length}개 남음` : 'Ready'}</span>} <ArrowRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>

        {/* Floating Action Button for check */}
        {!isRevealed && selectedOption !== null && (
            <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 w-full max-w-md px-6 z-20 animate-in slide-in-from-bottom-10">
                 <button type="button" onClick={handleCheckAnswer} className="w-full bg-accent-600 hover:bg-accent-700 text-white py-4 rounded-2xl font-bold text-lg shadow-xl active:scale-95 transition-all">
                     정답 확인
                 </button>
            </div>
        )}

        {/* Source Notes Modal */}
        {showSourceNotes && (
             <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
                    <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-accent-600" />
                            {labels.source}
                        </h3>
                        <button type="button" onClick={() => setShowSourceNotes(false)} className="text-slate-400 hover:text-slate-600 p-1 hover:bg-slate-100 rounded-full">
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                    <div className="p-6 overflow-y-auto bg-slate-50 space-y-4">
                        {hydratedSourceNotes.length === 0 ? (
                            <div className="flex justify-center py-8">
                                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                            </div>
                        ) : (
                            hydratedSourceNotes.map(note => (
                                <div key={note.id} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                                    <h4 className="font-bold text-lg text-slate-800 mb-3">{note.title}</h4>
                                    {note.images && note.images.length > 0 && (
                                        <div className="flex gap-2 overflow-x-auto mb-3 pb-2 scrollbar-thin scrollbar-thumb-slate-200">
                                            {note.images.map((img, idx) => (
                                                <img 
                                                    key={idx} 
                                                    src={getImageSrc(img)} 
                                                    className="h-24 w-auto rounded-lg border border-slate-200 object-cover cursor-zoom-in hover:opacity-90 transition-opacity" 
                                                    alt="note attachment"
                                                    onClick={() => setViewingImage(img)}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    <div className="prose prose-sm prose-slate max-w-none text-slate-600 bg-slate-50/50 p-3 rounded-lg border border-slate-100">
                                        <div dangerouslySetInnerHTML={renderMarkdown(note.content)} />
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
             </div>
        )}
        
        {/* PDF 구간 원문 (§5-75) */}
        {pdfSourceText && (
             <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={() => setPdfSourceText(null)}>
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
                    <div className="p-4 border-b border-slate-100 flex justify-between items-center gap-3">
                        <h3 className="font-bold text-slate-800 text-sm min-w-0 flex items-start gap-2">
                            <FileText className="w-4 h-4 text-accent-600 shrink-0 mt-0.5" /> <span className="line-clamp-2">{pdfSourceText.label}</span>
                        </h3>
                        <button type="button" onClick={() => setPdfSourceText(null)} className="text-slate-400 hover:text-slate-600 p-1 hover:bg-slate-100 rounded-full shrink-0">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="p-5 overflow-y-auto bg-slate-50">
                        {pdfSourceText.text === null ? (
                            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
                        ) : pdfSourceText.error ? (
                            <p className="text-sm text-red-500">{pdfSourceText.error}</p>
                        ) : (
                            pdfSourceText.md && !pdfSourceText.showRaw
                                ? <div className="prose prose-sm prose-slate max-w-none" lang={hasKana(pdfSourceText.md) ? 'ja' : undefined} dangerouslySetInnerHTML={renderMarkdown(pdfSourceText.md)} />
                                : <p className="text-[13px] text-slate-700 leading-relaxed whitespace-pre-wrap" lang={hasKana(pdfSourceText.text) ? 'ja' : undefined}>{pdfSourceText.text}</p>
                        )}
                        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                            <span>
                                {pdfSourceText.md && !pdfSourceText.showRaw
                                    ? (pdfSourceText.md === pdfSourceText.text
                                        ? 'AI가 이 쪽의 이미지를 보고 옮긴 표·그림 설명입니다. ≈는 그래프에서 읽은 대략값, "주의" 표시는 PDF 글과 숫자가 달라 확인이 필요한 표입니다. 원본 PDF로 확인하세요.'
                                        : '읽기 좋게 정리한 글입니다 (내용·숫자는 원래 글과 같은지 확인한 것만). 문제의 정답 근거는 원래 뽑은 글입니다.')
                                    : 'PDF에서 뽑은 글 그대로입니다 (머리말·쪽 번호 등은 뺌). 표는 줄이 섞여 보일 수 있어요.'}
                            </span>
                            {pdfSourceText.md && pdfSourceText.md !== pdfSourceText.text && (
                                <button type="button" onClick={() => setPdfSourceText(x => (x ? { ...x, showRaw: !x.showRaw } : x))} className="font-bold text-accent-700 hover:text-accent-800">
                                    {pdfSourceText.showRaw ? '정리한 글로 보기' : '원래 뽑은 글로 보기'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
             </div>
        )}

        {/* Full Screen Image Viewer */}
        {viewingImage && (
          <div 
            className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={() => setViewingImage(null)}
          >
             <button 
                type="button"
                onClick={() => setViewingImage(null)}
                className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors z-[110]"
             >
                 <X className="w-8 h-8" />
             </button>
             <img 
                src={getImageSrc(viewingImage)}
                alt="Full screen view"
                className="max-w-full max-h-full object-contain rounded shadow-2xl"
                onClick={(e) => e.stopPropagation()}
             />
          </div>
        )}
    </div>
  );
};

export default QuizView;
