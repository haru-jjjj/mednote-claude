
import React, { useState, useEffect } from 'react';
import { Note, QuizState, QuizQuestion, Source, QuizLanguage } from '../types';
import { BrainCircuit, CheckCircle2, XCircle, ArrowRight, AlertTriangle, BookOpen, RotateCw, ExternalLink, Sparkles, Loader2, Zap, Trophy, Play, ArrowLeft, Layers, Microscope, Languages, FileText, X } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { generateDetailedQuizExplanation, formatMedicalMarkdown } from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';

interface QuizViewProps {
  notes: Note[];
  quizState: QuizState;
  onStart: (mode: 'DETAILED' | 'QUICK_OX', language: QuizLanguage) => void;
  onNext: (wasCorrect: boolean) => void;
  onStop: () => void;
  onBack: () => void;
}

const QuizView: React.FC<QuizViewProps> = ({ notes, quizState, onStart, onNext, onStop, onBack }) => {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  
  // Language Selection State
  const [selectedLanguage, setSelectedLanguage] = useState<QuizLanguage>('Korean');

  // States for Deep Dive (Detailed Explanation)
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [enhancedExplanation, setEnhancedExplanation] = useState<{text: string, sources: Source[]} | null>(null);

  // State for Viewing Source Notes
  const [showSourceNotes, setShowSourceNotes] = useState(false);
  const [hydratedSourceNotes, setHydratedSourceNotes] = useState<Note[]>([]);
  
  // State for Full Screen Image Viewing
  const [viewingImage, setViewingImage] = useState<string | null>(null);

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
      onNext(isCorrect);
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
          formatted = formatted.replace(/([^\n])\n([^\n#\-])/g, '$1\n\n$2');
          // Apply medical formatting
          formatted = formatMedicalMarkdown(formatted);
          const html = marked.parse(formatted, { breaks: true, gfm: true }) as string;
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
                              <BrainCircuit className="w-8 h-8 text-blue-600" />
                          </div>
                          <h2 className="text-2xl font-bold text-slate-900 mb-3">AI Medical Quiz</h2>
                          <p className="text-slate-500 mb-6 text-base">Choose your study mode based on your available time.</p>
                          
                          {/* Language Selection */}
                          <div className="inline-flex flex-wrap justify-center items-center bg-white border border-slate-200 rounded-xl p-1 shadow-sm gap-1">
                               {(['Korean', 'English', 'Japanese'] as QuizLanguage[]).map((lang) => (
                                   <button
                                      type="button"
                                      key={lang}
                                      onClick={() => setSelectedLanguage(lang)}
                                      className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2
                                        ${selectedLanguage === lang
                                            ? 'bg-slate-900 text-white shadow-sm'
                                            : 'text-slate-500 hover:bg-slate-100'}`}
                                   >
                                       <Languages className="w-3.5 h-3.5 shrink-0" />
                                       {lang === 'Korean' ? '한국어' : lang === 'English' ? 'English' : '日本語'}
                                   </button>
                               ))}
                          </div>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                          {/* Detailed Mode Card */}
                          <button 
                              type="button"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStart('DETAILED', selectedLanguage); }}
                              disabled={notes.length === 0}
                              className="bg-white p-6 md:p-8 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-blue-300 hover:-translate-y-1 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                  <BookOpen className="w-5 h-5" />
                              </div>
                              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-2">Detailed Case Study</h3>
                              <p className="text-slate-500 text-sm leading-relaxed mb-4">
                                  Deep dive into clinical vignettes with comprehensive explanations and reference sources. Best for deep learning.
                              </p>
                              <div className="flex items-center text-blue-600 font-bold text-sm md:text-base">
                                  Start Review <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                              </div>
                          </button>
     
                          {/* Quick OX Mode Card */}
                          <button 
                              type="button"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStart('QUICK_OX', selectedLanguage); }}
                              disabled={notes.length === 0}
                              className="bg-white p-6 md:p-8 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-amber-300 hover:-translate-y-1 transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                                  <Zap className="w-5 h-5" />
                              </div>
                              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-2">Quick OX Review</h3>
                              <p className="text-slate-500 text-sm leading-relaxed mb-4">
                                  Fast-paced True/False questions generated instantly in the background. Perfect for quick refreshes.
                              </p>
                              <div className="flex items-center text-amber-600 font-bold text-sm md:text-base">
                                  Start Blitz <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                              </div>
                          </button>
                      </div>
                      
                      {notes.length === 0 && (
                          <div className="mt-8 p-4 bg-red-50 text-red-600 text-center rounded-xl text-sm font-medium">
                              You need to add some notes before starting the quiz.
                          </div>
                      )}
                  </div>
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
                  <div className="w-20 h-20 border-4 border-blue-600 rounded-full border-t-transparent animate-spin absolute top-0 left-0"></div>
                  <div className="absolute inset-0 flex items-center justify-center">
                      <Sparkles className="w-6 h-6 text-blue-600" />
                  </div>
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-2">
                  {quizState.error ? '문제가 발생했습니다' : (quizState.mode === 'QUICK_OX' ? 'Quick Review 생성 중...' : 'Case Study 분석 중...')}
              </h2>
              <p className="text-slate-400 text-sm mb-8">
                  {quizState.error ? quizState.error : 'AI가 메모를 분석하여 문제를 만들고 있습니다.\n잠시만 기다려주세요.'}
              </p>
              
              <div className="flex flex-col gap-3 w-full max-w-xs">
                  {quizState.error ? (
                    <button 
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStart(quizState.mode!, quizState.language); }} 
                        className="w-full bg-blue-600 text-white hover:bg-blue-700 py-3 rounded-xl font-bold shadow-sm transition-all flex items-center justify-center gap-2"
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
                <div className={`p-2 rounded-lg ${isOX ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                    {isOX ? <Zap className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
                </div>
                <div>
                    <h2 className="font-bold text-slate-800 text-base md:text-lg">
                        {isOX ? 'Quick Review' : 'Case Study'}
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
                        ${isOX ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>
                        {isOX ? 'True or False' : 'Clinical Vignette'}
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
                                    if (isCorrect) btnClass += " bg-green-500 border-green-500 text-white opacity-100";
                                    else if (isSelected) btnClass += " bg-red-500 border-red-500 text-white opacity-100";
                                    else btnClass += " bg-slate-50 border-slate-200 text-slate-300 opacity-50";
                                } else {
                                    if (opt === 'O') btnClass += isSelected ? " border-blue-500 bg-blue-500 text-white" : " border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-blue-500";
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
                                let statusClass = "border-slate-200 hover:border-blue-400 hover:bg-blue-50 text-slate-700";
                                const isSelected = selectedOption === idx;
                                const isCorrect = currentQ.correctAnswerIndex === idx;
                                if (isRevealed) {
                                    if (isCorrect) statusClass = "border-green-500 bg-green-50 text-green-900 ring-1 ring-green-500 font-bold";
                                    else if (isSelected && !isCorrect) statusClass = "border-red-500 bg-red-50 text-red-900 ring-1 ring-red-500";
                                    else statusClass = "border-slate-100 text-slate-400 opacity-60";
                                } else if (isSelected) statusClass = "border-blue-600 bg-blue-50 ring-1 ring-blue-600 text-blue-900 font-medium";

                                return (
                                    <button type="button" key={idx} onClick={() => handleOptionClick(idx)} disabled={isRevealed} className={`w-full text-left p-4 rounded-lg border transition-all flex items-start gap-3 ${statusClass}`}>
                                        <div className={`w-6 h-6 rounded-full border flex-shrink-0 flex items-center justify-center text-[11px] font-bold ${isRevealed && isCorrect ? 'border-green-600 bg-green-600 text-white' : isRevealed && isSelected && !isCorrect ? 'border-red-500 bg-red-500 text-white' : isSelected ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 text-slate-400'}`}>
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
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white ${selectedOption === currentQ.correctAnswerIndex ? 'bg-green-500' : 'bg-red-500'}`}>
                                    {selectedOption === currentQ.correctAnswerIndex ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                                </div>
                                <span>{selectedOption === currentQ.correctAnswerIndex ? 'Correct!' : 'Incorrect'}</span>
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
                                        className="whitespace-nowrap text-[11px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-3 py-2 rounded-full flex items-center gap-1.5 transition-all disabled:opacity-50 shadow-sm"
                                    >
                                        {isDetailLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Microscope className="w-3.5 h-3.5" />}
                                        {isDetailLoading ? "Generating..." : "AI Deep Dive"}
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
                                    <BookOpen className="w-3.5 h-3.5" /> References
                                </h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {(enhancedExplanation ? enhancedExplanation.sources : currentQ.sources)?.map((src, i) => (
                                        <a 
                                            key={i} 
                                            href={src.uri} 
                                            target="_blank" 
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 hover:border-blue-300 hover:shadow-sm transition-all group"
                                        >
                                            <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors shrink-0">
                                                <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-blue-600" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-xs font-bold text-slate-700 truncate group-hover:text-blue-700">
                                                    {src.title || "Reference Source"}
                                                </div>
                                                <div className="text-[10px] text-slate-400 truncate">
                                                    {src.uri}
                                                </div>
                                            </div>
                                        </a>
                                    ))}
                                </div>
                             </div>
                        ) : null}

                        <div className="mt-8 flex justify-end">
                            <button type="button" onClick={handleNext} className="bg-slate-900 hover:bg-black text-white px-8 py-4 rounded-xl font-bold shadow-lg active:scale-95 transition-all flex items-center gap-2">
                                Next Question {quizState.questionQueue.length > 0 && <span className="text-xs bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">Ready</span>} <ArrowRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>

        {/* Floating Action Button for check */}
        {!isRevealed && selectedOption !== null && (
            <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 w-full max-w-md px-6 z-20 animate-in slide-in-from-bottom-10">
                 <button type="button" onClick={handleCheckAnswer} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold text-lg shadow-xl shadow-blue-200 active:scale-95 transition-all">
                     Check Answer
                 </button>
            </div>
        )}

        {/* Source Notes Modal */}
        {showSourceNotes && (
             <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
                    <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-blue-600" />
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
