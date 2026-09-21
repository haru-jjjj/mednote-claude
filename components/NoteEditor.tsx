
import React, { useState, useRef, useEffect } from 'react';
import { Save, ArrowLeft, Image as ImageIcon, X, Loader2, ChevronLeft, ChevronRight, Bold, Italic, Subscript, Superscript, ArrowRight, Code, Sigma, Type, Undo, Table as TableIcon } from 'lucide-react';
import { Note } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface NoteEditorProps {
  onSave: (note: Note) => void;
  onCancel: () => void;
  initialNote?: Note | null;
}

// ----------------------------------------------------------------------------
// 붙여넣기 호환 처리: 클로드(claude.ai) 등에서 렌더링된 표/서식을 복사하면 클립보드에는
// text/plain(파이프 없이 탭/공백으로만 정렬된 텍스트)과 text/html(<table> 등 실제 구조)이
// 함께 담깁니다. <textarea>에 그냥 붙여넣으면 브라우저가 자동으로 text/plain을 쓰기 때문에
// 표의 구분선(|, ---)이 사라져 나중에 마크다운으로 렌더링되지 않습니다.
// 아래 변환기는 클립보드의 text/html을 직접 파싱해서 GFM 마크다운(표 포함)으로 바꿔줍니다.
// ----------------------------------------------------------------------------
const RICH_PASTE_TAG_REGEX = /<(table|ul|ol|h[1-6]|strong|b|em|i|code|pre|blockquote)[\s>]/i;

const htmlToMarkdown = (root: HTMLElement): string => {
    function walk(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent || '').replace(/\s+/g, ' ');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const children = () => Array.from(el.childNodes).map(walk).join('');

        switch (tag) {
            // 일부 소스(워드, 구글 문서 등)는 클립보드 HTML 맨 앞에 <style>/<meta> 등을
            // 함께 붙여 보낸다. 텍스트로 잘못 새어 들어가지 않도록 명시적으로 무시한다.
            case 'style': case 'script': case 'head': case 'meta': case 'link':
                return '';
            case 'table': {
                const rows = Array.from((el as HTMLTableElement).rows);
                if (rows.length === 0) return '';
                const cellToMd = (cell: HTMLTableCellElement) =>
                    Array.from(cell.childNodes).map(walk).join('')
                        .replace(/\|/g, '\\|')
                        .replace(/\r?\n+/g, ' ')
                        .trim();
                const headerCells = Array.from(rows[0].cells).map(cellToMd);
                const colCount = Math.max(1, headerCells.length);
                const lines = [
                    '| ' + headerCells.join(' | ') + ' |',
                    '| ' + Array(colCount).fill('---').join(' | ') + ' |'
                ];
                for (let i = 1; i < rows.length; i++) {
                    const cells = Array.from(rows[i].cells).map(cellToMd);
                    while (cells.length < colCount) cells.push('');
                    lines.push('| ' + cells.slice(0, colCount).join(' | ') + ' |');
                }
                return '\n' + lines.join('\n') + '\n\n';
            }
            case 'strong': case 'b': { const t = children().trim(); return t ? `**${t}**` : ''; }
            case 'em': case 'i': { const t = children().trim(); return t ? `*${t}*` : ''; }
            case 'del': case 's': { const t = children().trim(); return t ? `~~${t}~~` : ''; }
            case 'code': return `\`${el.textContent || ''}\``;
            case 'pre': return `\n\`\`\`\n${el.textContent || ''}\n\`\`\`\n\n`;
            case 'a': {
                const href = el.getAttribute('href') || '';
                const t = children().trim();
                return href ? `[${t || href}](${href})` : t;
            }
            case 'h1': return `\n# ${children().trim()}\n\n`;
            case 'h2': return `\n## ${children().trim()}\n\n`;
            case 'h3': return `\n### ${children().trim()}\n\n`;
            case 'h4': case 'h5': case 'h6': return `\n#### ${children().trim()}\n\n`;
            case 'blockquote':
                return '\n' + children().trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
            case 'li': {
                const parentTag = el.parentElement?.tagName.toLowerCase();
                const prefix = parentTag === 'ol' ? '1. ' : '- ';
                return `${prefix}${children().trim()}\n`;
            }
            case 'ul': case 'ol':
                return '\n' + children() + '\n';
            case 'br': return '\n';
            case 'hr': return '\n---\n\n';
            case 'p': case 'div': {
                const t = children().trim();
                return t ? `${t}\n\n` : '';
            }
            default:
                return children();
        }
    }

    return walk(root);
};

const NoteEditor: React.FC<NoteEditorProps> = ({ onSave, onCancel, initialNote }) => {
  const contentRef = useRef<HTMLTextAreaElement>(null);
  
  // Ref to throttle rapid firing events (Hardware/Software debounce)
  const lastActionTimeRef = useRef<number>(0);
  
  const [hasContent, setHasContent] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [isProcessingImg, setIsProcessingImg] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const loadedNoteIdRef = useRef<string | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  useEffect(() => {
    if (initialNote) {
        if (loadedNoteIdRef.current !== initialNote.id) {
            if (contentRef.current) {
                contentRef.current.value = initialNote.content || '';
            }
            setHasContent(!!(initialNote.content && initialNote.content.trim().length > 0));
            setImages(initialNote.images || []);
            loadedNoteIdRef.current = initialNote.id;
        }
    } else {
        if (loadedNoteIdRef.current !== 'new') {
            if (contentRef.current) {
                contentRef.current.value = '';
            }
            setHasContent(false);
            setImages([]);
            loadedNoteIdRef.current = 'new';
        }
    }
  }, [initialNote]);

  const handleSave = () => {
    if (isProcessingImg) return;

    const currentContent = contentRef.current?.value || '';
    const currentImages = images || [];

    if (!currentContent.trim() && currentImages.length === 0) {
        onCancel(); 
        return;
    }

    const firstLine = currentContent.split('\n')[0] || '';
    const cleanFirstLine = firstLine.substring(0, 40).trim();
    const initialTitle = cleanFirstLine.length > 0 ? cleanFirstLine : (currentImages.length > 0 ? '사진 메모' : '새로운 메모');

    const now = Date.now();
    let noteToSave: Note;

    if (initialNote) {
        const contentChanged = currentContent !== (initialNote.content || '');
        const imagesChanged = JSON.stringify(currentImages) !== JSON.stringify(initialNote.images || []);
        const isModified = contentChanged || imagesChanged;

        noteToSave = {
            ...initialNote,
            content: currentContent,
            images: currentImages,
            updatedAt: now,
            title: (initialNote.title === 'Untitled Note' || !initialNote.title) ? initialTitle : initialNote.title,
            // 버그 수정: 예전에는 내용/이미지를 수정하면 sources만 비우고 summary 텍스트는 그대로
            // 남아있어서 "출처 없는 요약문"이 화면에 남는 불일치가 있었습니다. 이제 둘을 함께
            // 초기화해서 다시 "AI 요약" 버튼을 눌러야 최신 내용 기준으로 재생성되게 합니다.
            summary: isModified ? '' : (initialNote.summary || ''),
            sources: isModified ? [] : (initialNote.sources || []),
            isProcessed: imagesChanged ? false : !!initialNote.isProcessed,
            transcription: imagesChanged ? undefined : initialNote.transcription,
        };
    } else {
        noteToSave = {
            id: uuidv4(),
            title: initialTitle,
            content: currentContent,
            summary: '',
            createdAt: now,
            updatedAt: now,
            sources: [],
            images: currentImages,
            isEnhancing: false,
            isProcessed: false
        };
    }

    onSave(noteToSave);
  };

  const handleTextChange = () => {
      const val = contentRef.current?.value || '';
      const hasText = val.trim().length > 0;
      if (hasText !== hasContent) {
          setHasContent(hasText);
      }
  };

  const resizeAndCompressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_SIZE = 1280;

                if (width > height) {
                    if (width > MAX_SIZE) {
                        height *= MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width *= MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                resolve(dataUrl.split(',')[1]);
            };
            img.onerror = reject;
            img.src = e.target?.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsProcessingImg(true);
    try {
        const newImages: string[] = [];
        for (let i = 0; i < files.length; i++) {
            const base64String = await resizeAndCompressImage(files[i]);
            newImages.push(base64String);
        }
        setImages(prev => [...prev, ...newImages]);
    } catch (e) {
        console.error("Image processing failed", e);
        alert("이미지 처리 중 오류가 발생했습니다.");
    } finally {
        setIsProcessingImg(false);
        if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const moveImage = (e: React.MouseEvent, index: number, direction: 'left' | 'right') => {
      e.stopPropagation();
      if (direction === 'left' && index > 0) {
          const newImages = [...images];
          [newImages[index - 1], newImages[index]] = [newImages[index], newImages[index - 1]];
          setImages(newImages);
      } else if (direction === 'right' && index < images.length - 1) {
          const newImages = [...images];
          [newImages[index + 1], newImages[index]] = [newImages[index], newImages[index + 1]];
          setImages(newImages);
      }
  };

  // Helper to execute actions safely without double firing
  const executeAction = (action: () => void) => {
      const now = Date.now();
      // 300ms throttle to prevent double execution from rapid touches or mouse/touch overlap
      if (now - lastActionTimeRef.current < 300) return;
      lastActionTimeRef.current = now;
      
      action();
  };

  const handleUndo = () => {
      executeAction(() => {
          if (contentRef.current) {
              // Note: preventDefault on the button keeps focus, so we don't strictly need focus(),
              // but purely for safety in case focus was lost elsewhere.
              // We do NOT use requestAnimationFrame or focus() causing loops here.
              document.execCommand('undo');
              
              // Defer state update to next tick to avoid freezing UI during touch handling
              setTimeout(handleTextChange, 0);
          }
      });
  };

  const insertFormatting = (before: string, after: string = '') => {
      executeAction(() => {
          const textarea = contentRef.current;
          if (!textarea) return;
          
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          
          if (typeof start !== 'number' || typeof end !== 'number') return;
          
          const text = textarea.value;
          const selectedText = text.substring(start, end);
          const replacement = before + selectedText + after;
          
          try {
              textarea.setRangeText(replacement, start, end, 'select');
          } catch (e) {
              textarea.value = text.substring(0, start) + replacement + text.substring(end);
              // Simple selection restore
              textarea.setSelectionRange(start + before.length, start + before.length + selectedText.length);
          }
          
          // CRITICAL FIX FOR FREEZE:
          // Do NOT call setState (handleTextChange) synchronously inside a touch event handler.
          // This causes iOS WebKit to lock up if the keyboard is active.
          // Defer checking the content status to the next Event Loop tick.
          setTimeout(handleTextChange, 0);
      });
  };

  const getImageSrc = (imgString: string) => {
      if (imgString.startsWith('http')) return imgString;
      return `data:image/jpeg;base64,${imgString}`;
  };

  // 클립보드에 이미지가 들어있는 경우(스크린샷 복사, 다른 앱/사이트에서 사진 우클릭 →
  // 복사 등) 붙여넣기(Ctrl/Cmd+V)만으로 바로 사진 첨부가 되도록 한다. 파일 선택
  // 업로드(handleImageUpload)와 동일한 리사이즈/압축 파이프라인을 그대로 재사용한다.
  const handlePastedImages = async (items: DataTransferItemList): Promise<boolean> => {
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) imageFiles.push(file);
          }
      }
      if (imageFiles.length === 0) return false;

      setIsProcessingImg(true);
      try {
          const newImages: string[] = [];
          for (const file of imageFiles) {
              const base64String = await resizeAndCompressImage(file);
              newImages.push(base64String);
          }
          setImages(prev => [...prev, ...newImages]);
      } catch (err) {
          console.error('클립보드 이미지 붙여넣기 처리 실패', err);
          alert('이미지 붙여넣기 처리 중 오류가 발생했습니다.');
      } finally {
          setIsProcessingImg(false);
      }
      return true;
  };

  // 클로드 등에서 복사한 표/서식을 붙여넣을 때, 브라우저 기본 동작(plain text만 사용)
  // 대신 클립보드의 HTML을 마크다운으로 변환해서 삽입한다. 표가 없는 일반 텍스트
  // 붙여넣기는 그대로 기본 동작을 사용한다(변환 과정에서 내용이 망가질 위험을 피하기 위함).
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // 이미지가 있으면 사진 첨부로 처리하고, 텍스트/표 붙여넣기 로직은 건너뛴다.
      if (e.clipboardData.items && e.clipboardData.items.length > 0) {
          const hasImage = Array.from(e.clipboardData.items).some(
              item => item.kind === 'file' && item.type.startsWith('image/')
          );
          if (hasImage) {
              e.preventDefault();
              await handlePastedImages(e.clipboardData.items);
              return;
          }
      }

      const html = e.clipboardData.getData('text/html');
      if (!html || !RICH_PASTE_TAG_REGEX.test(html)) return; // 기본 붙여넣기(텍스트) 사용

      let markdown: string | null = null;
      try {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          markdown = htmlToMarkdown(doc.body).replace(/\n{3,}/g, '\n\n').trim();
      } catch (err) {
          console.error('붙여넣기 표/서식 변환 실패, 기본 텍스트 붙여넣기로 대체합니다.', err);
          markdown = null;
      }
      if (!markdown) return; // 변환 실패 시 기본 붙여넣기(텍스트) 사용

      e.preventDefault();
      const textarea = contentRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const before = text.substring(0, start);
      const after = text.substring(end);

      // 표/블록 요소는 앞뒤에 빈 줄이 있어야 별도 블록으로 정확히 인식된다.
      const leadingBreak = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
      const trailingBreak = after.length === 0 || after.startsWith('\n') ? '' : '\n\n';
      const insertion = leadingBreak + markdown + trailingBreak;

      try {
          textarea.setRangeText(insertion, start, end, 'end');
      } catch {
          textarea.value = before + insertion + after;
          const pos = (before + insertion).length;
          textarea.setSelectionRange(pos, pos);
      }

      setTimeout(handleTextChange, 0);
  };

  // ROBUST Toolbar Button:
  // 1. Prevents Default on both MouseDown and TouchStart -> Stops Focus Loss (Keyboard stays up)
  // 2. Prevents Default on TouchStart -> Stops Ghost Click generation
  // 3. Executes action directly via the handler (Throttled)
  // 4. Does NOT use onClick to avoid ambiguity.
  const ToolbarButton = ({ icon, label, onClick }: { icon?: React.ReactNode, label?: string, onClick: () => void }) => {
      
      const handleInteraction = (e: React.SyntheticEvent) => {
          // Critical: Stop focus loss and stop browser from creating subsequent events
          if (e.cancelable) e.preventDefault();
          e.stopPropagation();
          onClick();
      };

      return (
        <button 
            type="button"
            onMouseDown={handleInteraction}
            onTouchStart={handleInteraction}
            className="p-1 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-all flex items-center justify-center min-w-[28px] touch-manipulation active:bg-blue-100"
            title={label}
        >
            {icon}
            {label && !icon && <span className="text-sm font-bold font-serif">{label}</span>}
        </button>
      );
  };

  return (
    <div className="h-full bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden relative flex flex-col z-0">
      {/* Header */}
      <div className="h-12 px-3 border-b border-slate-100 flex items-center justify-between bg-white z-30 flex-none shadow-sm">
        <button 
            onClick={onCancel}
            className="flex items-center text-slate-500 hover:text-slate-800 transition-colors py-2 px-1 -ml-1"
        >
            <ArrowLeft className="w-4 h-4 mr-1" />
            <span className="text-sm font-medium">뒤로</span>
        </button>
        
        <div className="flex items-center gap-2 md:gap-3">
             <button
                onClick={() => imageInputRef.current?.click()}
                disabled={isProcessingImg}
                className="flex items-center px-2.5 py-1.5 rounded-md font-medium text-slate-600 text-sm transition-all hover:bg-slate-100 border border-slate-200"
                title="사진 첨부"
             >
                {isProcessingImg ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5 mr-2 text-blue-500" />}
                <span className="hidden md:inline">{isProcessingImg ? '처리 중' : '사진 첨부'}</span>
                <span className="md:hidden">사진</span>
             </button>
             <input 
                type="file" 
                ref={imageInputRef} 
                onChange={handleImageUpload} 
                accept="image/*" 
                multiple
                className="hidden" 
             />

             <div className="h-6 w-px bg-slate-200 mx-1"></div>

             <button
              onClick={handleSave}
              disabled={(!hasContent && images.length === 0) || isProcessingImg}
              className={`flex items-center px-3 py-1.5 rounded-md font-bold text-white text-sm transition-all shadow-sm
                ${(!hasContent && images.length === 0) || isProcessingImg
                  ? 'bg-slate-300 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700 hover:shadow-md active:scale-95'
                }`}
            >
              <Save className="w-3.5 h-3.5 mr-2" />
              저장
            </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden bg-white z-0 relative">
        {images.length > 0 && (
            <div className="flex-shrink-0 max-h-[30vh] overflow-y-auto p-4 border-b border-slate-100 bg-slate-50/50">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {images.map((img, idx) => (
                        <div 
                            key={idx} 
                            onClick={() => setViewingImage(img)}
                            className="relative group aspect-square rounded-lg overflow-hidden border border-slate-200 shadow-sm bg-white cursor-zoom-in"
                        >
                            <img 
                                src={getImageSrc(img)} 
                                alt={`Attachment ${idx + 1}`} 
                                className="w-full h-full object-cover transition-transform group-hover:scale-105"
                                loading="lazy"
                            />
                             <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-[10px] font-bold rounded shadow-sm backdrop-blur-sm pointer-events-none">
                                #{idx + 1}
                            </div>
                            <button 
                                onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                                className="absolute top-1 right-1 p-1 bg-black/50 text-white rounded-full hover:bg-red-500 transition-colors z-10"
                            >
                                <X className="w-2.5 h-2.5" />
                            </button>
                             {(idx > 0 || idx < images.length - 1) && (
                                <div className="absolute bottom-1 left-1 right-1 flex justify-between z-10 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                                    <button onClick={(e) => moveImage(e, idx, 'left')} disabled={idx === 0} className="bg-black/40 hover:bg-blue-500 text-white rounded p-0.5"><ChevronLeft className="w-2.5 h-2.5"/></button>
                                    <button onClick={(e) => moveImage(e, idx, 'right')} disabled={idx === images.length - 1} className="bg-black/40 hover:bg-blue-500 text-white rounded p-0.5"><ChevronRight className="w-2.5 h-2.5"/></button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        )}
        
        {/* Formatting Toolbar */}
        <div className="flex items-center gap-1 p-1.5 bg-white border-b border-slate-100 overflow-x-auto flex-none sticky top-0 z-10 hide-scrollbar">
            <ToolbarButton icon={<Undo size={14}/>} onClick={handleUndo} label="Undo" />
            <div className="w-px h-5 bg-slate-200 mx-1"></div>
            <ToolbarButton icon={<Bold size={14}/>} onClick={() => insertFormatting('**', '**')} label="Bold" />
            <ToolbarButton icon={<Italic size={14}/>} onClick={() => insertFormatting('*', '*')} label="Italic" />
            <div className="w-px h-5 bg-slate-200 mx-1"></div>
            <ToolbarButton icon={<Type size={14}/>} onClick={() => insertFormatting('### ')} label="Heading" />
            <div className="w-px h-5 bg-slate-200 mx-1"></div>
            <ToolbarButton icon={<Subscript size={14}/>} onClick={() => insertFormatting('_{', '}')} label="Subscript" />
            <ToolbarButton icon={<Superscript size={14}/>} onClick={() => insertFormatting('^{', '}')} label="Superscript" />
            <div className="w-px h-5 bg-slate-200 mx-1"></div>
            <ToolbarButton icon={<ArrowRight size={14}/>} onClick={() => insertFormatting('\\rightarrow ')} label="Arrow" />
            <ToolbarButton label="α" onClick={() => insertFormatting('\\alpha ')} />
            <ToolbarButton label="β" onClick={() => insertFormatting('\\beta ')} />
            <ToolbarButton icon={<Sigma size={14}/>} onClick={() => insertFormatting('`', '`')} label="Math/Code" />
            <div className="w-px h-5 bg-slate-200 mx-1"></div>
            <ToolbarButton icon={<TableIcon size={14}/>} onClick={() => insertFormatting('\n| 제목1 | 제목2 | 제목3 |\n| --- | --- | --- |\n| 내용 | 내용 | 내용 |\n')} label="Table" />
        </div>

        <textarea
          ref={contentRef}
          className="flex-1 w-full resize-none outline-none p-3 md:p-4 text-slate-800 text-sm leading-relaxed placeholder:text-slate-300 bg-transparent overflow-y-auto font-mono md:font-sans"
          placeholder="메모 내용을 입력하세요... (Markdown 지원 — 표는 클로드 답변에서 그대로 복사해 붙여넣어도 됩니다. 사진도 복사해서 Ctrl/Cmd+V로 바로 붙여넣을 수 있어요)"
          defaultValue={initialNote?.content || ''}
          onChange={handleTextChange}
          onPaste={handlePaste}
          autoFocus
          spellCheck={false}
        />
      </div>
      
      {viewingImage && (
          <div 
            className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={() => setViewingImage(null)}
          >
             <button 
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

export default NoteEditor;
