// ============================================================================
// 메모 본문의 제목(#, ##, ###)을 접었다 펼 수 있는 구역으로 바꾸기 (보기 화면 전용, 저장 내용은 그대로)
// - 제목부터 같은/상위 단계의 다음 제목 전까지가 한 구역.
// - 날짜 제목(예: "## 2026.09.30 (화)", "### 9/30 외래")이 3개 이상이면, 가장 최근 날짜만 펼치고
//   나머지는 접은 상태로 시작합니다(환자 메모 경과 보기용).
// ============================================================================

export interface SectionizeResult {
    html: string;
    sectionCount: number;
    dateSectionCount: number;
}

// 제목 글자에서 날짜 찾기 → 비교용 숫자(연도 없으면 null 연도)
export const parseHeadingDate = (text: string): { y: number | null; m: number; d: number } | null => {
    const t = (text || '').trim();
    let m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(t);
    if (m) {
        const mo = +m[2], da = +m[3];
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return { y: +m[1], m: mo, d: da };
    }
    // 연도 없는 형식: 9/30, 9.30, 09-30, 9월 30일 (제목 앞부분에 있을 때만 날짜로 인정)
    m = /^[^\d]{0,4}(\d{1,2})\s*([./\-]|월\s*)(\d{1,2})(?!\d)/.exec(t);
    if (m) {
        const mo = +m[1], da = +m[3];
        const rest = t.slice(m.index + m[0].length);
        // "3.5 mm", "2.5 mg" 같은 소수·수치는 날짜로 보지 않음
        const looksDecimal = m[2] === '.' && m[1].length === 1 && m[3].length === 1;
        const hasUnit = /^\s*(mm|mg|mcg|cm|ml|%|kg|g\b|L\b|mmHg|ms|mV|V\b|J\b|배|회|개)/i.test(rest);
        if (!looksDecimal && !hasUnit && mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return { y: null, m: mo, d: da };
    }
    // 2자리 연도: 26.09.30
    m = /^[^\d]{0,4}(\d{2})\.(\d{1,2})\.(\d{1,2})(?!\d)/.exec(t);
    if (m) {
        const mo = +m[2], da = +m[3];
        if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return { y: 2000 + +m[1], m: mo, d: da };
    }
    return null;
};

export const sectionizeHtml = (html: string): SectionizeResult => {
    if (typeof DOMParser === 'undefined' || !/<h[1-3][\s>]/i.test(html || '')) {
        return { html, sectionCount: 0, dateSectionCount: 0 };
    }
    const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
    const root = doc.getElementById('root');
    if (!root) return { html, sectionCount: 0, dateSectionCount: 0 };

    type Dated = { details: Element; date: { y: number | null; m: number; d: number }; order: number };
    let sectionCount = 0;
    let dateSectionCount = 0;

    // 가장 최근 날짜 구역만 펼침 (한 묶음 안에서 날짜 구역이 3개 이상일 때)
    const collapseOlder = (dated: Dated[]) => {
        if (dated.length < 3) return;
        const allHaveYear = dated.every(x => x.date.y !== null);
        const key = (x: Dated) => allHaveYear ? (x.date.y as number) * 10000 + x.date.m * 100 + x.date.d : x.order;
        const latest = dated.reduce((a, b) => (key(b) >= key(a) ? b : a));
        dated.forEach(x => { if (x !== latest) x.details.removeAttribute('open'); });
    };

    // nodes를 target 안에 제목별 구역으로 다시 배치
    const build = (nodes: ChildNode[], target: Element) => {
        const stack: { level: number; el: Element }[] = [{ level: 0, el: target }];
        const dated: Dated[] = [];
        nodes.forEach(node => {
            const el = node as Element;
            const tag = node.nodeType === 1 ? el.tagName : '';
            // "메모 내용으로 저장"으로 생긴 "원래 메모 보기" 블록: 마지막 구역에 딸려 들어가지 않게 맨 바깥에 두고,
            // 그 안의 제목들도 따로 접기/펼치기 구역으로 만듦
            if (tag === 'DETAILS') {
                stack.length = 1;
                target.appendChild(node);
                const inner = Array.from(el.childNodes).filter(c => !(c.nodeType === 1 && (c as Element).tagName === 'SUMMARY'));
                inner.forEach(c => el.removeChild(c));
                build(inner, el);
                return;
            }
            const match = /^H([1-3])$/.exec(tag);
            if (!match) {
                stack[stack.length - 1].el.appendChild(node);
                return;
            }
            const level = +match[1];
            while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();

            const details = doc.createElement('details');
            details.setAttribute('open', '');
            details.className = `md-section md-l${level}`;
            const summary = doc.createElement('summary');
            summary.appendChild(node); // 제목 요소를 그대로 summary 안으로 (글자 모양 유지)
            details.appendChild(summary);
            const body = doc.createElement('div');
            body.className = 'md-section-body';
            details.appendChild(body);
            stack[stack.length - 1].el.appendChild(details);
            stack.push({ level, el: body });
            sectionCount++;

            const date = parseHeadingDate(el.textContent || '');
            if (date) {
                details.className += ' md-date';
                dated.push({ details, date, order: dated.length });
                dateSectionCount++;
            }
        });
        collapseOlder(dated);
    };

    const out = doc.createElement('div');
    build(Array.from(root.childNodes), out);

    return { html: out.innerHTML, sectionCount, dateSectionCount };
};

// 오늘 날짜 제목 (예: "2026.09.30 (수)")
export const todayHeadingText = (d = new Date()): string => {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} (${days[d.getDay()]})`;
};
