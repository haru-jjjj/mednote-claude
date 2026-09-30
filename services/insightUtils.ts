// ============================================================================
// "메모 활용" 화면용 계산 (API 호출 없음)
// - 비슷한 메모 묶기: 저장된 임베딩끼리 코사인 유사도로 묶음
// - 케이스·시술 기록: AI가 메모별로 뽑은 항목을 코드로 세어 표로 만듦 (숫자는 AI가 아니라 코드가 셈)
// ============================================================================
import type { Note } from '../types';

export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 비슷한 메모 묶기
// 방식: "기준 메모 + 그 메모와 충분히 비슷한 메모들"로 묶습니다(연쇄로 끝없이 커지지 않도록).
// 이웃이 많은 메모부터 기준으로 삼고, 이미 묶인 메모는 다시 쓰지 않습니다.
// ---------------------------------------------------------------------------
export interface NoteGroup {
    key: string; // 묶음 식별자 (정렬된 id 목록)
    seedId: string;
    noteIds: string[];
    avgSim: number;
}

const normalize = (v: number[]): Float32Array | null => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    if (s === 0) return null;
    const inv = 1 / Math.sqrt(s);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
    return out;
};

const dot = (a: Float32Array, b: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
};

export const groupKey = (ids: string[]) => [...ids].sort().join('|');

// 메모가 많아도 화면이 멈추지 않도록 중간중간 쉬어가며 계산 (onProgress: 0~1)
export const findSimilarNoteGroups = async (
    notes: Note[],
    threshold: number,
    opts: { maxGroupSize?: number; onProgress?: (p: number) => void; yieldEvery?: number } = {}
): Promise<NoteGroup[]> => {
    const maxSize = opts.maxGroupSize ?? 10;
    const yieldEvery = opts.yieldEvery ?? 40;
    const items = notes
        .filter(n => n.embedding && n.embedding.length > 0)
        .map(n => ({ id: n.id, v: normalize(n.embedding as number[]) }))
        .filter((x): x is { id: string; v: Float32Array } => !!x.v);
    const dim = items.length > 0 ? items[0].v.length : 0;
    const valid = items.filter(x => x.v.length === dim);
    const n = valid.length;

    // 이웃 목록 (유사도 ≥ threshold)
    const neighbors: { j: number; sim: number }[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const sim = dot(valid[i].v, valid[j].v);
            if (sim >= threshold) {
                neighbors[i].push({ j, sim });
                neighbors[j].push({ j: i, sim });
            }
        }
        if (i % yieldEvery === yieldEvery - 1) {
            // 앞쪽 행일수록 비교할 쌍이 많아서, 실제 계산량 기준으로 진행률 표시
            const done = (i + 1) * n - ((i + 1) * (i + 2)) / 2;
            opts.onProgress?.(done / Math.max(1, (n * (n - 1)) / 2));
            await new Promise(r => setTimeout(r, 0));
        }
    }
    opts.onProgress?.(1);

    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => neighbors[b].length - neighbors[a].length);
    const used = new Set<number>();
    const groups: NoteGroup[] = [];
    for (const seed of order) {
        if (used.has(seed) || neighbors[seed].length === 0) continue;
        const members = neighbors[seed]
            .filter(x => !used.has(x.j))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, maxSize - 1);
        if (members.length === 0) continue;
        used.add(seed);
        members.forEach(m => used.add(m.j));
        const ids = [valid[seed].id, ...members.map(m => valid[m.j].id)];
        groups.push({
            key: groupKey(ids),
            seedId: valid[seed].id,
            noteIds: ids,
            avgSim: members.reduce((s, m) => s + m.sim, 0) / members.length
        });
    }
    return groups.sort((a, b) => b.noteIds.length - a.noteIds.length || b.avgSim - a.avgSim);
};

// ---------------------------------------------------------------------------
// 기간
// ---------------------------------------------------------------------------
export const notesInLastDays = (notes: Note[], days: number, now: number): Note[] => {
    const since = now - days * DAY_MS;
    return notes.filter(n => (n.createdAt || 0) >= since || (n.updatedAt || 0) >= since);
};

// ---------------------------------------------------------------------------
// 케이스·시술 기록 집계
// ---------------------------------------------------------------------------
export interface CaseExtract {
    noteId: string;
    procedures: string[];
    diagnoses: string[];
    memorable: boolean;
    learningPoint: string;
}

// 대소문자·공백·괄호 앞뒤 공백 차이만 정리해서 같은 이름으로 셈
export const canonicalLabel = (s: string): string =>
    (s || '').replace(/\s+/g, ' ').replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')').trim();

export const countLabels = (lists: { noteId: string; labels: string[] }[]): { label: string; count: number; noteIds: string[] }[] => {
    const map = new Map<string, { label: string; count: number; noteIds: string[] }>();
    lists.forEach(({ noteId, labels }) => {
        const seen = new Set<string>();
        labels.forEach(raw => {
            const label = canonicalLabel(raw);
            if (!label) return;
            const key = label.toLowerCase();
            if (seen.has(key)) return; // 한 메모에서 같은 항목은 한 번만
            seen.add(key);
            const cur = map.get(key) || { label, count: 0, noteIds: [] };
            cur.count += 1;
            cur.noteIds.push(noteId);
            map.set(key, cur);
        });
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

// 표를 마크다운으로. 메모 번호는 refIndex(noteId → 1부터)로 [메모N] 표시 (많으면 앞 5개만)
export const buildCaseLogMarkdown = (
    extracts: CaseExtract[],
    refIndex: Map<string, number>,
    periodLabel: string,
    totalNotes: number,
    analyzedNotes: number
): string => {
    const cite = (ids: string[]) => {
        const nums = ids.map(id => refIndex.get(id)).filter((x): x is number => typeof x === 'number');
        const shown = nums.slice(0, 5).map(n => `[메모${n}]`).join('');
        return nums.length > 5 ? `${shown} 외 ${nums.length - 5}` : shown;
    };
    const esc = (s: string) => s.replace(/\|/g, '/');
    const procs = countLabels(extracts.map(e => ({ noteId: e.noteId, labels: e.procedures })));
    const dx = countLabels(extracts.map(e => ({ noteId: e.noteId, labels: e.diagnoses })));
    const lines: string[] = [];
    lines.push(`**기간**: ${periodLabel} · 환자 메모 ${totalNotes}개${analyzedNotes < totalNotes ? ` 중 최근 ${analyzedNotes}개 분석` : ''}`);
    lines.push('');
    lines.push('### 시술');
    if (procs.length === 0) {
        lines.push('- 메모에서 시술 기록을 찾지 못했습니다.');
    } else {
        lines.push(`총 ${procs.reduce((s, p) => s + p.count, 0)}건 (메모 기준)`);
        lines.push('');
        lines.push('| 시술 | 건수 | 메모 |');
        lines.push('|---|---|---|');
        procs.forEach(p => lines.push(`| ${esc(p.label)} | ${p.count} | ${cite(p.noteIds)} |`));
    }
    lines.push('');
    lines.push('### 주요 진단');
    if (dx.length === 0) {
        lines.push('- 진단을 찾지 못했습니다.');
    } else {
        lines.push('| 진단 | 메모 수 | 메모 |');
        lines.push('|---|---|---|');
        dx.slice(0, 25).forEach(d => lines.push(`| ${esc(d.label)} | ${d.count} | ${cite(d.noteIds)} |`));
        if (dx.length > 25) lines.push(`\n(그 외 ${dx.length - 25}개 진단)`);
    }
    const memorable = extracts.filter(e => e.memorable && e.learningPoint);
    lines.push('');
    lines.push('### 기억할 케이스');
    if (memorable.length === 0) {
        lines.push('- 따로 표시할 만한 케이스를 찾지 못했습니다.');
    } else {
        memorable.forEach(e => lines.push(`- ${cite([e.noteId])} ${e.learningPoint}`));
    }
    lines.push('');
    lines.push('> 건수는 AI가 각 메모에서 뽑은 시술·진단 이름을 앱이 메모 단위로 센 값입니다(같은 환자 메모가 여러 개면 여러 번 셉니다). 메모에 적지 않은 시술은 빠지고, 같은 시술이 다른 이름으로 적혀 있으면 따로 셀 수 있으니 공식 기록은 원본을 확인하세요.');
    return lines.join('\n');
};

// ---------------------------------------------------------------------------
// AI 요약을 메모 내용으로 옮기기: 요약을 위에, 원래 메모는 접을 수 있는 블록으로 아래에 보관
// - 이미 한 번 옮긴 메모면 원래 메모 블록은 그대로 두고 위쪽 요약만 바꿈(중첩 방지)
// ---------------------------------------------------------------------------
export const ORIGINAL_MARKER = '<!-- medinote:original -->';

export const splitMovedContent = (content: string): { top: string; originalBlock: string | null } => {
    const i = (content || '').indexOf(ORIGINAL_MARKER);
    if (i < 0) return { top: content || '', originalBlock: null };
    return { top: content.slice(0, i).trimEnd(), originalBlock: content.slice(i) };
};

const PREV_START = '<!-- medinote:prev -->';
const PREV_END = '<!-- /medinote:prev -->';

// 링크 주소 안의 _ $ ^ ~ 공백 괄호가 의학 표기 변환(아래첨자 등)이나 마크다운에 깨지지 않도록 인코딩
const safeUri = (uri: string) => uri.replace(/[_$^~ ()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

// AI 요약은 원래 "줄바꿈 무시" 방식으로 보여주던 글이라, 메모 본문(줄바꿈 그대로 표시)에 넣기 전에
// 문단 중간의 단순 줄바꿈만 이어 붙임 (목록·표·제목·인용·코드 블록 줄은 그대로)
export const joinSoftBreaks = (md: string): string =>
    (md || '').split(/(```[\s\S]*?```)/g).map((part, i) => i % 2 === 1 ? part :
        part.replace(/([^\n])\n(?!\n|[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|#|\||>|<))/g, '$1 ')
    ).join('');

export const buildContentWithSummary = (
    content: string,
    summary: string,
    sources: { title: string; uri: string }[],
    label: string
): string => {
    const src = (sources || []).filter(s => s && s.uri)
        .map(s => `- [${(s.title || s.uri).replace(/[[\]]/g, '')}](${safeUri(s.uri)})`).join('\n');
    const top = [joinSoftBreaks(summary.trim()), src ? `**출처**\n\n${src}` : ''].filter(Boolean).join('\n\n');
    const { top: prevTop, originalBlock } = splitMovedContent(content);
    let block: string;
    if (originalBlock) {
        // 다시 옮기는 경우:
        // - 접힌 블록 아래에 새로 적은 기록은 새 요약이 반영하므로 접힌 블록 안으로 합침
        // - 지금 맨 위에 있던 요약(직접 덧붙인 내용 포함)은 버리지 않고 접힌 블록 안 "이전에 옮긴 요약"으로 보관
        let kept = originalBlock;
        const end = kept.lastIndexOf('</details>');
        const trailing = end >= 0 ? kept.slice(end + '</details>'.length).trim() : '';
        let inner = end >= 0 ? kept.slice(0, end).trimEnd() : kept.trimEnd();
        if (trailing) inner += `\n\n${trailing}`;
        if (prevTop.trim()) inner += `\n\n${PREV_START}\n**이전에 옮긴 요약 (${new Date().toLocaleDateString()}에 새 요약으로 교체)**\n\n${prevTop.trim()}\n${PREV_END}`;
        inner = inner.replace(/<summary>[^<]*<\/summary>/, `<summary>${label}</summary>`);
        block = end >= 0 ? `${inner}\n\n</details>` : inner;
    } else {
        block = [
            ORIGINAL_MARKER,
            '<details>',
            `<summary>${label}</summary>`,
            '',
            (content || '').trim(),
            '',
            '</details>'
        ].join('\n');
    }
    return `${top}\n\n${block}\n`;
};

// AI 분석(요약·저널클럽·가이드라인 점검)에 보낼 내용: 요약을 옮긴 메모면 위쪽 요약과 "이전 요약"은 빼고
// 원래 기록만 (예전 결론이 다시 근거처럼 쓰이지 않도록)
export const contentForAnalysis = (content: string): string => {
    const { originalBlock } = splitMovedContent(content || '');
    if (!originalBlock) return content || '';
    return originalBlock
        .replace(new RegExp(`${PREV_START}[\\s\\S]*?${PREV_END}`, 'g'), '')
        .replace(ORIGINAL_MARKER, '')
        .replace(/<summary>[^<]*<\/summary>/g, '')
        .replace(/<\/?details>/g, '')
        .trim();
};

// ---------------------------------------------------------------------------
// 환자 팔로업
// ---------------------------------------------------------------------------
export const FOLLOWUP_INTERVALS = [3, 7, 14, 30];
export const DEFAULT_FOLLOWUP_DAYS = 7;

export type FollowUpStatus = 'due' | 'updated' | 'ok';

// due: 확인한 적 없음 / 다음 확인일이 됨 · updated: 확인 뒤 기록이 추가·수정됨 · ok: 그 외
export const followUpStatus = (n: Note, now: number): FollowUpStatus => {
    if (!n.followUpCheckedAt) return 'due';
    if (typeof n.followUpDueAt === 'number' && n.followUpDueAt <= now) return 'due';
    if ((n.updatedAt || 0) > n.followUpCheckedAt) return 'updated';
    return 'ok';
};

// 케이스 분석 글: 요약 칸, 없으면 메모 내용으로 옮긴 요약(원래 메모 블록 앞부분)
export const analysisTextOf = (n: Note): string => {
    if (n.summary) return n.summary;
    const { top, originalBlock } = splitMovedContent(n.content || '');
    return originalBlock ? top : '';
};

// "### 추가 공부" 같은 섹션 본문만 꺼내기 (다음 ### 전까지)
export const extractSection = (markdown: string, heading: string): string => {
    const lines = (markdown || '').split('\n');
    const start = lines.findIndex(l => /^#{2,4}\s*/.test(l) && l.replace(/^#{2,4}\s*/, '').trim().startsWith(heading));
    if (start < 0) return '';
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^#{2,4}\s/.test(lines[i])) break;
        out.push(lines[i]);
    }
    return out.join('\n').trim();
};
