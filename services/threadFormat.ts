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
    images?: number[]; // 이 질문에 첨부한 사진 = 대화 메모의 images 배열 번호 (사진은 메모와 같은 곳에 저장)
    fast?: boolean; // 빠른 모드로 받은 답변
    seen?: Source[]; // 답을 쓰며 검색해 본 자료 중 본문에 번호로 직접 인용되지 않은 것 (§5-62)
    queries?: string[]; // 그 답을 쓰며 쓴 검색어
    followups?: string[]; // 답변 끝에 AI가 제안한 "이어서 물어볼 만한 것" (§5-63)
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
            const imgs = (m.images || []).filter(i => Number.isInteger(i) && i >= 0);
            if (imgs.length) block.push(`<!-- mt:img ${imgs.join(',')} -->`);
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
            const block = [`<!-- mt:a ${m.at} -->`, ...(m.fast ? ['<!-- mt:fast -->'] : []), body];
            const src = (m.sources || []).filter(s => s && s.uri);
            if (src.length) {
                block.push('<!-- mt:src -->');
                // 순서가 곧 본문의 [n] 번호. 인용한 원문 일부는 " :: " 뒤에 한 줄로
                src.forEach(s => block.push(`- [${cleanTitle(s.title || s.uri)}](${cleanUri(s.uri)})${s.snippet ? ` :: ${scrub(s.snippet).replace(/\s+/g, ' ')}` : ''}`));
                block.push('<!-- /mt:src -->');
            }
            // 검색해 본 자료(직접 인용 안 된 것)와 검색어: "? 검색어" / "- [제목](주소)"
            const cited = new Set(src.map(s => s.uri));
            const seen = (m.seen || []).filter(s => s && s.uri && !cited.has(s.uri));
            const queries = (m.queries || []).map(q => scrub(q).replace(/\s+/g, ' ')).filter(Boolean);
            if (seen.length || queries.length) {
                block.push('<!-- mt:seen -->');
                queries.forEach(q => block.push(`? ${q}`));
                seen.forEach(s => block.push(`- [${cleanTitle(s.title || s.uri)}](${cleanUri(s.uri)})`));
                block.push('<!-- /mt:seen -->');
            }
            const next = (m.followups || []).map(q => scrub(q).replace(/\s+/g, ' ')).filter(Boolean);
            if (next.length) {
                block.push('<!-- mt:next -->');
                next.forEach(q => block.push(`- ${q}`));
                block.push('<!-- /mt:next -->');
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
            let images: number[] | undefined;
            const im = /<!-- mt:img ([\d,]+) -->\n?/.exec(text);
            if (im) {
                images = im[1].split(',').map(Number).filter(n => Number.isInteger(n) && n >= 0);
                text = text.replace(im[0], '');
            }
            const qm = /<!-- mt:quote -->\n?([\s\S]*?)\n?<!-- \/mt:quote -->\n?/.exec(text);
            if (qm) {
                quote = qm[1].split('\n').map(l => l.replace(/^> ?/, '')).join('\n').trim() || undefined;
                text = text.replace(qm[0], '');
            }
            const lines = text.trim().split('\n');
            const first = (lines.shift() || '').replace(/^##\s+Q\.\s?/, '');
            const rest = lines.join('\n').trim();
            msgs.push({ role: 'user', at, text: [first, rest].filter(Boolean).join('\n'), ...(quote ? { quote } : {}), ...(images && images.length ? { images } : {}) });
        } else {
            let text = body;
            const fast = /^<!-- mt:fast -->\n?/.test(text);
            if (fast) text = text.replace(/^<!-- mt:fast -->\n?/, '');
            const sources: Source[] = [];
            const sm = /<!-- mt:src -->\n?([\s\S]*?)\n?<!-- \/mt:src -->/.exec(text);
            if (sm) {
                sm[1].split('\n').forEach(line => {
                    const m = /^- \[([^\]]*)\]\(([^)\s]+)\)(?:\s*::\s*(.*))?$/.exec(line.trim());
                    if (!m) return;
                    const uri = m[2].replace(/%28/g, '(').replace(/%29/g, ')').replace(/%20/g, ' ');
                    sources.push({ title: m[1], uri, ...(m[3] && m[3].trim() ? { snippet: m[3].trim() } : {}) });
                });
                text = text.replace(sm[0], '');
            }
            const seen: Source[] = [];
            const queries: string[] = [];
            const vm = /<!-- mt:seen -->\n?([\s\S]*?)\n?<!-- \/mt:seen -->/.exec(text);
            if (vm) {
                vm[1].split('\n').forEach(line => {
                    const l = line.trim();
                    if (l.startsWith('? ')) { if (l.slice(2).trim()) queries.push(l.slice(2).trim()); return; }
                    const m = /^- \[([^\]]*)\]\(([^)\s]+)\)$/.exec(l);
                    if (!m) return;
                    seen.push({ title: m[1], uri: m[2].replace(/%28/g, '(').replace(/%29/g, ')').replace(/%20/g, ' ') });
                });
                text = text.replace(vm[0], '');
            }
            const followups: string[] = [];
            const nm = /<!-- mt:next -->\n?([\s\S]*?)\n?<!-- \/mt:next -->/.exec(text);
            if (nm) {
                nm[1].split('\n').forEach(line => { const q = line.trim().replace(/^- /, '').trim(); if (q) followups.push(q); });
                text = text.replace(nm[0], '');
            }
            msgs.push({
                role: 'assistant', at, text: text.trim(),
                ...(followups.length ? { followups } : {}),
                ...(sources.length ? { sources } : {}),
                ...(seen.length ? { seen } : {}),
                ...(queries.length ? { queries } : {}),
                ...(fast ? { fast: true } : {})
            });
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

// AI에게 보낼 때·검색용: 표시 주석 없이 "Q. / A." 형태의 읽기 쉬운 글로
export const threadPlainText = (content: string): string =>
    parseThread(content || '').map(m => {
        if (m.role === 'user') {
            const head = m.quote ? `(앞 답변의 "${m.quote.replace(/\s+/g, ' ').slice(0, 200)}" 부분에 대해)\n` : '';
            const img = m.images && m.images.length ? `[사진 ${m.images.length}장 첨부]\n` : '';
            return `Q. ${head}${img}${m.text}`;
        }
        return `A. ${m.text}`;
    }).join('\n\n');

// 근거 번호([n]) 없이 쓰인 "사실 진술" 찾기 — 수치·단위·권고 등급·금기·시험·용량 같은 말이 들어간 문장/항목
const FACT_RE = /(\d+(?:\.\d+)?\s*(?:%|mg|mcg|μg|ng|pg|g\/dL|mmol|mEq|mmHg|ms|mm|cm|bpm|kg|IU|U\/L|mL|ml|배|시간|일|주|개월|년)\b|\d+(?:\.\d+)?\s*(?:%|배|시간|일|주|개월|년)|\b(?:COR|LOE|Class\s*(?:I{1,3}|IIa|IIb|1|2a|2b|3)|HR|OR|RR|NNT|CI|RCT|trial|meta-analysis|guideline|FDA|label)\b|가이드라인|권고|금기|임상시험|연구에서|보고|용량|농도|목표치|역치|발생률|사망률)/i;
const CITE_RE = /\[\d{1,2}\]/;

// maxCite: 실제로 연결된 출처 수. 이보다 큰 번호(AI가 직접 쓴 번호 등)는 근거로 치지 않음
export const uncitedClaims = (text: string, maxCite?: number): string[] => {
    const hasCite = (t: string) => {
        if (maxCite === undefined) return CITE_RE.test(t);
        return Array.from(t.matchAll(/\[(\d{1,2})\]/g)).some(m => Number(m[1]) >= 1 && Number(m[1]) <= maxCite);
    };
    const out: string[] = [];
    let inCode = false;
    (text || '').split('\n').forEach(raw => {
        const line = raw.trim();
        if (/^```/.test(line)) { inCode = !inCode; return; }
        if (inCode || !line || /^#{1,6}\s/.test(line) || /^>\s*참고:/.test(line) || /^\|?\s*-{3,}/.test(line)) return;
        // 긴 문단은 문장 단위로 (번호는 보통 문장 끝에 붙음)
        const units = line.length > 160 ? line.split(/(?<=[.!?]|다\.)\s+/) : [line];
        units.forEach(u => {
            const t = u.replace(/^[-*]\s+|^\d+\.\s+/, '').trim();
            if (t.length < 12) return;
            // AI가 스스로 "(출처 미확인)"이라고 표시한 문장은 항상 포함
            if (t.includes('출처 미확인') || (FACT_RE.test(t) && !hasCite(t))) out.push(t);
        });
    });
    return out;
};
