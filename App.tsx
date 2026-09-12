
import React, { useState, useEffect, useRef } from 'react';
import { Plus, LayoutGrid, Network, Menu, X, Cloud, Shuffle, Clock, BrainCircuit, Loader2, Upload, Download, Lightbulb } from 'lucide-react';
import NoteEditor from './components/NoteEditor';
import NoteList from './components/NoteList';
import NoteDetail from './components/NoteDetail';
import QuizView from './components/QuizView';
import StudyGuideView from './components/StudyGuideView';
import { Note, ViewMode, QuizState, QuizQuestion, QuizLanguage } from './types';
import { getAllNotesFromDB, saveNoteToDB, deleteNoteFromDB, saveAllNotesToDB, getNoteFromDB, getRecentNotesFromDB } from './services/storage';
import { generateMedicalQuiz, generateOXQuiz, extractTextFromImages } from './services/claudeService';
import { syncNotesFromFirestore, saveNoteToFirestore, deleteNoteFromFirestore, fetchOlderNotes, fetchRandomNoteFromFirestore, fetchRandomNotesBatch, fetchAllNotesFromFirestore } from './services/firebaseService';

const sanitizeNotes = (rawNotes: any[]): Note[] => {
    if (!Array.isArray(rawNotes)) return [];
    return rawNotes.map((n, index) => {
        const parseDate = (val: any): number => {
            if (typeof val === 'number' && !isNaN(val)) return val;
            if (typeof val === 'string') {
                const parsed = Date.parse(val);
                if (!isNaN(parsed)) return parsed;
            }
            return Date.now();
        };
        return {
            id: typeof n.id === 'string' ? n.id : `restored-${index}-${Date.now()}`,
            title: typeof n.title === 'string' ? n.title : 'Untitled Note',
            content: typeof n.content === 'string' ? n.content : '',
            summary: typeof n.summary === 'string' ? n.summary : '',
            createdAt: parseDate(n.createdAt),
            updatedAt: parseDate(n.updatedAt),
            images: Array.isArray(n.images) ? n.images.filter((img: any) => typeof img === 'string') : [],
            transcription: typeof n.transcription === 'string' ? n.transcription : '',
            sources: Array.isArray(n.sources) ? n.sources : [],
            isProcessed: !!n.isProcessed,
            isEnhancing: false,
            quizMasteryCount: typeof n.quizMasteryCount === 'number' ? n.quizMasteryCount : 0
        };
    });
};

const App: React.FC = () => {
  const [view, setView] = useState<ViewMode>(ViewMode.LIST);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [lastBackupTime, setLastBackupTime] = useState<number | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [isCloudLoading, setIsCloudLoading] = useState(false);

  // Search State - Hoisted for Persistence (단순 텍스트 검색만 사용. AI 시맨틱 검색은 정리 대상으로 제거됨)
  const [searchTerm, setSearchTerm] = useState('');

  // Loading state specifically for Random Note button to prevent double clicks
  const [isRandomLoading, setIsRandomLoading] = useState(false);

  // Track recently shown random notes to prevent repetition.
  const [recentRandomIds, setRecentRandomIds] = useState<string[]>([]);
  
  // Use ref for notes to prevent re-triggering quiz generation on note updates
  const notesRef = useRef<Note[]>(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // Quiz State with Queue support
  const [quizState, setQuizState] = useState<QuizState>({
    isActive: false,
    mode: null,
    language: 'Korean',
    isGenerating: false,
    questionQueue: [],
    currentQuestion: null,
    error: null,
    stats: { correct: 0, total: 0 }
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quizAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    const initData = async () => {
        try {
            const savedBackupTime = localStorage.getItem('medinote_last_backup');
            if (savedBackupTime) setLastBackupTime(parseInt(savedBackupTime, 10));

            // Fast Track Loading from Local DB
            const recentNotes = await getRecentNotesFromDB(15);
            if (recentNotes.length > 0) {
                setNotes(recentNotes);
            }

            // Full Load from Local DB
            const dbNotes = await getAllNotesFromDB();
            setNotes(dbNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));

        } catch (e) { console.error("Init failed", e); }
    };
    initData();

    // Initialize Firebase Sync
    console.log("App: Initializing Firebase Sync...");
    const unsubscribe = syncNotesFromFirestore((remoteNotes) => {
        setNotes(prevNotes => {
            const noteMap = new Map<string, Note>();
            prevNotes.forEach(n => noteMap.set(n.id, n));
            remoteNotes.forEach(n => noteMap.set(n.id, n));
            
            const merged = Array.from(noteMap.values());
            // Sort merged list
            merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return merged;
        });

        if (remoteNotes.length > 0) {
            saveAllNotesToDB(remoteNotes).catch(console.error);
        }
    });

    return () => unsubscribe();
  }, []);

  const handleLoadMoreNotes = async () => {
      if (notes.length === 0) return;
      setIsCloudLoading(true);
      try {
          const lastNote = notes[notes.length - 1];
          const olderNotes = await fetchOlderNotes(lastNote.updatedAt || 0);
          
          if (olderNotes.length > 0) {
              setNotes(prev => {
                  const noteMap = new Map<string, Note>();
                  prev.forEach(n => noteMap.set(n.id, n));
                  olderNotes.forEach(n => noteMap.set(n.id, n));
                  const merged = Array.from(noteMap.values());
                  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                  return merged;
              });
              await saveAllNotesToDB(olderNotes);
          } else {
              alert("더 이상 불러올 메모가 없습니다.");
          }
      } catch (e) {
          console.error("Fetch older notes failed", e);
      } finally {
          setIsCloudLoading(false);
      }
  };

  // opts.silent: 검색 시 자동으로 전체 메모를 불러올 때는 alert 팝업을 띄우지 않습니다.
  const handleFetchAllNotes = async (opts?: { silent?: boolean }) => {
      setIsCloudLoading(true);
      try {
          const allNotes = await fetchAllNotesFromFirestore();
          if (allNotes.length > 0) {
              setNotes(prev => {
                  const noteMap = new Map<string, Note>();
                  prev.forEach(n => noteMap.set(n.id, n));
                  allNotes.forEach(n => noteMap.set(n.id, n));
                  const merged = Array.from(noteMap.values());
                  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                  return merged;
              });
              await saveAllNotesToDB(allNotes);
              if (!opts?.silent) alert(`${allNotes.length}개의 메모를 모두 불러왔습니다.`);
          } else if (!opts?.silent) {
              alert("불러올 메모가 없습니다.");
          }
      } catch (e) {
          console.error("Fetch all notes failed", e);
          if (!opts?.silent) alert("메모를 불러오는 중 오류가 발생했습니다.");
      } finally {
          setIsCloudLoading(false);
      }
  };

  // 검색을 처음 사용하는 순간, 화면에 아직 로드되지 않은(오래된) 클라우드 메모까지
  // 검색 범위에 포함되도록 전체 메모를 한 번만 자동으로 불러옵니다.
  const hasAutoFetchedAllForSearchRef = useRef(false);
  useEffect(() => {
      if (searchTerm.trim() && !hasAutoFetchedAllForSearchRef.current) {
          hasAutoFetchedAllForSearchRef.current = true;
          handleFetchAllNotes({ silent: true });
      }
  }, [searchTerm]);

  const pickLocalRandomNote = (currentNotes: Note[], excludeIds: string[]): Note | null => {
      if (currentNotes.length === 0) return null;
      let candidates = currentNotes.filter(n => !excludeIds.includes(n.id));
      
      if (candidates.length === 0) {
          candidates = currentNotes;
      }
      
      // WEIGHTED SELECTION LOGIC based on Mastery Count
      // The higher the mastery count, the lower the probability of being selected.
      // Weight = 1 / (masteryCount + 1)
      // Count 0 -> Weight 1
      // Count 1 -> Weight 0.5
      // Count 4 -> Weight 0.2
      const itemsWithWeights = candidates.map(note => {
          const mastery = note.quizMasteryCount || 0;
          // Add a small epsilon or use (mastery + 1) to avoid division by zero
          const weight = 1 / (mastery + 1);
          return { note, weight };
      });

      // Sum of all weights
      const totalWeight = itemsWithWeights.reduce((sum, item) => sum + item.weight, 0);
      let randomVal = Math.random() * totalWeight;

      for (const item of itemsWithWeights) {
          randomVal -= item.weight;
          if (randomVal <= 0) {
              return item.note;
          }
      }

      // Fallback
      return candidates[Math.floor(Math.random() * candidates.length)];
  };

  useEffect(() => {
    // Background Quiz Generation Logic
    if (!quizState.isActive || !quizState.mode) return;

    const BUFFER_SIZE = quizState.mode === 'QUICK_OX' ? 2 : 1;
    if (quizState.questionQueue.length >= BUFFER_SIZE || quizState.isGenerating || quizState.error) return;

    const fetchNext = async () => {
        if (quizState.isGenerating) return;
        setQuizState(prev => ({ ...prev, isGenerating: true, error: null }));
        
        try {
            // Small delay to allow UI to settle on mobile and ensure environment is ready
            await new Promise(resolve => setTimeout(resolve, 300));
            
            let randomContextNotes: Note[] = [];

            // PRIORITY 1: Pick from LOCAL notes first for better randomness
            if (notesRef.current.length > 0) {
                // Try to fill 3 slots with local notes
                for(let i=0; i<3; i++) {
                    const currentExclude = [...recentRandomIds, ...randomContextNotes.map(n => n.id)];
                    const localN = pickLocalRandomNote(notesRef.current, currentExclude);
                    if (localN) randomContextNotes.push(localN);
                }
            }

            // PRIORITY 2: If local notes are insufficient (e.g., empty app), try Cloud
            if (randomContextNotes.length === 0) {
                 const cloudNotes = await fetchRandomNotesBatch(3, recentRandomIds, notesRef.current);
                 randomContextNotes = cloudNotes;
            }

            if (randomContextNotes.length === 0) {
                 setQuizState(prev => ({ 
                     ...prev, 
                     isGenerating: false, 
                     error: notesRef.current.length === 0 ? "작성된 메모가 없습니다. 먼저 메모를 작성해주세요." : "문제를 생성할 메모를 찾지 못했습니다." 
                 }));
                 return;
            }
            
            // Hydrate notes (fetch images/full content if needed)
            // MEMORY OPTIMIZATION: Limit images per note during hydration to save memory on mobile
            const hydratedNotes: Note[] = [];
            for (const note of randomContextNotes) {
                try {
                    const fullNote = await getNoteFromDB(note.id);
                    if (fullNote) {
                        // Keep only first 2 images to save memory
                        const optimizedNote = {
                            ...fullNote,
                            images: fullNote.images ? fullNote.images.slice(0, 2) : []
                        };
                        hydratedNotes.push(optimizedNote);
                    } else {
                        hydratedNotes.push(note);
                    }
                } catch (dbErr) {
                    console.warn("DB Hydration failed for note", note.id, dbErr);
                    hydratedNotes.push(note);
                }
            }

            // Update history buffer - INCREASED SIZE TO 50
            setRecentRandomIds(prev => {
                const newIds = hydratedNotes.map(n => n.id);
                const updated = [...newIds, ...prev];
                return updated.slice(0, 50); // Keep history of last 50 items to reduce repetition
            });

            let question: QuizQuestion | null = null;
            if (quizState.mode === 'DETAILED') {
                question = await generateMedicalQuiz(hydratedNotes, quizState.language);
            } else {
                question = await generateOXQuiz(hydratedNotes, quizState.language);
            }

            if (question) {
                setQuizState(prev => {
                    if (!prev.isActive || prev.mode !== quizState.mode) return prev;
                    if (!prev.currentQuestion) {
                        return {
                            ...prev,
                            isGenerating: false,
                            currentQuestion: question,
                            error: null
                        };
                    } 
                    return {
                        ...prev,
                        isGenerating: false,
                        questionQueue: [...prev.questionQueue, question],
                        error: null
                    };
                });
            } else {
                 setQuizState(prev => ({ ...prev, isGenerating: false, error: "AI가 문제를 생성하는 데 실패했습니다. 다시 시도해주세요." })); 
            }

        } catch (e: any) {
            console.error("BG Gen Error", e);
            let errorMsg = "네트워크 연결이 불안정합니다. 잠시 후 다시 시도해주세요.";
            
            if (e && typeof e === 'object') {
                const msg = e.message || "";
                if (msg.includes("API Key")) {
                    errorMsg = "API 설정에 문제가 있습니다. 관리자에게 문의하거나 잠시 후 다시 시도해주세요.";
                } else if (msg.includes("Quota") || msg.includes("429")) {
                    errorMsg = "AI 사용량이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해주세요.";
                } else if (msg.includes("Safety") || msg.includes("blocked")) {
                    errorMsg = "AI가 해당 내용을 분석할 수 없습니다. 다른 메모로 시도해주세요.";
                }
            }
            
            setQuizState(prev => ({ ...prev, isGenerating: false, error: errorMsg }));
        }
    };

    fetchNext();

  }, [quizState.isActive, quizState.mode, quizState.questionQueue.length, quizState.isGenerating, quizState.currentQuestion, quizState.language, quizState.error, recentRandomIds]);


  const handleStartQuiz = React.useCallback((mode: 'DETAILED' | 'QUICK_OX', language: QuizLanguage) => {
      setQuizState({
          isActive: true,
          mode: mode,
          language: language,
          isGenerating: false,
          questionQueue: [],
          currentQuestion: null,
          error: null,
          stats: { correct: 0, total: 0 }
      });
  }, []);

  const handleNextQuestion = async (wasCorrect: boolean) => {
      // Logic: Update mastery count for related notes based on answer correctness
      if (quizState.currentQuestion?.relatedNoteIds) {
          const idsToUpdate = quizState.currentQuestion.relatedNoteIds;
          
          // Update Local State
          setNotes(prevNotes => {
              return prevNotes.map(note => {
                  if (idsToUpdate.includes(note.id)) {
                      // If Correct: Increment
                      // If Wrong: Reset to 0 (Prioritize for review)
                      const newCount = wasCorrect ? (note.quizMasteryCount || 0) + 1 : 0;
                      return {
                          ...note,
                          quizMasteryCount: newCount
                      };
                  }
                  return note;
              });
          });

          // Update DB & Firestore in background
          for (const id of idsToUpdate) {
              try {
                  const note = await getNoteFromDB(id);
                  if (note) {
                      const newCount = wasCorrect ? (note.quizMasteryCount || 0) + 1 : 0;
                      const updatedNote = {
                          ...note,
                          quizMasteryCount: newCount
                      };
                      await saveNoteToDB(updatedNote);
                      saveNoteToFirestore(updatedNote);
                  }
              } catch (e) {
                  console.error("Failed to update mastery count", e);
              }
          }
      }

      setQuizState(prev => {
          const nextQ = prev.questionQueue.length > 0 ? prev.questionQueue[0] : null;
          const remainingQueue = prev.questionQueue.slice(1);
          
          return {
              ...prev,
              currentQuestion: nextQ, 
              questionQueue: remainingQueue,
              stats: {
                  total: prev.stats.total + 1,
                  correct: prev.stats.correct + (wasCorrect ? 1 : 0)
              }
          };
      });
  };

  const handleStopQuiz = () => {
      setQuizState(prev => ({ ...prev, isActive: false, mode: null, currentQuestion: null, questionQueue: [] }));
      setView(ViewMode.LIST);
  };


  const handleExportBackup = async () => {
      // (Existing Export Logic)
      try {
        if (notes.length === 0) {
            alert("백업할 메모가 없습니다.");
            return;
        }
        const allFullNotes: Note[] = [];
        for (const n of notes) {
            const full = await getNoteFromDB(n.id);
            if (full) allFullNotes.push(full);
        }
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        
        const fileName = `medinote_backup_${y}${m}${d}_${hh}${mm}.json`;
        const dataStr = JSON.stringify(allFullNotes, null, 2);
        
        let shareSuccess = false;
        try {
            if (navigator.share && navigator.canShare) {
                const file = new File([dataStr], fileName, { type: 'application/json' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: 'MediNote Backup',
                    });
                    shareSuccess = true;
                }
            }
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
        }

        if (!shareSuccess) {
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }
        const backupTimestamp = now.getTime();
        setLastBackupTime(backupTimestamp);
        localStorage.setItem('medinote_last_backup', backupTimestamp.toString());
    } catch (e) {
        alert("백업 파일 생성에 실패했습니다.");
    }
  };

  const handleExportCSV = async () => {
      // (Existing CSV Export Logic)
      try {
        if (notes.length === 0) {
            alert("내보낼 메모가 없습니다.");
            return;
        }
        const allFullNotes: Note[] = [];
        for (const n of notes) {
            const full = await getNoteFromDB(n.id);
            if (full) allFullNotes.push(full);
        }
        const headers = ['Title', 'Content', 'Created At', 'Updated At'];
        const csvRows = [headers.join(',')];
        for (const note of allFullNotes) {
            const escapeCsv = (str: string) => {
                if (!str) return '""';
                return `"${str.replace(/"/g, '""')}"`;
            };
            const title = escapeCsv(note.title);
            const content = escapeCsv(note.content);
            const createdAt = escapeCsv(new Date(note.createdAt).toISOString());
            const updatedAt = escapeCsv(note.updatedAt ? new Date(note.updatedAt).toISOString() : new Date(note.createdAt).toISOString());
            csvRows.push([title, content, createdAt, updatedAt].join(','));
        }
        const csvString = csvRows.join('\n');
        const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' });
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const fileName = `medinote_export_${y}${m}${d}_${hh}.csv`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e) {
        console.error("CSV Export Error", e);
        alert("CSV 내보내기 중 오류가 발생했습니다.");
    }
  };

  const handleOpenFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFetchAndSelectNote = async (id: string) => {
      try {
          const fullNote = await getNoteFromDB(id);
          if (fullNote) {
              setNotes(prev => prev.map(n => n.id === id ? fullNote : n));
              setActiveNoteId(id);
              setView(ViewMode.DETAIL);
          } else {
              alert("메모를 불러올 수 없습니다.");
          }
      } catch (e) {
          console.error("Failed to load note details", e);
          alert("메모 로딩 중 오류가 발생했습니다.");
      }
  };

  const handleRandomNote = async () => {
    if (isRandomLoading) return;
    setIsRandomLoading(true);
    
    try {
        let randomNote: Note | null = null;

        // PRIORITY 1: LOCAL NOTES (Truly random selection)
        // If the user has notes synced locally, picking from here is mathematically better for randomness
        // than querying cloud cursors which might fail or repeat in sparse datasets.
        if (notes.length > 0) {
            randomNote = pickLocalRandomNote(notes, recentRandomIds);
        }

        // PRIORITY 2: CLOUD FALLBACK
        // Only if local notes are empty (e.g., initial load not finished, or truly empty device)
        if (!randomNote) {
             const randomNotes = await fetchRandomNotesBatch(1, recentRandomIds, notes);
             if (randomNotes.length > 0) randomNote = randomNotes[0];
        }
        
        if (randomNote) {
             // If local lightweight note, ensure we load full details (images)
             if (!randomNote.images || randomNote.images.length === 0) {
                 const fullNote = await getNoteFromDB(randomNote.id);
                 if (fullNote) {
                     randomNote = fullNote;
                 }
             }

             setRecentRandomIds(prev => {
                 const updated = [randomNote!.id, ...prev];
                 // INCREASED HISTORY SIZE: 50
                 return updated.slice(0, 50);
             });

             setNotes(prev => {
                 const exists = prev.some(n => n.id === randomNote!.id);
                 if (exists) {
                     return prev.map(n => n.id === randomNote!.id ? randomNote! : n);
                 }
                 return [randomNote!, ...prev];
             });
             
             setActiveNoteId(randomNote.id);
             setView(ViewMode.DETAIL);
             
             if (window.innerWidth < 768) setShowSidebar(false);
        } else {
             alert("메모가 충분하지 않습니다. 새 메모를 작성해보세요!");
        }
    } catch (e) {
        console.error("Random Note Fetch Failed", e);
        alert("랜덤 메모 불러오기 실패");
    } finally {
        setIsRandomLoading(false);
    }
  };

  const handleImportBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // (Existing Import Logic)
    const file = event.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const content = e.target?.result as string;
            let importedData;
            try { importedData = JSON.parse(content); } catch (err) { alert("파일 형식이 올바르지 않습니다."); return; }
            const cleanNotes = sanitizeNotes(importedData);
            if (cleanNotes.length === 0) { alert("유효한 백업 데이터가 없습니다."); return; }
            if (confirm(`${cleanNotes.length}개의 메모를 가져올까요? (기존 데이터에 병합/덮어쓰기 됩니다)`)) {
                await saveAllNotesToDB(cleanNotes);
                const dbNotes = await getAllNotesFromDB();
                setNotes(dbNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
                alert("복구가 완료되었습니다.");
                (async () => {
                    for (const note of cleanNotes) {
                         await saveNoteToFirestore(note);
                         await new Promise(r => setTimeout(r, 50));
                    }
                })().catch(err => console.error("Background sync error:", err));
            }
        } catch (err) {
            console.error("Import Error", err);
            alert("백업 파일 처리 중 오류가 발생했습니다: " + (err as Error).message);
        }
    };
    reader.readAsText(file);
  };

  const handleSaveNote = async (note: Note) => {
    try {
        if (!note.id) throw new Error("Invalid Note ID");
        const isNewNote = !notes.some(n => n.id === note.id);
        await saveNoteToDB(note);
        saveNoteToFirestore(note);
        setNotes(prev => {
             const exists = prev.some(n => n.id === note.id);
             if (exists) {
                 return prev.map(n => n.id === note.id ? note : n).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
             }
             return [note, ...prev];
        });
        setActiveNoteId(note.id);
        if (isNewNote) {
            setView(ViewMode.LIST);
        } else {
            setView(ViewMode.DETAIL);
        }
        // 버그 수정: 이전에는 이미지가 있으면 재저장할 때마다(내용만 고쳐도) OCR을 다시 돌렸습니다.
        // isProcessed 플래그로 "이미지가 실제로 바뀌어 재처리가 필요한 경우"만 OCR을 실행합니다.
        if (!note.isProcessed && note.images && note.images.length > 0) {
             extractTextFromImages(note.images).then(text => {
                 if (text) {
                     const updatedNote = { ...note, transcription: text, isProcessed: true };
                     saveNoteToDB(updatedNote).catch(console.error);
                     saveNoteToFirestore(updatedNote);
                     setNotes(prev => prev.map(n => n.id === updatedNote.id ? updatedNote : n));
                 }
             });
        }
    } catch (e) {
        console.error("Save Error", e);
        alert("메모 저장 중 오류가 발생했습니다. 다시 시도해주세요.");
    }
  };

  const handleUpdateNote = async (updatedNote: Note) => {
    try {
        await saveNoteToDB(updatedNote);
        saveNoteToFirestore(updatedNote);
        setNotes(prev => prev.map(n => n.id === updatedNote.id ? updatedNote : n));
        if (updatedNote.images && updatedNote.images.length > 0 && !updatedNote.isProcessed) {
            extractTextFromImages(updatedNote.images).then(text => {
                if (text) {
                    const finalNote = { ...updatedNote, transcription: text, isProcessed: true };
                    saveNoteToDB(finalNote).catch(console.error);
                    saveNoteToFirestore(finalNote);
                    setNotes(prev => prev.map(n => n.id === finalNote.id ? finalNote : n));
                }
            });
        }
    } catch(e) {
        console.error("Update Error", e);
        alert("메모 수정 저장 실패");
    }
  };

  const handleDeleteNote = async (id: string) => {
    if(confirm('삭제하시겠습니까?')) {
        await deleteNoteFromDB(id);
        deleteNoteFromFirestore(id);
        setNotes(prev => prev.filter(n => n.id !== id));
        setView(ViewMode.LIST);
        setActiveNoteId(null);
    }
  };

  const handleUpdateNotes = async (updatedNotes: Note[]) => {
    try {
        for (const note of updatedNotes) {
            await saveNoteToDB(note);
            saveNoteToFirestore(note);
        }
        setNotes(prev => {
            const noteMap = new Map<string, Note>();
            prev.forEach(n => noteMap.set(n.id, n));
            updatedNotes.forEach(n => noteMap.set(n.id, n));
            const merged = Array.from(noteMap.values());
            merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return merged;
        });
    } catch (e) {
        console.error("Bulk Update Error", e);
        alert("메모 일괄 업데이트 중 오류가 발생했습니다.");
    }
  };

  const isMobile = typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent);
  const activeNote = notes.find(n => n.id === activeNoteId);

  return (
    <div className="flex w-screen overflow-hidden bg-white h-screen h-[100dvh]">
      {/* Sidebar */}
      <div className={`${showSidebar ? 'w-full md:w-80 translate-x-0' : 'w-0 -translate-x-full md:w-0'} transition-all duration-300 flex-shrink-0 bg-white border-r border-slate-100 flex flex-col h-full absolute md:relative z-50 shadow-2xl md:shadow-none overflow-hidden`}>
        <div className="p-6 h-16 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
               <Network className="text-white w-4 h-4" />
            </div>
            <h1 className="font-bold text-lg text-slate-800 tracking-tight">MediNote</h1>
          </div>
          <button onClick={() => setShowSidebar(false)} className="md:hidden p-2 text-slate-400 hover:bg-slate-50 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 mb-6 flex-shrink-0">
          <button
            onClick={() => { setView(ViewMode.CREATE); setActiveNoteId(null); if (isMobile) setShowSidebar(false); }}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg flex items-center justify-center font-bold text-sm shadow-lg shadow-blue-100 transition-all active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 mr-2" />
            새 메모 작성
          </button>
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          <button onClick={() => { setView(ViewMode.LIST); setSearchTerm(''); if (isMobile) setShowSidebar(false); }} className={`w-full flex items-center px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${view === ViewMode.LIST ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}>
            <LayoutGrid className="w-3.5 h-3.5 mr-3" /> 내 메모장
          </button>
          
          <button 
             onClick={handleRandomNote} 
             disabled={isRandomLoading}
             className="w-full flex items-center px-3 py-2.5 rounded-lg text-xs font-medium text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRandomLoading ? <Loader2 className="w-3.5 h-3.5 mr-3 animate-spin" /> : <Shuffle className="w-3.5 h-3.5 mr-3" />}
            무작위 공부하기
          </button>

          <button 
            onClick={() => { setView(ViewMode.QUIZ); if (isMobile) setShowSidebar(false); }} 
            className={`w-full flex items-center px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${view === ViewMode.QUIZ ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            {quizState.isGenerating && quizState.isActive ? (
                 <Loader2 className="w-3.5 h-3.5 mr-3 animate-spin text-blue-600" />
            ) : (
                 <BrainCircuit className="w-3.5 h-3.5 mr-3" />
            )}
            AI 퀴즈 복습
            {quizState.questionQueue.length > 0 && (
                <span className="ml-auto bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded-full">
                    {quizState.questionQueue.length}
                </span>
            )}
          </button>

          <button onClick={() => { setView(ViewMode.STUDY_GUIDE); if (isMobile) setShowSidebar(false); }} className={`w-full flex items-center px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${view === ViewMode.STUDY_GUIDE ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}>
             <Lightbulb className="w-3.5 h-3.5 mr-3" /> AI 주제 탐구
          </button>
        </nav>

        <div className="p-5 border-t border-slate-50 space-y-3">
            <div className="flex gap-2">
                <button onClick={handleExportBackup} className="flex-1 flex flex-col items-center justify-center gap-1 py-3 bg-blue-50/50 rounded-xl text-[11px] font-bold text-blue-700 hover:bg-blue-100 transition-all">
                    <Cloud className="w-4 h-4" /> 백업 저장하기
                </button>
                <button onClick={handleOpenFilePicker} className="flex-1 flex flex-col items-center justify-center gap-1 py-3 bg-slate-50 rounded-xl text-[11px] font-bold text-slate-600 hover:bg-slate-100 transition-all">
                    <Upload className="w-4 h-4 text-slate-400" /> 복구 불러오기
                </button>
            </div>
            
            <button onClick={handleExportCSV} className="w-full flex items-center justify-center gap-2 py-2.5 bg-white border border-slate-200 rounded-xl text-[11px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-all shadow-sm">
                <Download className="w-3.5 h-3.5" /> Notion/Excel용 CSV 내보내기
            </button>

            <input type="file" ref={fileInputRef} onChange={handleImportBackup} accept=".json" className="hidden" />
            
            {lastBackupTime && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-300 justify-center">
                    <Clock className="w-2.5 h-2.5" /> 마지막 백업: {new Date(lastBackupTime).toLocaleString()}
                </div>
            )}
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 h-full relative flex flex-col overflow-hidden bg-white">
        {!showSidebar && (
            <div className="h-12 px-4 bg-white border-b border-slate-50 flex items-center justify-between sticky top-0 z-40 flex-none shadow-sm">
                <button onClick={() => setShowSidebar(true)} className="w-10 h-10 flex items-center justify-center text-slate-400 hover:bg-slate-50 rounded-full transition-all">
                    <Menu className="w-5 h-5" />
                </button>
                <span className="font-bold text-slate-800 text-base absolute left-1/2 transform -translate-x-1/2">MediNote</span>
                <div className="flex items-center gap-1">
                   <button onClick={handleExportBackup} className="w-10 h-10 flex items-center justify-center text-blue-500 hover:bg-blue-50 rounded-full" title="백업하기">
                      <Cloud className="w-5 h-5" />
                   </button>
                   <button onClick={handleRandomNote} className="w-10 h-10 flex items-center justify-center text-orange-500 hover:bg-orange-50 rounded-full">
                      <Shuffle className="w-5 h-5" />
                   </button>
                </div>
            </div>
        )}

        <div className="flex-1 overflow-hidden relative flex flex-col">
            <div className="flex-1 w-full bg-white overflow-hidden flex flex-col relative">
                {view === ViewMode.CREATE && <NoteEditor onSave={handleSaveNote} onCancel={() => setView(ViewMode.LIST)} />}
                {view === ViewMode.EDIT && activeNote && <NoteEditor initialNote={activeNote} onSave={handleSaveNote} onCancel={() => setView(ViewMode.DETAIL)} />}
                {view === ViewMode.LIST && (
                    <NoteList 
                        notes={notes} 
                        onDelete={handleDeleteNote} 
                        onUpdateNote={handleUpdateNote} 
                        onImportBackup={handleOpenFilePicker}
                        onExportBackup={handleExportBackup}
                        onSelectNote={handleFetchAndSelectNote}
                        activeNoteId={activeNoteId}
                        onClearActiveNote={() => setActiveNoteId(null)}
                        onRandomNote={handleRandomNote}
                        onLoadMore={handleLoadMoreNotes}
                        onFetchAll={handleFetchAllNotes}
                        isLoadingMore={isCloudLoading}
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                    />
                )}
                {view === ViewMode.DETAIL && activeNote && (
                    <NoteDetail 
                        note={activeNote} 
                        allNotes={notes} 
                        onBack={() => setView(ViewMode.LIST)} 
                        onDelete={handleDeleteNote} 
                        onSelectNote={handleFetchAndSelectNote} 
                        onEdit={() => { setView(ViewMode.EDIT); }} 
                        onUpdateNote={handleUpdateNote} 
                    />
                )}
                {view === ViewMode.QUIZ && (
                    <QuizView 
                        notes={notes} 
                        quizState={quizState} 
                        onStart={handleStartQuiz} 
                        onNext={handleNextQuestion}
                        onStop={handleStopQuiz}
                        onBack={() => { setView(ViewMode.LIST); }} 
                    />
                )}
                 {view === ViewMode.STUDY_GUIDE && (
                    <StudyGuideView 
                        notes={notes}
                        onBack={() => setView(ViewMode.LIST)}
                    />
                )}
            </div>
        </div>

        {view === ViewMode.LIST && (
          <button onClick={() => { setView(ViewMode.CREATE); setActiveNoteId(null); if (isMobile) setShowSidebar(false); }} className="absolute bottom-10 right-8 w-14 h-14 bg-blue-600 text-white rounded-full shadow-2xl flex items-center justify-center transition-all z-40 active:scale-95 hover:bg-blue-700">
            <Plus className="w-8 h-8" />
          </button>
        )}
      </main>
    </div>
  );
};

export default App;
