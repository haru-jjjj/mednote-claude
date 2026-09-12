
import React, { useState, useEffect, useRef } from 'react';
import { Note, Source, QuizLanguage } from '../types';
import { generateStudySuggestions, generateStudyGuideContent, formatMedicalMarkdown } from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';
import { fetchRandomNotesBatch } from '../services/firebaseService';
import { cosineSimilarity } from '../services/voyageService';
import { Lightbulb, Loader2, ArrowRight, BookOpen, ExternalLink, Sparkles, Microscope, ArrowLeft, RefreshCw, Layers, Languages, Book, Zap } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface StudyGuideViewProps {
  notes: Note[];
  onBack: () => void;
}

// Fisher-Yates Shuffle for true randomness
function shuffleArray<T>(array: T[]): T[] {
    const newArr = [...array];
    for (let i = newArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
    }
    return newArr;
}

const StudyGuideView: React.FC<StudyGuideViewProps> = ({ notes, onBack }) => {
  const [hasStarted, setHasStarted] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<QuizLanguage>('Korean');

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [contextNotes, setContextNotes] = useState<Note[]>([]);
  
  // Track notes relevant to the SELECTED topic
  const [activeContextNotes, setActiveContextNotes] = useState<Note[]>([]);
  
  // History tracking to enforce randomness
  const [usedNoteIds, setUsedNoteIds] = useState<Set<string>>(new Set());

  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const activeTopicRef = useRef<string | null>(null);

  const [content, setContent] = useState<{ text: string, sources: Source[] } | null>(null);
  const [isGeneratingContent, setIsGeneratingContent] = useState(false);
  const [contentMode, setContentMode] = useState<'fast' | 'detailed'>('fast');

  // Deep Dive Background State
  const [isDeepDiveGenerating, setIsDeepDiveGenerating] = useState(false);
  const [deepDiveResult, setDeepDiveResult] = useState<{ text: string, sources: Source[] } | null>(null);

  // Embedding-based clustering: if enough locally-loaded notes already have a
  // Voyage embedding (see voyageService.ts), pick a random "seed" note and pair
  // it with its most semantically similar notes. This reuses embeddings that
  // were already computed for search (no extra API calls) and produces a more
  // thematically coherent trio than pure random picking, which is what makes
  // the resulting AI topic suggestions more relevant. Falls back to an empty
  // result (→ pure random selection) whenever there isn't a strong-enough
  // cluster, so variety/randomness is preserved when embeddings are sparse.
  const SEMANTIC_CLUSTER_THRESHOLD = 0.45;
  const pickSemanticCluster = (excludeList: string[]): Note[] => {
      const embedded = notes.filter(n => n.embedding && n.embedding.length > 0 && !excludeList.includes(n.id));
      if (embedded.length < 4) return [];

      const seed = embedded[Math.floor(Math.random() * embedded.length)];
      const ranked = embedded
          .filter(n => n.id !== seed.id)
          .map(n => ({ note: n, sim: cosineSimilarity(seed.embedding, n.embedding) }))
          .sort((a, b) => b.sim - a.sim)
          .filter(r => r.sim >= SEMANTIC_CLUSTER_THRESHOLD)
          .slice(0, 2);

      if (ranked.length < 2) return [];
      return [seed, ...ranked.map(r => r.note)];
  };

  const pickRandomNotes = async () => {
      setIsGeneratingSuggestions(true);
      setSuggestions([]);
      setContent(null);
      setSelectedTopic(null);
      activeTopicRef.current = null;
      setContentMode('fast');
      setDeepDiveResult(null);
      setIsDeepDiveGenerating(false);

      try {
          const excludeList = Array.from(usedNoteIds) as string[];
          let selected: Note[] = pickSemanticCluster(excludeList);

          if (selected.length === 0) {
              selected = await fetchRandomNotesBatch(3, excludeList, notes);
          }

          if (selected.length === 0 && notes.length > 0) {
              const availableLocal = notes.filter(n => !usedNoteIds.has(n.id));
              const candidates = availableLocal.length > 0 ? availableLocal : notes;
              const shuffled: Note[] = shuffleArray(candidates);
              selected = shuffled.slice(0, 3);
          }

          if (selected.length === 0) {
              alert("분석할 메모를 찾을 수 없습니다.");
              setIsGeneratingSuggestions(false);
              return;
          }
          
          setUsedNoteIds(prev => {
              const next = new Set(prev);
              selected.forEach(n => next.add(n.id));
              return next;
          });
          
          const hydratedNotes: Note[] = [];
          for (const n of selected) {
              try {
                  const full = await getNoteFromDB(n.id);
                  hydratedNotes.push(full || n);
              } catch {
                  hydratedNotes.push(n);
              }
          }
          
          setContextNotes(hydratedNotes);

          const results = await generateStudySuggestions(hydratedNotes, selectedLanguage);
          setSuggestions(results);
      } catch (e) {
          console.error("Study Guide Init Failed", e);
          alert("주제 생성에 실패했습니다.");
      } finally {
          setIsGeneratingSuggestions(false);
      }
  };

  const handleStart = () => {
      setHasStarted(true);
      pickRandomNotes();
  };

  const handleSelectTopic = async (topic: string) => {
      setSelectedTopic(topic);
      activeTopicRef.current = topic; 
      
      setContent(null);
      setIsGeneratingContent(true);
      setContentMode('fast');
      setDeepDiveResult(null); 
      setIsDeepDiveGenerating(false); 

      try {
          // STRICT CONSISTENCY FIX:
          // Do not search for new notes based on the topic string keywords.
          // Instead, explicitly use the `contextNotes` that were used to generate this topic suggestion.
          // This prevents the AI from getting confused by unrelated notes that happen to match keywords.
          const relevantContext = contextNotes;

          const fullRelevantNotes: Note[] = [];
          for (const n of relevantContext) {
               const full = await getNoteFromDB(n.id);
               fullRelevantNotes.push(full || n);
          }
          
          setActiveContextNotes(fullRelevantNotes);

          const result = await generateStudyGuideContent(topic, fullRelevantNotes, 'fast', selectedLanguage);
          
          if (activeTopicRef.current === topic && result) {
              setContent({ text: result.content, sources: result.sources });
          }
      } catch (e) {
          console.error("Content Gen Failed", e);
      } finally {
          if (activeTopicRef.current === topic) {
              setIsGeneratingContent(false);
          }
      }
  };

  const handleDeepDiveBackground = async () => {
      if (!selectedTopic) return;
      
      const currentTopic = selectedTopic;
      setIsDeepDiveGenerating(true);

      // 60s Timeout (Should be enough for optimized Flash/Pro call)
      const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout")), 60000)
      );

      try {
          // Pass 'detailed' mode
          const resultPromise = generateStudyGuideContent(currentTopic, activeContextNotes, 'detailed', selectedLanguage);
          
          const result = await Promise.race([resultPromise, timeoutPromise]) as { content: string; sources: Source[] } | null;
          
          if (activeTopicRef.current === currentTopic && result) {
              setDeepDiveResult({ text: result.content, sources: result.sources });
          } else if (activeTopicRef.current === currentTopic && !result) {
              throw new Error("Generation returned null");
          }
      } catch (e) {
          console.error("Deep Dive Failed", e);
          if (activeTopicRef.current === currentTopic) {
              setDeepDiveResult(null); 
              alert("심층 분석 생성에 실패했거나 시간이 초과되었습니다.");
          }
      } finally {
          if (activeTopicRef.current === currentTopic) {
              setIsDeepDiveGenerating(false);
          }
      }
  };

  const handleViewDeepDive = () => {
      if (deepDiveResult) {
          setContent(deepDiveResult);
          setContentMode('detailed');
      }
  };

  const renderMarkdown = (text: string) => {
      try {
          if (!text) return { __html: '' };
          let formatted = text.replace(/###/g, '\n\n###');
          formatted = formatMedicalMarkdown(formatted);
          const html = marked.parse(formatted, { breaks: true, gfm: true }) as string;
          return { __html: DOMPurify.sanitize(html) };
      } catch (e) { return { __html: text }; }
  };

  if (!hasStarted) {
      return (
          <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 animate-in fade-in">
              <div className="w-full max-w-lg mx-auto text-center">
                  <div className="inline-flex items-center justify-center w-20 h-20 bg-white rounded-3xl shadow-sm border border-slate-200 mb-6">
                      <Lightbulb className="w-10 h-10 text-amber-500" />
                  </div>
                  <h2 className="text-3xl font-bold text-slate-900 mb-3">AI Study Guide</h2>
                  <p className="text-slate-500 mb-8">
                      랜덤한 메모를 연결하여 새로운 학습 주제를 발견하세요.
                  </p>

                  <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm mb-6">
                      <label className="block text-xs font-bold text-slate-400 uppercase mb-3 tracking-wider">Select Language</label>
                      <div className="flex justify-center gap-2">
                          {(['Korean', 'English', 'Japanese'] as QuizLanguage[]).map((lang) => (
                               <button
                                  key={lang}
                                  onClick={() => setSelectedLanguage(lang)}
                                  className={`px-4 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2
                                    ${selectedLanguage === lang 
                                        ? 'bg-slate-900 text-white shadow-md' 
                                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                               >
                                   <Languages className="w-3.5 h-3.5" />
                                   {lang === 'Korean' ? '한국어' : lang === 'English' ? 'English' : '日本語'}
                               </button>
                           ))}
                      </div>
                  </div>

                  <button 
                      onClick={handleStart}
                      disabled={notes.length === 0}
                      className="w-full bg-amber-500 hover:bg-amber-600 text-white py-4 rounded-2xl font-bold text-lg shadow-lg shadow-amber-200 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                      <Sparkles className="w-5 h-5" /> Start Exploring
                  </button>
                  
                  {notes.length === 0 && (
                      <p className="mt-4 text-xs text-red-500 font-medium">
                          * 메모가 없어 시작할 수 없습니다.
                      </p>
                  )}
              </div>
          </div>
      );
  }

  if (isGeneratingSuggestions) {
      return (
          <div className="flex flex-col items-center justify-center h-full bg-slate-50 p-6 animate-in fade-in">
              <div className="text-center">
                  <div className="relative inline-block mb-6">
                      <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center animate-pulse">
                          <Lightbulb className="w-8 h-8 text-amber-500" />
                      </div>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800 mb-2">메모 연결 분석 중...</h2>
                  <p className="text-slate-500 text-sm">랜덤한 메모들을 조합하여<br/>새로운 학습 주제를 찾고 있습니다.</p>
              </div>
          </div>
      );
  }

  return (
    <div className="h-full flex flex-col bg-slate-50 relative overflow-hidden">
        <div className="h-16 px-4 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 z-10 shadow-sm">
            <div className="flex items-center gap-3">
                <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors" title="메인으로">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-amber-100 rounded-lg">
                        <Lightbulb className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                        <h2 className="font-bold text-slate-800 text-sm md:text-base">AI 주제 탐구</h2>
                    </div>
                </div>
            </div>
            <button 
                onClick={pickRandomNotes} 
                className="text-xs font-bold text-slate-500 hover:text-blue-600 hover:bg-blue-50 px-3 py-2 rounded-lg transition-all flex items-center gap-1.5"
            >
                <RefreshCw className="w-3.5 h-3.5" />
                다른 주제 찾기
            </button>
        </div>

        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-4 md:p-8 pb-32">
                <div className="mb-8 p-4 bg-slate-100/50 rounded-xl border border-slate-200">
                    <p className="text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5" /> 
                        {selectedTopic ? 'Selected Topic Context' : 'Analyzed Context'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {(selectedTopic && activeContextNotes.length > 0 ? activeContextNotes : contextNotes).map(n => (
                            <span key={n.id} className="text-xs bg-white px-2 py-1 rounded border border-slate-200 text-slate-600 shadow-sm flex items-center gap-1">
                                <BookOpen className="w-3 h-3 text-slate-400" /> {n.title}
                            </span>
                        ))}
                        {selectedTopic && activeContextNotes.length === 0 && (
                             <span className="text-xs text-slate-400 italic">연결된 메모를 찾지 못해 AI 지식과 웹 검색만으로 답변을 생성합니다.</span>
                        )}
                    </div>
                </div>

                {!selectedTopic ? (
                    <div className="space-y-4 animate-in slide-in-from-bottom-4 duration-500">
                        <h3 className="text-2xl font-bold text-slate-800 mb-6 text-center">어떤 주제를 더 깊게 알아볼까요?</h3>
                        {suggestions.map((topic, idx) => (
                            <button
                                key={idx}
                                onClick={() => handleSelectTopic(topic)}
                                className="w-full text-left p-6 bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-amber-300 transition-all group relative overflow-hidden"
                            >
                                <div className="absolute top-0 left-0 w-1 h-full bg-amber-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                                <div className="flex justify-between items-start gap-4">
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-0.5 rounded-full">Suggestion #{idx + 1}</span>
                                        </div>
                                        <h4 className="text-lg font-bold text-slate-800 group-hover:text-amber-700 transition-colors leading-relaxed">
                                            {topic}
                                        </h4>
                                    </div>
                                    <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-amber-500 group-hover:text-white transition-all">
                                        <ArrowRight className="w-4 h-4" />
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="animate-in fade-in duration-300">
                        <div className="mb-6">
                            <button onClick={() => { setSelectedTopic(null); activeTopicRef.current = null; setContent(null); }} className="text-xs font-bold text-slate-400 hover:text-slate-600 mb-2 flex items-center gap-1">
                                <ArrowLeft className="w-3 h-3" /> 목록으로
                            </button>
                            <h3 className="text-2xl font-bold text-slate-900 leading-tight">
                                {selectedTopic}
                            </h3>
                        </div>

                        {isGeneratingContent ? (
                             <div className="py-12 flex flex-col items-center justify-center space-y-4">
                                 <Loader2 className={`w-8 h-8 animate-spin ${contentMode === 'detailed' ? 'text-indigo-600' : 'text-amber-500'}`} />
                                 <p className="text-sm font-medium text-slate-500">
                                     {contentMode === 'detailed' ? '심층 분석 및 출처 확인 중...' : '핵심 내용 및 출처 검색 중...'}
                                 </p>
                             </div>
                        ) : content ? (
                            <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden relative">
                                <div className="p-6 md:p-8">
                                    <div className="prose prose-slate max-w-none mb-8">
                                        <div dangerouslySetInnerHTML={renderMarkdown(content.text)} />
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-4 items-center justify-between pt-6 border-t border-slate-100">
                                        <div className="flex flex-wrap gap-2">
                                            {content.sources && content.sources.length > 0 ? (
                                                content.sources.map((src, i) => (
                                                    <a key={i} href={src.uri} target="_blank" rel="noopener noreferrer" className="text-[10px] bg-slate-50 px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-colors flex items-center gap-1">
                                                        <ExternalLink className="w-3 h-3" /> {src.title}
                                                    </a>
                                                ))
                                            ) : (
                                                <span className="text-[10px] text-slate-300 italic">No direct sources found</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                {contentMode === 'fast' && (
                                    <div className="bg-amber-50/50 p-3 text-center text-xs text-amber-600 font-medium border-t border-amber-100">
                                        ⚡ 빠른 요약입니다. 더 깊은 내용과 추가 자료는 Deep Dive를 확인하세요.
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </div>

        {/* Floating Deep Dive Action Button */}
        {selectedTopic && content && contentMode === 'fast' && (
            <div className="absolute bottom-8 left-0 right-0 z-20 flex justify-center pointer-events-none px-4">
                <div className="pointer-events-auto max-w-full shadow-2xl rounded-full overflow-hidden animate-in slide-in-from-bottom-10 border border-indigo-100 ring-4 ring-white/50">
                    {!deepDiveResult && !isDeepDiveGenerating ? (
                        <button
                            onClick={handleDeepDiveBackground}
                            className="px-4 sm:px-8 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center gap-2 sm:gap-2.5 transition-all active:scale-95 shadow-inner whitespace-nowrap text-sm sm:text-base"
                        >
                            <Microscope className="w-5 h-5 shrink-0" />
                            <span>Deep Dive (심층 분석)</span>
                        </button>
                    ) : isDeepDiveGenerating ? (
                        <button
                            disabled
                            className="px-4 sm:px-8 py-3.5 bg-white text-slate-500 font-bold flex items-center gap-2 sm:gap-2.5 cursor-not-allowed border-t border-slate-100 whitespace-nowrap text-sm sm:text-base"
                        >
                            <Loader2 className="w-5 h-5 shrink-0 animate-spin text-indigo-600" />
                            <span>분석 진행 중...</span>
                        </button>
                    ) : (
                        <button
                            onClick={handleViewDeepDive}
                            className="px-4 sm:px-8 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center gap-2 sm:gap-2.5 transition-all shadow-lg shadow-indigo-200 animate-pulse whitespace-nowrap text-sm sm:text-base"
                        >
                            <Zap className="w-5 h-5 shrink-0 fill-current" />
                            <span>심층 분석 결과 보기</span>
                        </button>
                    )}
                </div>
            </div>
        )}
    </div>
  );
};

export default StudyGuideView;
