// ============================================================================
// 결과지(검사 판독문, 기기 interrogation, 시술 기록 등) 붙여넣기 보조 유틸
// ----------------------------------------------------------------------------
// - 엑셀/EMR에서 복사한 표를 메모에서 읽기 좋은 형태로 변환
// - 메모가 "결과지 묶음"인지 대략 판별 (메모 상세화면의 정리 안내 카드용)
// 모두 순수 문자열 처리이며 API 호출은 없습니다.
// ============================================================================

// ----------------------------------------------------------------------------
// 탭 구분(TSV) 텍스트 → 2차원 배열
// 엑셀은 셀 안에 줄바꿈이 있으면 그 셀을 "..."로 감싸서 복사하므로 따옴표를 처리합니다.
// ----------------------------------------------------------------------------
// 엑셀 표시(HTML 메타정보) 없이 텍스트만 들어온 경우엔, 일반 글에 탭이 몇 개 섞인 것까지
// 표로 바꿔버리지 않도록 "대부분의 행이 같은 열 개수(2열 이상)"일 때만 표로 봅니다.
export const looksLikeTsv = (text: string): boolean => {
    if (!text || !text.includes('\t')) return false;
    const rows = parseTsv(text).filter(r => r.some(c => c.trim().length > 0));
    if (rows.length < 2) return false;
    const counts = new Map<number, number>();
    rows.forEach(r => counts.set(r.length, (counts.get(r.length) || 0) + 1));
    let modeCols = 0, modeFreq = 0;
    counts.forEach((freq, cols) => { if (freq > modeFreq) { modeFreq = freq; modeCols = cols; } });
    return modeCols >= 2 && modeFreq / rows.length >= 0.8;
};

// 셀 맨 앞의 " 가 진짜 엑셀식 따옴표 감싸기인지 확인: 닫는 " 바로 뒤가 탭/줄바꿈/끝이어야 함
const quotedCellEnd = (src: string, openIdx: number): number => {
    for (let i = openIdx + 1; i < src.length; i++) {
        if (src[i] !== '"') continue;
        if (src[i + 1] === '"') { i++; continue; }
        const after = src[i + 1];
        return after === undefined || after === '\t' || after === '\n' ? i : -1;
    }
    return -1;
};

export const parseTsv = (text: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    const src = text.replace(/\r\n?/g, '\n');

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i++; }
                else inQuotes = false;
            } else {
                cell += ch;
            }
            continue;
        }
        if (ch === '"' && cell === '' && quotedCellEnd(src, i) !== -1) { inQuotes = true; continue; }
        if (ch === '\t') { row.push(cell); cell = ''; continue; }
        if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
        cell += ch;
    }
    if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
};

// ----------------------------------------------------------------------------
// 2차원 표 → 마크다운
// - 셀이 짧으면 일반 마크다운 표
// - 판독문처럼 셀이 길거나 셀 안에 줄바꿈이 있으면, 표로 만들면 한 줄로 뭉개져 읽을 수
//   없으므로 "[1], [2] ..." 레코드 블록 형태로 바꾸고 셀 안의 줄바꿈을 그대로 살립니다.
// ----------------------------------------------------------------------------
const LONG_CELL_CHARS = 150;
const HEADER_MAX_CHARS = 40;

// options.allowRecords=false: 클로드 답변 등 일반 HTML 표는 레코드 블록으로 바꾸지 않고
// 항상 표로 유지(첫 행을 헤더로, 셀 안 줄바꿈은 <br>)합니다. 레코드 블록은 엑셀/시트 복사 전용.
export const gridToMarkdown = (rawGrid: string[][], options: { allowRecords?: boolean } = {}): string => {
    const allowRecords = options.allowRecords !== false;
    const grid = rawGrid
        .map(r => r.map(c => (c || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()))
        .filter(r => r.some(c => c.length > 0));
    if (grid.length === 0) return '';

    // 표 위에 붙은 제목/설명 줄(한 칸만 채워진 행)은 표 밖의 일반 텍스트로 뺍니다.
    const nonEmptyCount = (r: string[]) => r.filter(c => c.length > 0).length;
    const titleLines: string[] = [];
    if (allowRecords && grid.some(r => nonEmptyCount(r) >= 2)) {
        while (grid.length > 0 && nonEmptyCount(grid[0]) === 1) {
            titleLines.push(`**${grid[0].find(c => c.length > 0)}**`);
            grid.shift();
        }
    }
    const prefix = titleLines.length ? titleLines.join('\n\n') + '\n\n' : '';

    const colCount = Math.max(...grid.map(r => r.length));
    // 모든 행에서 비어 있는 열은 제거 (엑셀 복사 시 딸려오는 빈 열)
    const usedCols: number[] = [];
    for (let j = 0; j < colCount; j++) {
        if (grid.some(r => (r[j] || '').length > 0)) usedCols.push(j);
    }
    const norm = grid.map(r => usedCols.map(j => r[j] || ''));

    // 일반 HTML 표(클로드 답변 등): 항상 표 유지, 첫 행이 헤더, 셀 안 줄바꿈은 <br>
    if (!allowRecords) {
        const escCell = (c: string) => c.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
        const head = norm[0];
        return [
            '| ' + head.map(escCell).join(' | ') + ' |',
            '| ' + head.map(() => '---').join(' | ') + ' |',
            ...norm.slice(1).map(r => '| ' + r.map(escCell).join(' | ') + ' |'),
        ].join('\n');
    }

    const isLong = norm.some(r => r.some(c => c.length > LONG_CELL_CHARS || c.includes('\n')));
    const first = norm[0];
    const hasHeader = norm.length > 1 &&
        first.every(c => c.length > 0 && c.length <= HEADER_MAX_CHARS && !c.includes('\n'));

    // 한 열짜리 짧은 값들은 표보다 그냥 줄 단위 텍스트가 읽기 편함
    if (!isLong && usedCols.length === 1) {
        return prefix + norm.map(r => r[0]).join('\n');
    }

    if (!isLong) {
        const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
        const header = hasHeader ? first : usedCols.map((_, i) => `열${i + 1}`);
        const body = hasHeader ? norm.slice(1) : norm;
        const lines = [
            '| ' + header.map(esc).join(' | ') + ' |',
            '| ' + header.map(() => '---').join(' | ') + ' |',
            ...body.map(r => '| ' + r.map(esc).join(' | ') + ' |'),
        ];
        return prefix + lines.join('\n');
    }

    const header = hasHeader ? first : null;
    const body = hasHeader ? norm.slice(1) : norm;
    // 판독문의 들여쓰기(공백)는 마크다운에서 "코드 블록"으로 잘못 해석될 수 있어,
    // 줄 앞 공백을 줄바꿈 없는 공백(NBSP)으로 바꿔 모양만 그대로 유지합니다.
    const keepIndent = (text: string) => text.replace(/^[ \t]+/gm, ws => '\u00a0'.repeat(ws.replace(/\t/g, '  ').length));
    const blocks = body.map((r, i) => {
        const parts: string[] = [];
        r.map(keepIndent).forEach((c, j) => {
            if (!c) return;
            const label = header ? header[j] : '';
            if (!label) { parts.push(c); return; }
            parts.push(c.includes('\n') || c.length > 60 ? `**${label}**\n${c}` : `**${label}**: ${c}`);
        });
        return `**[${i + 1}]**\n\n${parts.join('\n\n')}`;
    });
    return prefix + blocks.join('\n\n---\n\n');
};

// 결과지를 여러 번 나눠 붙여넣어도 [1], [2] ... 번호가 겹치지 않도록, 새로 붙여넣는
// 블록 번호를 기존 메모의 마지막 번호 다음부터 이어지게 조정합니다.
const RECORD_HEADER_REGEX = /^\*\*\[(\d+)\]\*\*[ \t]*$/gm;
export const continueRecordNumbering = (existingText: string, newText: string): string => {
    let max = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(RECORD_HEADER_REGEX.source, 'gm');
    while ((m = re.exec(existingText)) !== null) max = Math.max(max, Number(m[1]));
    if (max === 0) return newText;
    return newText.replace(new RegExp(RECORD_HEADER_REGEX.source, 'gm'), (_all, n: string) => `**[${Number(n) + max}]**`);
};

// ----------------------------------------------------------------------------
// 메모에 검사 판독문·시술 기록·의무기록 같은 "비슷한 형식의 기록"이 여러 건 붙여넣어져
// 있는지 대략 추정합니다 (메모 상세화면의 "묘사·표현 패턴 정리" 안내 카드용).
// 엑셀 형태든, EMR에서 그대로 복사한 글이든 형식과 무관하게 동작하도록:
//   같은 항목 이름으로 시작하는 줄(예: "Tricuspid valve:", "Lead measurement",
//   "1. Clinical diagnosis")이 여러 번 반복되면 → 비슷한 기록이 그만큼 있다고 봅니다.
// 실제로 어떻게 정리할지는 AI 요약 프롬프트가 내용을 보고 다시 판단하므로 대략이면 충분.
// ----------------------------------------------------------------------------
export const estimateDataRecordCount = (content: string): number => {
    if (!content || content.length < 1200) return 0;

    // 1) 붙여넣기 변환으로 생긴 [1], [2] 레코드 블록
    const recordBlocks = (content.match(/^\*\*\[\d+\]\*\*[ \t]*$/gm) || []).length;

    // 2) 반복되는 "항목 이름" 줄: 줄 앞부분(번호·날짜·수치 제거)을 기준으로 가장 많이 반복된 횟수
    //    (표 줄, 링크 줄, 글자가 없는 줄은 제외 — 일반 메모의 표/링크 목록이 기록으로 오인되지 않도록)
    const counts = new Map<string, number>();
    const lines = content.split(/\r?\n/);
    lines.forEach(line => {
        const trimmed = line.replace(/^[\s\u00a0>*#\-•·]+/, '');
        if (trimmed.startsWith('|') || /^(https?:\/\/|www\.)/i.test(trimmed)) return;
        const key = trimmed
            .replace(/[\d.,:;()\[\]\/~%+\-]+/g, ' ') // 숫자·날짜·기호
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 24)
            .toLowerCase();
        if (key.length < 6 || !/[a-z가-힣]{3,}/.test(key)) return;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    let repeatedLabel = 0;
    counts.forEach(n => { if (n > repeatedLabel) repeatedLabel = n; });

    // 3) 가장 큰 마크다운 표 하나의 행 수 (여러 표를 합산하지 않음)
    let largestTable = 0, currentTable = 0;
    lines.forEach(line => {
        if (/^\s*\|.*\|\s*$/.test(line)) { currentTable++; largestTable = Math.max(largestTable, currentTable); }
        else currentTable = 0;
    });
    const tableRows = Math.max(0, largestTable - 2);

    return Math.max(recordBlocks, repeatedLabel >= 3 ? repeatedLabel : 0, tableRows >= 15 ? tableRows : 0);
};
