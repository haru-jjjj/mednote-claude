// ============================================================================
// 인계장 부분 갱신: AI가 인계장 전체를 다시 쓰지 않고 "바뀐 ## 구역만" 돌려주면 앱이 끼워 넣음
// (전체를 매번 다시 쓰면 인계장이 길어질수록 응답 한도에 걸림 — 한국어는 글자당 토큰이 많음)
// ============================================================================

export interface TopSection {
    title: string; // "## " 뒤의 제목 (앞부분 머리글은 '')
    text: string;  // 제목 줄 포함 전체
}

const norm = (t: string) => t.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// "## " 제목 기준으로 나눔 (### 이하는 그 구역에 포함). 코드 블록 안의 ##은 무시
export const splitTopSections = (md: string): { preamble: string; sections: TopSection[] } => {
    const lines = (md || '').split('\n');
    const sections: TopSection[] = [];
    let preamble: string[] = [];
    let cur: { title: string; lines: string[] } | null = null;
    let inCode = false;
    for (const line of lines) {
        if (/^\s*```/.test(line)) inCode = !inCode;
        const m = !inCode && /^##\s+(.+?)\s*#*\s*$/.exec(line);
        if (m && !line.startsWith('###')) {
            if (cur) sections.push({ title: cur.title, text: cur.lines.join('\n').trimEnd() });
            cur = { title: m[1].trim(), lines: [line] };
        } else if (cur) {
            cur.lines.push(line);
        } else {
            preamble.push(line);
        }
    }
    if (cur) sections.push({ title: cur.title, text: cur.lines.join('\n').trimEnd() });
    return { preamble: preamble.join('\n').trim(), sections };
};

export const joinTopSections = (preamble: string, sections: TopSection[]): string =>
    [preamble.trim(), ...sections.map(s => s.text.trim())].filter(Boolean).join('\n\n') + '\n';

const SECTION_BLOCK_RE = /@@@SECTION[^\n]*\n([\s\S]*?)\n?@@@END/g;
const DELETE_RE = /^@@@DELETE\s+(?:##\s*)?(.+?)\s*$/gm;

// AI 출력(바뀐 구역들)을 현재 인계장에 적용. 형식이 전혀 없으면 null
export const applySectionPatch = (current: string, output: string): { doc: string; changed: number } | null => {
    const blocks: TopSection[] = [];
    let m: RegExpExecArray | null;
    SECTION_BLOCK_RE.lastIndex = 0;
    while ((m = SECTION_BLOCK_RE.exec(output)) !== null) {
        const body = m[1].trim();
        // 한 블록 안에 ## 구역이 여러 개 들어 있어도 각각 처리
        const parsed = splitTopSections(body);
        parsed.sections.forEach(s => blocks.push(s));
    }
    const deletes: string[] = [];
    DELETE_RE.lastIndex = 0;
    while ((m = DELETE_RE.exec(output)) !== null) deletes.push(m[1]);
    if (blocks.length === 0 && deletes.length === 0) return null;

    const { preamble, sections } = splitTopSections(current);
    let result = [...sections];
    deletes.forEach(t => { result = result.filter(s => norm(s.title) !== norm(t)); });
    blocks.forEach(b => {
        const idx = result.findIndex(s => norm(s.title) === norm(b.title));
        if (idx >= 0) {
            result[idx] = b;
        } else {
            // 새 구역: "확인 필요" 앞에 (없으면 맨 끝). "한눈에"는 맨 앞
            if (norm(b.title).startsWith('한눈에')) { result.unshift(b); return; }
            const checkIdx = result.findIndex(s => norm(s.title).startsWith('확인 필요'));
            if (checkIdx >= 0) result.splice(checkIdx, 0, b); else result.push(b);
        }
    });
    return { doc: joinTopSections(preamble, result), changed: blocks.length + deletes.length };
};
