// ============================================================================
// 출처 종류 표시 (§5-67): 참고 문헌 주소(도메인)와 제목으로 자료 종류를 자동 분류
// - 가이드라인 / 학회 / 학술지 / 허가·규제(FDA 라벨 등) / 임상시험 등록 / 참고서 / 프리프린트 / 기타 사이트
// - 주소만 보고 판단하는 단순 규칙이라 "그 자료가 믿을 만하다"는 보증이 아님. 한눈에 걸러 보기 위한 표시
// ============================================================================
import type { Source } from '../types';

export type SourceKind = 'guideline' | 'society' | 'journal' | 'label' | 'registry' | 'reference' | 'preprint' | 'other';

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
    guideline: '가이드라인',
    society: '학회',
    journal: '학술지',
    label: '허가·규제',
    registry: '임상시험 등록',
    reference: '참고서',
    preprint: '프리프린트',
    other: '기타 사이트',
};

// 화면 표시 순서 (요약 줄)
export const SOURCE_KIND_ORDER: SourceKind[] = ['guideline', 'journal', 'society', 'label', 'registry', 'reference', 'preprint', 'other'];

// 1차 근거로 볼 수 있는 종류 (가이드라인·학회·학술지·허가·규제·임상시험 등록)
export const isPrimaryKind = (k: SourceKind) => k === 'guideline' || k === 'society' || k === 'journal' || k === 'label' || k === 'registry';

// 배지 색: 1차 근거 = 강조색(가이드라인은 진하게), 참고서 = 회색, 프리프린트·기타 = 주의색
export const sourceKindClass = (k: SourceKind): string => {
    if (k === 'guideline') return 'bg-accent-100 text-accent-800 border-accent-200';
    if (isPrimaryKind(k)) return 'bg-accent-50 text-accent-700 border-accent-100';
    if (k === 'reference') return 'bg-slate-100 text-slate-600 border-slate-200';
    return 'bg-warn-50 text-warn-700 border-warn-200';
};

const REGISTRY = ['clinicaltrials.gov', 'isrctn.com', 'clinicaltrialsregister.eu', 'cris.nih.go.kr', 'anzctr.org.au', 'chictr.org.cn'];
const LABEL = ['fda.gov', 'dailymed.nlm.nih.gov', 'ema.europa.eu', 'mfds.go.kr', 'medicines.org.uk', 'pmda.go.jp', 'tga.gov.au', 'canada.ca'];
const PREPRINT = ['medrxiv.org', 'biorxiv.org', 'arxiv.org', 'ssrn.com', 'researchsquare.com', 'preprints.org'];
const REFERENCE = [
    'uptodate.com', 'medscape.com', 'msdmanuals.com', 'merckmanuals.com', 'bestpractice.bmj.com', 'dynamed.com',
    'radiopaedia.org', 'litfl.com', 'ecgwaves.com', 'amboss.com', 'accessmedicine.mhmedical.com', 'clinicalkey.com', 'statpearls.com',
];
// 학회·공공기관 (가이드라인을 내는 곳)
const SOCIETY = [
    'escardio.org', 'acc.org', 'heart.org', 'hrsonline.org', 'scai.org', 'asecho.org', 'hfsa.org', 'aats.org', 'sts.org',
    'ehra.org', 'eapci.org', 'pcronline.com', 'circulation.or.kr', 'nice.org.uk', 'sign.ac.uk', 'kdigo.org', 'idsociety.org',
    'who.int', 'cdc.gov', 'ahrq.gov', 'diabetes.org', 'kidney.org', 'thoracic.org', 'chestnet.org', 'esh.org', 'eas-society.org',
];
const JOURNAL = [
    'nejm.org', 'thelancet.com', 'jamanetwork.com', 'ahajournals.org', 'jacc.org', 'onlinejacc.org', 'academic.oup.com',
    'bmj.com', 'nature.com', 'sciencedirect.com', 'springer.com', 'wiley.com', 'tandfonline.com', 'karger.com',
    'europepmc.org', 'pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'cochranelibrary.com', 'heartrhythmjournal.com',
    'jscai.org', 'acpjournals.org', 'lww.com', 'frontiersin.org', 'mdpi.com', 'plos.org', 'e-kcj.org', 'cell.com',
    'diabetesjournals.org', 'jhltonline.org', 'ccjm.org', 'sagepub.com', 'cambridge.org', 'thieme-connect.com',
    'dovepress.com', 'cureus.com', 'hindawi.com', 'internationaljournalofcardiology.com', 'atsjournals.org', 'chestjournal.org',
    'annals.org',
];

// 제목이 가이드라인·합의문 형태인지 (학술지·학회 자료에만 적용 — 뉴스·블로그의 "가이드라인 소개"는 올리지 않음)
const GUIDE_RE = /\bguidelines?\b|consensus (?:statement|document|report)|expert consensus|scientific statement|position (?:paper|statement)|focused update|appropriate use criteria|clinical practice update|recommendations? for|가이드라인|진료\s?지침|권고안/i;

const SUMMARY_RE = /key points|points to remember|top (?:10|ten)|journal scan|highlights|news|요약/i;

const hostOf = (uri: string): string => {
    try { return new URL(uri).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const matches = (host: string, list: string[]) => list.some(d => host === d || host.endsWith('.' + d));

export const sourceKindOf = (s: Pick<Source, 'uri' | 'title'>): SourceKind => {
    const host = hostOf(s.uri || '');
    if (!host) return 'other';
    let path = '';
    try { path = new URL(s.uri).pathname.toLowerCase(); } catch { /* 위에서 확인함 */ }
    const title = s.title || '';
    if (matches(host, REGISTRY)) return 'registry';
    if (matches(host, LABEL)) return 'label';
    if (matches(host, PREPRINT)) return 'preprint';
    // NCBI: 책(StatPearls 등) = 참고서, PMC·PubMed = 학술지
    if (host === 'ncbi.nlm.nih.gov') {
        if (path.startsWith('/books')) return 'reference';
        if (path.startsWith('/pmc') || path.startsWith('/pubmed')) return GUIDE_RE.test(title) ? 'guideline' : 'journal';
        return 'other';
    }
    if (matches(host, REFERENCE)) return 'reference';
    // 학회 사이트의 "Key Points"·"Ten Points to Remember"·저널 스캔은 가이드라인 요약(2차 자료)이라 '학회'로
    if (matches(host, SOCIETY)) return GUIDE_RE.test(title) && !SUMMARY_RE.test(title) ? 'guideline' : 'society';
    if (matches(host, JOURNAL)) return GUIDE_RE.test(title) ? 'guideline' : 'journal';
    return 'other';
};

// 종류별 개수 (표시 순서대로, 0개는 뺌)
export const summarizeSourceKinds = (sources: Pick<Source, 'uri' | 'title'>[]): { kind: SourceKind; count: number }[] => {
    const counts = new Map<SourceKind, number>();
    sources.forEach(s => { const k = sourceKindOf(s); counts.set(k, (counts.get(k) || 0) + 1); });
    return SOURCE_KIND_ORDER.filter(k => counts.has(k)).map(k => ({ kind: k, count: counts.get(k)! }));
};
