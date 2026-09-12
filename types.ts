
export interface Source {
  title: string;
  uri: string;
}

export interface Note {
  id: string;
  title: string;
  content: string; // Markdown supported
  summary: string;
  createdAt: number;
  updatedAt?: number;
  sources: Source[];
  images?: string[];
  transcription?: string;
  isEnhancing: boolean;
  isProcessed?: boolean;
  quizMasteryCount?: number; // Tracks how many times a user answered correctly related to this note
  embedding?: number[]; // Voyage AI 임베딩 벡터 (의미 기반 검색용)
  embeddingUpdatedAt?: number; // embedding이 계산된 시점 — updatedAt보다 오래되면 재계산 필요
}

export enum ViewMode {
  LIST = 'LIST',
  CREATE = 'CREATE',
  EDIT = 'EDIT',
  DETAIL = 'DETAIL',
  QUIZ = 'QUIZ',
  STUDY_GUIDE = 'STUDY_GUIDE'
}

export type QuizType = 'MULTIPLE_CHOICE' | 'OX';
export type QuizLanguage = 'Korean' | 'English' | 'Japanese';

export interface QuizQuestion {
    id: string;
    type: QuizType;
    question: string;
    options: string[]; // For OX, this might be ignored or used for rendering
    correctAnswerIndex: number; // 0 for O (True), 1 for X (False) usually
    explanation?: string;
    sources?: { title: string; uri: string }[];
    relatedNoteIds?: string[];
}

export interface QuizState {
    isActive: boolean;
    mode: 'DETAILED' | 'QUICK_OX' | null;
    language: QuizLanguage;
    isGenerating: boolean;
    questionQueue: QuizQuestion[];
    currentQuestion: QuizQuestion | null;
    error: string | null;
    stats: {
        correct: number;
        total: number;
    };
}
