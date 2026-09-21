import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
    ArrowLeft, GitBranch, ZoomIn, ZoomOut, Maximize2, Info,
    List, ChevronRight, ChevronDown, Folder, FolderOpen, Tag, FileText,
    Sparkles, Loader2, AlertTriangle
} from 'lucide-react';
import { Note } from '../types';
import { cosineSimilarity } from '../services/voyageService';
import { generateNoteTaxonomyLabels, TaxonomyClusterInput } from '../services/claudeService';

interface MindMapViewProps {
    notes: Note[];
    onBack: () => void;
    onSelectNote: (id: string) => void;
}

// ============================================================================
// 공통: 너무 많은 메모가 한꺼번에 있을 때 연산량이 과해지지 않도록 상한을 둠
// ============================================================================
const MAX_NODES = 400;

// ============================================================================
// 그래프(마인드맵) 뷰
// ============================================================================
interface GraphNode {
    id: string;
    title: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx: number | null; // 드래그/고정 중인 x (null이면 물리 시뮬레이션이 위치를 계산)
    fy: number | null;
    degree: number;
}

interface GraphEdge {
    source: string;
    target: string;
    sim: number;
}

const KNN_K = 4;
const SIM_THRESHOLD = 0.35;
const IDEAL_DISTANCE = 130;
const REPULSION = 2600;
const SPRING_K = 0.02;
const CENTER_K = 0.012;
const DAMPING = 0.82;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// ============================================================================
// 목차(계층형 분류) 뷰용 유틸: 구면 k-means (코사인 유사도 기반)
// 외부 라이브러리 없이 순수 TypeScript로 구현 (이 환경에서 npm install 검증이
// 불가능해 새 의존성을 늘리지 않기 위한 선택 — 마인드맵 그래프와 동일한 원칙)
// ============================================================================
const normalizeVec = (v: number[]): number[] => {
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    return v.map(x => x / norm);
};

const dot = (a: number[], b: number[]): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
};

// 코사인 거리를 기준으로 하는 k-means(spherical k-means). 벡터는 미리 정규화되어 있어야 함.
const kmeansCluster = (vectors: number[][], k: number, maxIter = 30): number[] => {
    const n = vectors.length;
    if (n === 0) return [];
    if (k >= n) return vectors.map((_, i) => i);
    if (k <= 1) return vectors.map(() => 0);

    // k-means++ 스타일 초기화 (첫 중심은 무작위, 이후엔 기존 중심과 먼 점을 우선 선택)
    const centroids: number[][] = [];
    centroids.push(vectors[Math.floor(Math.random() * n)].slice());
    while (centroids.length < k) {
        const dists = vectors.map(v => {
            let minD = Infinity;
            for (const c of centroids) {
                const d = 1 - dot(v, c);
                if (d < minD) minD = d;
            }
            return Math.max(minD, 0);
        });
        const sum = dists.reduce((a, b) => a + b, 0) || 1;
        let r = Math.random() * sum;
        let chosen = n - 1;
        for (let i = 0; i < dists.length; i++) {
            r -= dists[i];
            if (r <= 0) { chosen = i; break; }
        }
        centroids.push(vectors[chosen].slice());
    }

    let assignments = new Array(n).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
            let best = 0, bestSim = -Infinity;
            for (let c = 0; c < k; c++) {
                const sim = dot(vectors[i], centroids[c]);
                if (sim > bestSim) { bestSim = sim; best = c; }
            }
            if (assignments[i] !== best) changed = true;
            assignments[i] = best;
        }
        const dims = vectors[0].length;
        const sums: number[][] = Array.from({ length: k }, () => new Array(dims).fill(0));
        const counts = new Array(k).fill(0);
        for (let i = 0; i < n; i++) {
            const c = assignments[i];
            counts[c]++;
            const v = vectors[i];
            for (let d = 0; d < dims; d++) sums[c][d] += v[d];
        }
        for (let c = 0; c < k; c++) {
            if (counts[c] === 0) {
                centroids[c] = vectors[Math.floor(Math.random() * n)].slice();
            } else {
                centroids[c] = normalizeVec(sums[c].map(x => x / counts[c]));
            }
        }
        if (!changed) break;
    }
    return assignments;
};

const pickK = (n: number, min: number, max: number, divisor: number) =>
    Math.min(max, Math.max(min, Math.round(Math.sqrt(n / divisor))));

const MAJOR_MIN = 3;
const MAJOR_MAX = 12;
const SUB_MIN_SIZE = 7; // 이보다 작은 대분류는 소분류로 더 쪼개지 않고 바로 메모를 나열
const SUB_MAX = 6;

interface OutlineSubCluster { index: number; noteIds: string[] }
interface OutlineCluster { index: number; noteIds: string[]; subClusters: OutlineSubCluster[] }

const MindMapView: React.FC<MindMapViewProps> = ({ notes, onBack, onSelectNote }) => {
    const [mode, setMode] = useState<'outline' | 'graph'>('outline');

    // ------------------------------------------------------------------
    // 목차(계층형 분류) 계산 — 순수 클라이언트 연산, API 호출 없음(무료, 즉시)
    // ------------------------------------------------------------------
    const outlineData = useMemo(() => {
        const withEmb = notes.filter(n => n.embedding && n.embedding.length > 0).slice(0, MAX_NODES);
        const missing = notes.length - withEmb.length;
        const noteById = new Map(withEmb.map(n => [n.id, n]));

        if (withEmb.length < 2) {
            return { clusters: [] as OutlineCluster[], noteById, missing };
        }

        const ids = withEmb.map(n => n.id);
        const vectors = withEmb.map(n => normalizeVec(n.embedding!));

        const majorK = withEmb.length < 6 ? 1 : pickK(withEmb.length, MAJOR_MIN, MAJOR_MAX, 4);
        const majorAssign = kmeansCluster(vectors, majorK);

        const rawGroups: string[][] = Array.from({ length: majorK }, () => []);
        majorAssign.forEach((c, i) => rawGroups[c].push(ids[i]));

        const nonEmpty = rawGroups.filter(g => g.length > 0).sort((a, b) => b.length - a.length);

        const clusters: OutlineCluster[] = nonEmpty.map((noteIds, index) => {
            let subClusters: OutlineSubCluster[] = [];
            if (noteIds.length > SUB_MIN_SIZE) {
                const subVectors = noteIds.map(id => normalizeVec(noteById.get(id)!.embedding!));
                const subK = pickK(noteIds.length, 2, SUB_MAX, 3);
                const subAssign = kmeansCluster(subVectors, subK);
                const subRaw: string[][] = Array.from({ length: subK }, () => []);
                subAssign.forEach((c, i) => subRaw[c].push(noteIds[i]));
                subClusters = subRaw
                    .filter(g => g.length > 0)
                    .sort((a, b) => b.length - a.length)
                    .map((sIds, sIndex) => ({ index: sIndex, noteIds: sIds }));
            }
            return { index, noteIds, subClusters };
        });

        return { clusters, noteById, missing };
    }, [notes]);

    const clusterSignature = useMemo(() => {
        return outlineData.clusters
            .map(c => `${c.noteIds.length}:${c.subClusters.map(s => s.noteIds.length).join(',')}`)
            .join('|');
    }, [outlineData]);

    // AI가 붙여준 카테고리 이름 (major-{index} / sub-{majorIndex}-{subIndex} 키)
    const [labels, setLabels] = useState<Map<string, string>>(new Map());
    const [labelsLoading, setLabelsLoading] = useState(false);
    const [labelsError, setLabelsError] = useState<string | null>(null);
    const labeledSignatureRef = useRef<string | null>(null);

    const handleGenerateLabels = async () => {
        if (outlineData.clusters.length === 0) return;
        setLabelsLoading(true);
        setLabelsError(null);
        try {
            const payload: TaxonomyClusterInput[] = outlineData.clusters.map(c => ({
                index: c.index,
                titles: c.noteIds.map(id => outlineData.noteById.get(id)?.title || '').filter(Boolean),
                subClusters: c.subClusters.map(s => ({
                    index: s.index,
                    titles: s.noteIds.map(id => outlineData.noteById.get(id)?.title || '').filter(Boolean)
                }))
            }));
            const result = await generateNoteTaxonomyLabels(payload, 'Korean');
            const next = new Map<string, string>();
            result.forEach(cat => {
                if (cat.label) next.set(`major-${cat.index}`, cat.label);
                (cat.subcategories || []).forEach(sub => {
                    if (sub.label) next.set(`sub-${cat.index}-${sub.index}`, sub.label);
                });
            });
            setLabels(next);
            labeledSignatureRef.current = clusterSignature;
        } catch (e: any) {
            console.error('메모 분류 이름 생성 실패', e);
            setLabelsError(e?.message || '분류 이름 생성 중 오류가 발생했습니다.');
        } finally {
            setLabelsLoading(false);
        }
    };

    // 목차 화면을 처음 열거나 메모 구성이 바뀌어 그룹이 달라지면, 한 번만 자동으로
    // AI 이름 붙이기를 시도합니다. (실패해도 번호 기반 이름("그룹 1")으로 그냥 쓸 수 있음)
    useEffect(() => {
        if (mode !== 'outline') return;
        if (outlineData.clusters.length === 0) return;
        if (labelsLoading) return;
        if (labeledSignatureRef.current === clusterSignature) return;
        handleGenerateLabels();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, clusterSignature]);

    const [expandedMajors, setExpandedMajors] = useState<Set<number>>(new Set());
    const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());

    const toggleMajor = (index: number) => {
        setExpandedMajors(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index); else next.add(index);
            return next;
        });
    };
    const toggleSub = (key: string) => {
        setExpandedSubs(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    // ------------------------------------------------------------------
    // 그래프 뷰 상태/로직
    // ------------------------------------------------------------------
    const containerRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ w: 800, h: 600 });
    const sizeRef = useRef(size);
    useEffect(() => { sizeRef.current = size; }, [size]);

    const { initialNodes, edges, missingEmbeddingCount } = useMemo(() => {
        const withEmb = notes.filter(n => n.embedding && n.embedding.length > 0).slice(0, MAX_NODES);
        const missing = notes.length - withEmb.length;

        const edgeMap = new Map<string, GraphEdge>();
        const degreeMap = new Map<string, number>();
        withEmb.forEach(n => degreeMap.set(n.id, 0));

        withEmb.forEach(a => {
            const sims: { id: string; sim: number }[] = [];
            withEmb.forEach(b => {
                if (a.id === b.id) return;
                const sim = cosineSimilarity(a.embedding, b.embedding);
                if (sim >= SIM_THRESHOLD) sims.push({ id: b.id, sim });
            });
            sims.sort((x, y) => y.sim - x.sim);
            sims.slice(0, KNN_K).forEach(({ id, sim }) => {
                const key = [a.id, id].sort().join('::');
                if (!edgeMap.has(key)) {
                    edgeMap.set(key, { source: a.id, target: id, sim });
                    degreeMap.set(a.id, (degreeMap.get(a.id) || 0) + 1);
                    degreeMap.set(id, (degreeMap.get(id) || 0) + 1);
                }
            });
        });

        const n = withEmb.length;
        const R = Math.max(120, n * 10);
        const nodes: GraphNode[] = withEmb.map((note, i) => {
            const angle = (2 * Math.PI * i) / Math.max(n, 1);
            return {
                id: note.id,
                title: note.title?.trim() || '제목 없음',
                x: R * Math.cos(angle) + (Math.random() - 0.5) * 30,
                y: R * Math.sin(angle) + (Math.random() - 0.5) * 30,
                vx: 0, vy: 0, fx: null, fy: null,
                degree: degreeMap.get(note.id) || 0,
            };
        });

        return { initialNodes: nodes, edges: Array.from(edgeMap.values()), missingEmbeddingCount: missing };
    }, [notes]);

    const nodesRef = useRef<GraphNode[]>(initialNodes);
    const nodeIndexRef = useRef<Map<string, number>>(new Map(initialNodes.map((n, i) => [n.id, i])));
    const [, setTick] = useState(0);
    const alphaRef = useRef(1);
    const hasAutoFitRef = useRef(false);

    useEffect(() => {
        nodesRef.current = initialNodes;
        nodeIndexRef.current = new Map(initialNodes.map((n, i) => [n.id, i]));
        alphaRef.current = 1;
        hasAutoFitRef.current = false;
        setTick(t => t + 1);
    }, [initialNodes]);

    const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
    const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

    const fitToView = () => {
        const ns = nodesRef.current;
        if (ns.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        ns.forEach(nd => {
            minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x);
            minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y);
        });
        const pad = 70;
        const w = Math.max(1, maxX - minX + pad * 2);
        const h = Math.max(1, maxY - minY + pad * 2);
        const { w: cw, h: ch } = sizeRef.current;
        const k = clampZoom(Math.min(cw / w, ch / h));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        setTransform({ x: -cx * k, y: -cy * k, k });
    };
    // rAF 루프(마운트 시 한 번만 생성)에서 항상 최신 fitToView를 쓸 수 있도록 ref에 보관
    const fitToViewRef = useRef(fitToView);
    useEffect(() => { fitToViewRef.current = fitToView; });

    // 물리 시뮬레이션 루프
    useEffect(() => {
        let rafId: number;
        const step = () => {
            const nodes = nodesRef.current;
            const idx = nodeIndexRef.current;
            const alpha = alphaRef.current;
            if (nodes.length > 0 && alpha > 0.008) {
                for (let i = 0; i < nodes.length; i++) {
                    for (let j = i + 1; j < nodes.length; j++) {
                        const a = nodes[i], b = nodes[j];
                        let dx = a.x - b.x, dy = a.y - b.y;
                        let distSq = dx * dx + dy * dy;
                        if (distSq < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distSq = 1; }
                        const dist = Math.sqrt(distSq);
                        const force = (REPULSION * alpha) / distSq;
                        const fx = (dx / dist) * force, fy = (dy / dist) * force;
                        if (a.fx === null) { a.vx += fx; a.vy += fy; }
                        if (b.fx === null) { b.vx -= fx; b.vy -= fy; }
                    }
                }
                for (const e of edges) {
                    const ai = idx.get(e.source), bi = idx.get(e.target);
                    if (ai === undefined || bi === undefined) continue;
                    const a = nodes[ai], b = nodes[bi];
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const diff = dist - IDEAL_DISTANCE;
                    const force = SPRING_K * diff * alpha;
                    const fx = (dx / dist) * force, fy = (dy / dist) * force;
                    if (a.fx === null) { a.vx += fx; a.vy += fy; }
                    if (b.fx === null) { b.vx -= fx; b.vy -= fy; }
                }
                for (const nd of nodes) {
                    if (nd.fx === null) {
                        nd.vx -= nd.x * CENTER_K * alpha;
                        nd.vy -= nd.y * CENTER_K * alpha;
                    }
                }
                for (const nd of nodes) {
                    if (nd.fx !== null && nd.fy !== null) {
                        nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0;
                    } else {
                        nd.vx *= DAMPING; nd.vy *= DAMPING;
                        nd.x += nd.vx; nd.y += nd.vy;
                    }
                }
                alphaRef.current *= 0.988;
                // 시뮬레이션이 어느 정도 안정되면(초반 퍼짐이 끝나면) 한 번 자동으로
                // 화면에 전체가 들어오게 맞춰줍니다. 이후엔 사용자의 수동 줌/팬을 존중.
                if (!hasAutoFitRef.current && alphaRef.current < 0.25) {
                    hasAutoFitRef.current = true;
                    fitToViewRef.current();
                }
                setTick(t => t + 1);
            }
            rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
        return () => cancelAnimationFrame(rafId);
    }, [edges]);

    const reheat = (amount: number) => { alphaRef.current = Math.max(alphaRef.current, amount); };

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const transformRef = useRef(transform);
    transformRef.current = transform;
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchStateRef = useRef<{ distance: number; k: number } | null>(null);
    const panStateRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
    const dragStateRef = useRef<{ id: string; startClientX: number; startClientY: number; moved: boolean } | null>(null);
    const [isDraggingNode, setIsDraggingNode] = useState(false);

    const getDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
        Math.hypot(p1.x - p2.x, p1.y - p2.y);

    const screenToWorld = (clientX: number, clientY: number) => {
        const rect = containerRef.current!.getBoundingClientRect();
        const t = transformRef.current;
        return {
            x: (clientX - rect.left - size.w / 2 - t.x) / t.k,
            y: (clientY - rect.top - size.h / 2 - t.y) / t.k,
        };
    };

    const hitTestNode = (clientX: number, clientY: number): GraphNode | null => {
        const world = screenToWorld(clientX, clientY);
        let best: GraphNode | null = null;
        let bestDist = 26;
        for (const nd of nodesRef.current) {
            const d = Math.hypot(nd.x - world.x, nd.y - world.y);
            if (d < bestDist) { bestDist = d; best = nd; }
        }
        return best;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointersRef.current.size === 1) {
            const node = hitTestNode(e.clientX, e.clientY);
            if (node) {
                dragStateRef.current = { id: node.id, startClientX: e.clientX, startClientY: e.clientY, moved: false };
                node.fx = node.x; node.fy = node.y;
                setIsDraggingNode(true);
                reheat(0.5);
                return;
            }
            panStateRef.current = { startX: e.clientX, startY: e.clientY, ox: transform.x, oy: transform.y };
        } else if (pointersRef.current.size === 2) {
            panStateRef.current = null;
            if (dragStateRef.current) {
                const nd = nodesRef.current.find(n => n.id === dragStateRef.current!.id);
                if (nd) { nd.fx = null; nd.fy = null; }
                dragStateRef.current = null;
                setIsDraggingNode(false);
            }
            const pts = Array.from(pointersRef.current.values());
            pinchStateRef.current = { distance: getDistance(pts[0], pts[1]), k: transform.k };
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointersRef.current.size === 2 && pinchStateRef.current) {
            const pts = Array.from(pointersRef.current.values());
            const newDistance = getDistance(pts[0], pts[1]);
            const ratio = newDistance / (pinchStateRef.current.distance || 1);
            setTransform(t => ({ ...t, k: clampZoom(pinchStateRef.current!.k * ratio) }));
            return;
        }

        if (dragStateRef.current) {
            const st = dragStateRef.current;
            const dx = e.clientX - st.startClientX, dy = e.clientY - st.startClientY;
            if (Math.hypot(dx, dy) > 4) st.moved = true;
            const node = nodesRef.current.find(n => n.id === st.id);
            if (node) {
                const world = screenToWorld(e.clientX, e.clientY);
                node.fx = world.x; node.fy = world.y;
                reheat(0.25);
            }
            return;
        }

        if (panStateRef.current) {
            const dx = e.clientX - panStateRef.current.startX;
            const dy = e.clientY - panStateRef.current.startY;
            setTransform(t => ({ ...t, x: panStateRef.current!.ox + dx, y: panStateRef.current!.oy + dy }));
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchStateRef.current = null;

        if (dragStateRef.current) {
            const st = dragStateRef.current;
            const node = nodesRef.current.find(n => n.id === st.id);
            if (!st.moved) {
                if (node) { node.fx = null; node.fy = null; }
                onSelectNote(st.id);
            }
            dragStateRef.current = null;
            setIsDraggingNode(false);
        }
        if (pointersRef.current.size === 0) panStateRef.current = null;
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = -e.deltaY * 0.0015;
        const rect = containerRef.current!.getBoundingClientRect();
        const cx = e.clientX - rect.left - size.w / 2;
        const cy = e.clientY - rect.top - size.h / 2;
        setTransform(t => {
            const nextK = clampZoom(t.k * (1 + delta));
            const ratio = nextK / t.k;
            return { k: nextK, x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio };
        });
    };

    const zoomBy = (factor: number) => setTransform(t => ({ ...t, k: clampZoom(t.k * factor) }));

    const nodes = nodesRef.current;
    const nodeIndex = nodeIndexRef.current;
    const hasGraph = nodes.length >= 2;
    const hasOutline = outlineData.clusters.length > 0;

    // ------------------------------------------------------------------
    // 렌더링
    // ------------------------------------------------------------------
    return (
        <div className="flex flex-col h-full bg-white">
            {/* 헤더 */}
            <div className="h-16 px-4 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 z-10 shadow-sm gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors shrink-0" title="메인으로">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <span className="mr-1 shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md bg-teal-100 text-teal-600">
                        <GitBranch className="w-4 h-4" />
                    </span>
                    <h2 className="font-bold text-slate-800 text-sm md:text-base whitespace-nowrap truncate">메모 마인드맵</h2>
                </div>

                {/* 목차 / 그래프 전환 */}
                <div className="flex items-center bg-slate-100 rounded-lg p-0.5 shrink-0">
                    <button
                        onClick={() => setMode('outline')}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-colors ${mode === 'outline' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500'}`}
                    >
                        <List className="w-3.5 h-3.5" /> 목차
                    </button>
                    <button
                        onClick={() => setMode('graph')}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-colors ${mode === 'graph' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500'}`}
                    >
                        <GitBranch className="w-3.5 h-3.5" /> 그래프
                    </button>
                </div>
            </div>

            {mode === 'outline' ? (
                <div className="flex-1 overflow-y-auto bg-slate-50">
                    {!hasOutline ? (
                        <div className="h-full flex flex-col items-center justify-center text-center px-8 text-slate-400">
                            <List className="w-10 h-10 mb-3 text-slate-300" />
                            <p className="text-sm font-medium text-slate-500">목차를 만들려면 임베딩이 계산된 메모가 2개 이상 필요합니다.</p>
                            <p className="text-xs mt-1.5 text-slate-400">메모를 몇 개 더 작성하거나, 잠시 후 다시 열어 임베딩이 계산되길 기다려주세요.</p>
                        </div>
                    ) : (
                        <div className="p-4 space-y-2 max-w-2xl mx-auto">
                            <div className="flex items-start gap-1.5 bg-white px-3 py-2.5 rounded-lg border border-slate-200 text-[11px] text-slate-500 mb-3">
                                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-teal-500" />
                                <span>
                                    의미가 비슷한 메모끼리 자동으로 대분류 → 소분류로 묶었습니다. 그룹을 눌러 펼치고, 메모를 눌러 바로 열어보세요.
                                    {outlineData.missing > 0 && ` (임베딩이 없는 메모 ${outlineData.missing}개는 표시되지 않습니다)`}
                                </span>
                            </div>

                            {labelsError && (
                                <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-lg mb-2">
                                    <span className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" /> AI 이름 붙이기 실패: {labelsError}</span>
                                    <button onClick={handleGenerateLabels} className="shrink-0 underline font-bold">다시 시도</button>
                                </div>
                            )}

                            {outlineData.clusters.map(cluster => {
                                const majorLabel = labels.get(`major-${cluster.index}`) || `그룹 ${cluster.index + 1}`;
                                const isOpen = expandedMajors.has(cluster.index);
                                return (
                                    <div key={cluster.index} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                                        <button
                                            onClick={() => toggleMajor(cluster.index)}
                                            className="w-full flex items-center gap-2 px-3.5 py-3 hover:bg-slate-50 transition-colors text-left"
                                        >
                                            {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                                            {isOpen ? <FolderOpen className="w-4 h-4 text-teal-500 shrink-0" /> : <Folder className="w-4 h-4 text-teal-500 shrink-0" />}
                                            <span className="font-bold text-sm text-slate-800 truncate flex-1">
                                                {labelsLoading && !labels.has(`major-${cluster.index}`) ? (
                                                    <span className="inline-flex items-center gap-1.5 text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> 이름 붙이는 중…</span>
                                                ) : majorLabel}
                                            </span>
                                            <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full shrink-0">{cluster.noteIds.length}</span>
                                        </button>

                                        {isOpen && (
                                            <div className="border-t border-slate-100 px-3.5 py-2 space-y-1">
                                                {cluster.subClusters.length > 0 ? (
                                                    cluster.subClusters.map(sub => {
                                                        const subKey = `${cluster.index}-${sub.index}`;
                                                        const subLabel = labels.get(`sub-${cluster.index}-${sub.index}`) || `소분류 ${sub.index + 1}`;
                                                        const subOpen = expandedSubs.has(subKey);
                                                        return (
                                                            <div key={subKey}>
                                                                <button
                                                                    onClick={() => toggleSub(subKey)}
                                                                    className="w-full flex items-center gap-2 px-2 py-2 hover:bg-slate-50 rounded-lg transition-colors text-left"
                                                                >
                                                                    {subOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-300 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
                                                                    <Tag className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                                                    <span className="text-xs font-semibold text-slate-600 truncate flex-1">
                                                                        {labelsLoading && !labels.has(`sub-${cluster.index}-${sub.index}`) ? '이름 붙이는 중…' : subLabel}
                                                                    </span>
                                                                    <span className="text-[10px] font-bold text-slate-400 shrink-0">{sub.noteIds.length}</span>
                                                                </button>
                                                                {subOpen && (
                                                                    <div className="pl-9 py-1 space-y-0.5">
                                                                        {sub.noteIds.map(id => {
                                                                            const note = outlineData.noteById.get(id);
                                                                            if (!note) return null;
                                                                            return (
                                                                                <button
                                                                                    key={id}
                                                                                    onClick={() => onSelectNote(id)}
                                                                                    className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-teal-50 hover:text-teal-700 rounded-lg text-left text-xs text-slate-600 transition-colors"
                                                                                >
                                                                                    <FileText className="w-3 h-3 shrink-0 text-slate-300" />
                                                                                    <span className="truncate">{note.title || '제목 없음'}</span>
                                                                                </button>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })
                                                ) : (
                                                    <div className="pl-2 py-1 space-y-0.5">
                                                        {cluster.noteIds.map(id => {
                                                            const note = outlineData.noteById.get(id);
                                                            if (!note) return null;
                                                            return (
                                                                <button
                                                                    key={id}
                                                                    onClick={() => onSelectNote(id)}
                                                                    className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-teal-50 hover:text-teal-700 rounded-lg text-left text-xs text-slate-600 transition-colors"
                                                                >
                                                                    <FileText className="w-3 h-3 shrink-0 text-slate-300" />
                                                                    <span className="truncate">{note.title || '제목 없음'}</span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            <button
                                onClick={handleGenerateLabels}
                                disabled={labelsLoading}
                                className="w-full flex items-center justify-center gap-1.5 py-2.5 mt-3 text-xs font-bold text-teal-600 hover:bg-teal-50 rounded-lg transition-colors disabled:opacity-50"
                            >
                                {labelsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                {labelsLoading ? 'AI가 이름을 정리하는 중…' : 'AI로 분류 이름 다시 붙이기'}
                            </button>
                        </div>
                    )}
                </div>
            ) : (
                <div ref={containerRef} className="flex-1 relative overflow-hidden bg-slate-50">
                    {!hasGraph ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 text-slate-400">
                            <GitBranch className="w-10 h-10 mb-3 text-slate-300" />
                            <p className="text-sm font-medium text-slate-500">마인드맵을 그리려면 임베딩이 계산된 메모가 2개 이상 필요합니다.</p>
                            <p className="text-xs mt-1.5 text-slate-400">메모를 몇 개 더 작성하거나, 잠시 후 다시 열어 임베딩이 계산되길 기다려주세요.</p>
                        </div>
                    ) : (
                        <svg
                            className="w-full h-full"
                            style={{ touchAction: 'none', cursor: isDraggingNode ? 'grabbing' : 'grab' }}
                            onWheel={handleWheel}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                        >
                            <g transform={`translate(${size.w / 2 + transform.x}, ${size.h / 2 + transform.y}) scale(${transform.k})`}>
                                {edges.map((e, i) => {
                                    const ai = nodeIndex.get(e.source), bi = nodeIndex.get(e.target);
                                    if (ai === undefined || bi === undefined) return null;
                                    const a = nodes[ai], b = nodes[bi];
                                    return (
                                        <line
                                            key={i}
                                            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                                            stroke="#94a3b8"
                                            strokeOpacity={Math.min(0.65, 0.15 + e.sim * 0.6)}
                                            strokeWidth={1.5 / transform.k}
                                        />
                                    );
                                })}
                                {nodes.map(nd => {
                                    const radius = Math.min(24, 11 + nd.degree * 2.2);
                                    return (
                                        <g key={nd.id}>
                                            <circle
                                                cx={nd.x} cy={nd.y} r={radius}
                                                fill="#ffffff"
                                                stroke={nd.degree > 0 ? '#0d9488' : '#94a3b8'}
                                                strokeWidth={2 / transform.k}
                                            />
                                            <text
                                                x={nd.x}
                                                y={nd.y + radius + 12 / transform.k}
                                                textAnchor="middle"
                                                fontSize={11 / transform.k}
                                                fill="#334155"
                                                fontWeight={600}
                                                style={{ pointerEvents: 'none', userSelect: 'none' }}
                                            >
                                                {truncate(nd.title, 14)}
                                            </text>
                                        </g>
                                    );
                                })}
                            </g>
                        </svg>
                    )}

                    {hasGraph && (
                        <>
                            <div className="absolute bottom-6 right-4 flex flex-col bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden">
                                <button onClick={() => zoomBy(1.3)} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="확대">
                                    <ZoomIn className="w-4 h-4" />
                                </button>
                                <div className="h-px bg-slate-100" />
                                <button onClick={() => zoomBy(1 / 1.3)} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="축소">
                                    <ZoomOut className="w-4 h-4" />
                                </button>
                                <div className="h-px bg-slate-100" />
                                <button onClick={fitToView} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="전체가 보이게 맞추기">
                                    <Maximize2 className="w-4 h-4" />
                                </button>
                            </div>

                            <div className="absolute top-3 left-3 right-3 flex items-start gap-1.5 bg-white/90 backdrop-blur px-3 py-2 rounded-lg border border-slate-200 text-[11px] text-slate-500 max-w-sm shadow-sm">
                                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-teal-500" />
                                <span>
                                    서로 의미가 비슷한 메모끼리 선으로 연결되어 있어요. 노드를 눌러 메모를 열거나, 드래그해서 배치를 바꿔보세요.
                                    {missingEmbeddingCount > 0 && ` (임베딩이 없는 메모 ${missingEmbeddingCount}개는 표시되지 않습니다)`}
                                </span>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default MindMapView;
