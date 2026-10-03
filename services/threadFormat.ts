// ============================================================================
// 질문 노트(대화) 저장 형식
// - 대화는 메모와 같은 저장소(IndexedDB·Firestore)에 kind: 'thread'인 메모로 저장 → 동기화·삭제·퀴즈 기록을 그대로 씀
// - 메시지는 content(마크다운)에 표시 주석과 함께 한 번만 저장 (Firestore 문서 1MB 한도 때문에 중복 저장하지 않음)
//   질문은 "## Q. ..." 제목이 되어, 퀴즈 출제 범위(구역)도 질문 단위로 나뉨
// ============================================================================
import type { Note, Source, ThreadPending } from '../types';

export interface ThreadMessage {
    role: 'user' | 'assistant';
    at: number;
    text: string;
    quote?: string; // 답변에서 골라 물어본 부분
    sources?: Source[];
}

const Q_RE = /<!-- mt:q (\d+) -->/;
const MARK_SPLIT = /(<!-- mt:(?:q|a) \d+ -->)/;

// 모델 출력이나 질문에 표시 주석이 섞여 들어오면 형식이 깨지므로 제거
// 닫히지 않은 "<!--"도 그 뒤 대화를 주석처럼 가려버리므로 보이지 않는 문자를 끼워 무력화
const scrub = (s: string) => (s || '').replace(/<!--\s*\/?mt:[^>]*-->/g, '').replace(/<!--/g, '<\u200B!--').trim();

// 답변 속 #·## 제목은 ###로 낮춤 (코드 블록 안은 그대로)
const demoteHeadings = (md: string) => {
    let inCode = false;
    return md.split('\n').map(line => {
        if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
        return inCode ? line : line.replace(/^#{1,2}(\s)/, '###$1');
    }).join('\n');
};

const cleanTitle = (t: string) => (t || '').replace(/[[\]]/g, m => (m === '[' ? '(' : ')')).replace(/\s+/g, ' ').trim();
const cleanUri = (u: string) => (u || '').replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

export const encodeThread = (messages: ThreadMessage[]): string => {
    const out: string[] = [];
    messages.forEach(m => {
        if (m.role === 'user') {
            const lines = scrub(m.text).split('\n');
            const first = (lines.shift() || '').trim() || '(질문)';
            const block = [`<!-- mt:q ${m.at} -->`, `## Q. ${first}`];
            const quote = scrub(m.quote || '');
            if (quote) {
                block.push('<!-- mt:quote -->');
                quote.split('\n').forEach(l => block.push(`> ${l}`));
                block.push('<!-- /mt:quote -->');
            }
            const rest = lines.join('\n').trim();
            if (rest) block.push(rest);
            out.push(block.join('\n'));
        } else {
            // 답변 속 #·## 제목은 ###로 낮춤 — "## Q." 질문 제목만 큰 구역이 되게 (퀴즈 구역이 질문 단위로 나뉨)
            const body = demoteHeadings(scrub(m.text));
            const block = [`<!-- mt:a ${m.at} -->`, body];
            const src = (m.sources || []).filter(s => s && s.uri);
            if (src.length) {
                block.push('<!-- mt:src -->');
                src.forEach(s => block.push(`- [${cleanTitle(s.title || s.uri)}](${cleanUri(s.uri)})`));
                block.push('<!-- /mt:src -->');
            }
            out.push(block.join('\n'));
        }
    });
    return out.join('\n\n') + (out.length ? '\n' : '');
};

export const parseThread = (content: string): ThreadMessage[] => {
    const parts = (content || '').split(MARK_SPLIT);
    const msgs: ThreadMessage[] = [];
    for (let i = 1; i < parts.length; i += 2) {
        const marker = parts[i];
        const body = (parts[i + 1] || '').replace(/^\n/, '');
        const at = Number((/(\d+)/.exec(marker) || [])[1]) || 0;
        if (Q_RE.test(marker)) {
            let text = body;
            let quote: string | undefined;
            const qm = /<!-- mt:quote -->\n?([\s\S]*?)\n?<!-- \/mt:quote -->\n?/.exec(text);
            if (qm) {
                quote = qm[1].split('\n').map(l => l.replace(/^> ?/, '')).join('\n').trim() || undefined;
                text = text.replace(qm[0], '');
            }
            const lines = text.trim().split('\n');
            const first = (lines.shift() || '').replace(/^##\s+Q\.\s?/, '');
            const rest = lines.join('\n').trim();
            msgs.push({ role: 'user', at, text: [first, rest].filter(Boolean).join('\n'), ...(quote ? { quote } : {}) });
        } else {
            let text = body;
            const sources: Source[] = [];
            const sm = /<!-- mt:src -->\n?([\s\S]*?)\n?<!-- \/mt:src -->/.exec(text);
            if (sm) {
                const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(sm[1])) !== null) {
                    const uri = m[2].replace(/%28/g, '(').replace(/%29/g, ')').replace(/%20/g, ' ');
                    sources.push({ title: m[1], uri });
                }
                text = text.replace(sm[0], '');
            }
            msgs.push({ role: 'assistant', at, text: text.trim(), ...(sources.length ? { sources } : {}) });
        }
    }
    return msgs;
};

export const isThread = (n: Pick<Note, 'kind'>) => n.kind === 'thread';

export const threadTitleFrom = (question: string) => {
    const t = (question || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) + '…' : t || '새 질문';
};

// 질문 수 (목록 표시용, 파싱 없이)
export const countQuestions = (content: string) => ((content || '').match(/<!-- mt:q \d+ -->/g) || []).length;

// 마지막 질문에 아직 답이 없는지 (답변 실패·도중에 앱 닫음)
export const lastQuestionUnanswered = (msgs: ThreadMessage[]) => msgs.length > 0 && msgs[msgs.length - 1].role === 'user';

export const pendingOf = (n: Pick<Note, 'threadPending'>): ThreadPending[] =>
    Array.isArray(n.threadPending) ? n.threadPending : [];

export const sanitizePending = (raw: any): ThreadPending[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const list = raw
        .filter((p: any) => p && typeof p.id === 'string' && typeof p.text === 'string' && p.text.trim())
        .map((p: any) => ({ id: p.id, text: p.text, at: typeof p.at === 'number' ? p.at : 0 }));
    return list.length ? list : undefined;
};

// Firestore 한 문서 1MB 한도 (한국어 글자당 약 3바이트) — 이보다 길어지면 새 대화로 이어가기를 권함
export const THREAD_SOFT_LIMIT_CHARS = 250000;
