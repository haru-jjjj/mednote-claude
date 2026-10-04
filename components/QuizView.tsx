
import React, { useState, useEffect, useMemo } from 'react';
import { Note, QuizState, QuizQuestion, Source, QuizLanguage } from '../types';
import { BrainCircuit, CheckCircle2, XCircle, ArrowRight, AlertTriangle, BookOpen, RotateCw, ExternalLink, Sparkles, Loader2, Zap, Trophy, Play, ArrowLeft, Layers, Microscope, Languages, FileText, X, Calendar, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { generateDetailedQuizExplanation, formatMedicalMarkdown } from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';
import { sourceKindOf, SOURCE_KIND_LABEL, sourceKindClass } from '../services/sourceKind';
import { collectWrongAnswers, WrongAnswerWithNote, REVIEW_PERIODS, ReviewPeriod, notesInPeriod, periodInfo } from '../services/studyUtils';

const PERIOD_KEY = 'medinote_quiz_period';
const readPeriod = (): ReviewPeriod => {
  try { const v = localStorage.getItem(PERIOD_KEY); return REVIEW_PERIODS.some(p => p.key === v) ? (v as ReviewPeriod) : '1w'; } catch { return '1w'; }
};

interface QuizViewProps {
  notes: Note[];
  quizState: QuizState;
  onStart: (mode: 'DETAILED' | 'QUICK_OX', language: QuizLanguage, source?: 'RANDOM' | 'REVIEW' | 'PERIOD', period?: ReviewPeriod) => void;
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
}

const WRONG_LIST_PAGE = 10;

const QuizView: React.FC<QuizViewProps> = ({ notes, quizState, onStart, onNext, onStop, onEndSession, onRetry, onBack, reviewDueCount, onStartWrongReview, onDeleteWrongAnswer, onOpenNote, isFetchingAll }) => {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  
  // Language Selection State
  const [selectedLanguage, setSelectedLanguage] = useState<QuizLanguage>('Korean');
  // 기간별 복습: 고른 기간(마지막 선택 기억)과 기간별 메모 수
  const [period, setPeriodState] = useState<ReviewPeriod>(readPeriod);
  const setPeriod = (p: ReviewPeriod) => { setPeriodState(p); try { localStorage.setItem(PERIOD_KEY, p); } catch { /* 저장 안 돼도 이번 화면에선 동작 */ } };
  const periodCounts = useMemo(() => {
      const now = Date.now();
      const out = {} as Record<ReviewPeriod, number>;
      REVIEW_PERIODS.forEach(p => { out[p.key] = notesInPeriod(notes, p.key, now).length; });
      return out;
  }, [notes]);

  // States for Deep Dive (Detailed Explanation)
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [enhancedExplanation, setEnhancedExplanation] = useState<{text: string, sources: Source[]} | null>(null);

  // State for Viewing Source Notes
  const [showSourceNotes, setShowSourceNotes] = useState(false);
  const [hydratedSourceNotes, setHydratedSourceNotes] = useState<Note[]>([]);
  
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
                          <p className="text-slate-500 mb-6 text-base">시간에 맞춰 문제 방식을 고르세요.</p>
                          
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
                                       {lang === 'Korean' ? '한국어' : lang === 'English' ? 'English' : '日本語'}
                                   </button>
                               ))}
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
                                              onClick={() => onStart('DETAILED', selectedLanguage, 'REVIEW')}
                                              className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5"
                                          >
                                              <BookOpen className="w-4 h-4" /> 케이스 문제로 복습
                                          </button>
                                          <button
                                              type="button"
                                              onClick={() => onStart('QUICK_OX', selectedLanguage, 'REVIEW')}
                                              className="px-4 py-2 rounded-xl bg-white border border-accent-300 text-accent-700 text-sm font-bold hover:bg-accent-100 transition-colors flex items-center gap-1.5"
                                          >
                                              <Zap className="w-4 h-4" /> OX로 빠르게
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
                                      고른 기간에 쓰거나 고친 메모(질문 노트 포함)로만 냅니다. 한 바퀴 다 돌면 다시 처음부터.
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
                                      {periodCounts[period] > 0
                                          ? `${periodInfo(period).long} 메모 ${periodCounts[period]}개`
                                          : `${periodInfo(period).long} 동안 쓰거나 고친 메모가 없어요.`}
                                      {isFetchingAll && ' (예전 메모 불러오는 중…)'}
                                  </p>
                                  <div className="flex flex-wrap gap-2 mt-3">
                                      <button
                                          type="button"
                                          onClick={() => onStart('DETAILED', selectedLanguage, 'PERIOD', period)}
                                          disabled={periodCounts[period] === 0}
                                          className="px-4 py-2 rounded-xl bg-accent-700 text-white text-sm font-bold hover:bg-accent-800 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                          <BookOpen className="w-4 h-4" /> 케이스 문제로
                                      </button>
                                      <button
                                          type="button"
                                          onClick={() => onStart('QUICK_OX', selectedLanguage, 'PERIOD', period)}
                                          disabled={periodCounts[period] === 0}
                                          className="px-4 py-2 rounded-xl bg-white border border-accent-300 text-accent-700 text-sm font-bold hover:bg-accent-100 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                          <Zap className="w-4 h-4" /> OX로 빠르게
                                      </button>
                                  </div>
                              </div>
                          </div>
                      </div>

                      <p className="text-xs font-bold text-slate-400 mb-3 px-1">
                          무작위 퀴즈 — 복습일이 된 메모와 아직 안 푼 메모가 더 자주 나옵니다
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                          {/* Detailed Mode Card */}
                          <button 
                              type="button"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStart('DETAILED', selectedLanguage); }}
                              disabled={notes.length === 0}
                              className="bg-white p-6 md:p-8 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-accent-300 hover:-translate-y-1 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                              <div className="w-10 h-10 rounded-xl bg-accent-50 text-accent-600 flex items-center justify-center mb-4 group-hover:bg-accent-600 group-hover:text-white transition-colors">
                                  <BookOpen className="w-5 h-5" />
                              </div>
                              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-2">케이스 문제</h3>
                              <p className="text-slate-500 text-sm leading-relaxed mb-4">
                                  임상 상황을 주고 판단을 묻는 5지선다. 해설과 근거 자료가 함께 나옵니다.
                              </p>
                              <div className="flex items-center text-accent-600 font-bold text-sm md:text-base">
                                  시작 <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                              </div>
                          </button>
     
                          {/* Quick OX Mode Card */}
                          <button 
                              type="button"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStart('QUICK_OX', selectedLanguage); }}
                              disabled={notes.length === 0}
                              className="bg-white p-6 md:p-8 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-accent-300 hover:-translate-y-1 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                              <div className="w-10 h-10 rounded-xl bg-accent-50 text-accent-600 flex items-center justify-center mb-4 group-hover:bg-accent-600 group-hover:text-white transition-colors">
                                  <Zap className="w-5 h-5" />
                              </div>
                              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-2">OX 빠른 복습</h3>
                              <p className="text-slate-500 text-sm leading-relaxed mb-4">
                                  짧은 참/거짓 문제를 연달아 풉니다. 틈날 때 가볍게 훑기 좋습니다.
                              </p>
                              <div className="flex items-center text-accent-600 font-bold text-sm md:text-base">
                                  시작 <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                              </div>
                          </button>
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
                                          <div key={w.id} className="border border-slate-200 rounded-xl overflow-hidden">
                                              <button
                                                  type="button"
                                                  onClick={() => setExpandedWrongId(isOpen ? null : w.id)}
                                                  className="w-full text-left p-3 hover:bg-slate-50 transition-colors flex items-start gap-2"
                                              >
                                                  <span className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${w.type === 'OX' ? 'bg-accent-100 text-accent-700' : 'bg-accent-100 text-accent-700'}`}>
                                                      {w.type === 'OX' ? 'OX' : '케이스'}
                                                  </span>
                                                  <span className={`flex-1 min-w-0 text-sm text-slate-700 ${isOpen ? '' : 'line-clamp-2'}`}>
                                                      {w.question.replace(/[#*`>]/g, '')}
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
                                                                      <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(formatMedicalMarkdown(o)) }} />
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
  if (!quizState.currentQuestion && quizState.noMoreQuestions && !quizState.isGenerating && !quizState.error) {
      const { correct, total } = quizState.stats;
      const title = quizState.source === 'WRONG'
          ? '오답 다시 풀기 완료'
          : quizState.source === 'PERIOD'
              ? (total === 0 ? `${periodInfo(quizState.period).long} 동안 쓰거나 고친 메모가 없어요` : `${periodInfo(quizState.period).long} 복습 — 더 낼 메모가 없어요`)
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
                      : quizState.source === 'PERIOD' && total === 0
                      ? '기간을 더 길게 골라 보세요.'
                      : '틀린 문제는 오답 노트에 저장됐고, 해당 메모는 내일 다시 복습 목록에 나옵니다.'}
              </p>
              <div className="flex flex-col gap-3 w-full max-w-xs">
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
                  {quizState.error ? '문제가 발생했습니다' : (quizState.mode === 'QUICK_OX' ? 'OX 문제 만드는 중...' : '케이스 문제 만드는 중...')}
              </h2>
              <p className="text-slate-400 text-sm mb-8">
                  {quizState.error ? quizState.error : 'AI가 메모를 분석하여 문제를 만들고 있습니다.\n잠시만 기다려주세요.'}
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
    <div className="h-full flex flex-col bg-slate-50 overflow-hidden relative">
        {/* Header */}
        <div className="h-12 px-4 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 z-10 shadow-sm">
            <div className="flex items-center gap-3">
                <button type="button" onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors" title="목록으로 (퀴즈 유지)">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className={`p-2 rounded-lg ${isOX ? 'bg-accent-50 text-accent-600' : 'bg-accent-50 text-accent-600'}`}>
                    {isOX ? <Zap className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
                </div>
                <div>
                    <h2 className="font-bold text-slate-800 text-base md:text-lg">
                        {quizState.source === 'REVIEW' ? '오늘의 복습' : quizState.source === 'WRONG' ? '오답 다시 풀기' : quizState.source === 'PERIOD' ? `기간 복습 · ${periodInfo(quizState.period).long}` : (isOX ? 'OX 빠른 복습' : '케이스 문제')}
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
                        {isOX ? '참 / 거짓' : '케이스'}
                    </span>
                    {/* Render Question with Medical Formatting */}
                    <h3 className={`${isOX ? 'text-xl md:text-2xl text-center py-6' : 'text-lg md:text-xl text-center'} font-bold text-slate-900 leading-relaxed`} dangerouslySetInnerHTML={renderMarkdown(currentQ.question)}>
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
                                        <span className="text-base" dangerouslySetInnerHTML={{__html: DOMPurify.sanitize(formatMedicalMarkdown(option))}}></span>
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

                        {currentQ.coverage && (
                            <p className="mt-6 text-[11px] text-slate-400">
                                출제 구역: {currentQ.coverage.partLabel} ({currentQ.coverage.partIndex + 1}/{currentQ.coverage.partCount})
                                {currentQ.coverage.topic ? ` · ${currentQ.coverage.topic}` : ''}
                            </p>
                        )}

                        <div className="mt-8 flex justify-end">
                            <button type="button" onClick={handleNext} className="bg-accent-700 hover:bg-accent-800 text-white px-8 py-4 rounded-xl font-bold shadow-lg active:scale-95 transition-all flex items-center gap-2">
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
