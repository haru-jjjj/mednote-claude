import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, GitBranch, ZoomIn, ZoomOut, RotateCcw, Info } from 'lucide-react';
import { Note } from '../types';
import { cosineSimilarity } from '../services/voyageService';

interface MindMapViewProps {
    notes: Note[];
    onBack: () => void;
    onSelectNote: (id: string) => void;
}

interface GraphNode {
    id: string;
    title: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx: number | null; // 드래그/고정 중인 x (null이면 물리 시뮬레이션이 위치를 계산)
    fy: number | null;
    degree: number; // 연결된 간선 수 (노드 크기에 반영)
}

interface GraphEdge {
    source: string;
    target: string;
    sim: number;
}

// 너무 많은 메모가 한꺼번에 있을 때 O(n^2) 연산이 과해지지 않도록 상한을 둡니다.
const MAX_NODES = 400;
// 메모 하나당 최대 몇 개의 "가장 유사한 메모"와 연결선을 그릴지
const KNN_K = 4;
// 이 값보다 유사도가 낮으면 아예 연결하지 않음 (하이볼 방지)
const SIM_THRESHOLD = 0.35;

// --- 물리 시뮬레이션 파라미터 ---
const IDEAL_DISTANCE = 130; // 연결된 노드끼리 유지하려는 이상적인 거리(px)
const REPULSION = 2600;     // 모든 노드가 서로 밀어내는 힘
const SPRING_K = 0.02;      // 연결선이 노드를 끌어당기는 힘
const CENTER_K = 0.012;     // 전체를 화면 중앙으로 모으는 힘
const DAMPING = 0.82;       // 속도 감쇠(마찰) — 낮을수록 빨리 멈춤
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const MindMapView: React.FC<MindMapViewProps> = ({ notes, onBack, onSelectNote }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ w: 800, h: 600 });

    // --- 그래프 구조(노드/간선) 계산: 메모 목록이나 임베딩이 바뀔 때만 다시 계산 ---
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

        // 초기 배치: 원형으로 흩뿌려서 시뮬레이션이 자연스럽게 퍼지도록 함
        const n = withEmb.length;
        const R = Math.max(120, n * 10);
        const nodes: GraphNode[] = withEmb.map((note, i) => {
            const angle = (2 * Math.PI * i) / Math.max(n, 1);
            return {
                id: note.id,
                title: note.title?.trim() || '제목 없음',
                x: R * Math.cos(angle) + (Math.random() - 0.5) * 30,
                y: R * Math.sin(angle) + (Math.random() - 0.5) * 30,
                vx: 0,
                vy: 0,
                fx: null,
                fy: null,
                degree: degreeMap.get(note.id) || 0,
            };
        });

        return { initialNodes: nodes, edges: Array.from(edgeMap.values()), missingEmbeddingCount: missing };
    }, [notes]);

    // 실제 위치는 리액트 state가 아니라 ref로 들고 있다가(매 프레임 재계산 비용을 줄이기 위해)
    // tick 카운터로 강제 리렌더링합니다.
    const nodesRef = useRef<GraphNode[]>(initialNodes);
    const nodeIndexRef = useRef<Map<string, number>>(new Map(initialNodes.map((n, i) => [n.id, i])));
    const [, setTick] = useState(0);
    const alphaRef = useRef(1);

    useEffect(() => {
        nodesRef.current = initialNodes;
        nodeIndexRef.current = new Map(initialNodes.map((n, i) => [n.id, i]));
        alphaRef.current = 1;
        setTick(t => t + 1);
    }, [initialNodes]);

    // --- 물리 시뮬레이션 루프 ---
    useEffect(() => {
        let rafId: number;
        const step = () => {
            const nodes = nodesRef.current;
            const idx = nodeIndexRef.current;
            const alpha = alphaRef.current;
            if (nodes.length > 0 && alpha > 0.008) {
                // 1) 모든 노드 쌍이 서로 밀어내는 힘 (겹침 방지)
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
                // 2) 연결된(유사한) 노드끼리 적당한 거리로 당기는 스프링 힘
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
                // 3) 전체를 중앙으로 모으는 힘 (화면 밖으로 퍼지는 것 방지)
                for (const nd of nodes) {
                    if (nd.fx === null) {
                        nd.vx -= nd.x * CENTER_K * alpha;
                        nd.vy -= nd.y * CENTER_K * alpha;
                    }
                }
                // 4) 적분(위치 업데이트)
                for (const nd of nodes) {
                    if (nd.fx !== null && nd.fy !== null) {
                        nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0;
                    } else {
                        nd.vx *= DAMPING; nd.vy *= DAMPING;
                        nd.x += nd.vx; nd.y += nd.vy;
                    }
                }
                alphaRef.current *= 0.988;
                setTick(t => t + 1);
            }
            rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
        return () => cancelAnimationFrame(rafId);
    }, [edges]);

    const reheat = (amount: number) => {
        alphaRef.current = Math.max(alphaRef.current, amount);
    };

    // --- 화면 크기 추적 ---
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // --- 팬/줌/드래그 상태 ---
    const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
    const transformRef = useRef(transform);
    transformRef.current = transform;
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchStateRef = useRef<{ distance: number; k: number } | null>(null);
    const panStateRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
    const dragStateRef = useRef<{ id: string; startClientX: number; startClientY: number; moved: boolean } | null>(null);
    const [isDraggingNode, setIsDraggingNode] = useState(false);

    const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

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
        let bestDist = 26; // world 좌표 기준 히트 반경 (터치하기 쉽도록 실제 반지름보다 넉넉하게)
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
                // 클릭으로 간주: 고정하지 않고 해당 메모로 이동
                if (node) { node.fx = null; node.fy = null; }
                onSelectNote(st.id);
            }
            // 드래그로 옮긴 경우: 사용자가 배치한 자리에 그대로 고정(현재 화면을 보는 동안 유지)
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
    const resetView = () => setTransform({ x: 0, y: 0, k: 1 });

    const nodes = nodesRef.current;
    const nodeIndex = nodeIndexRef.current;
    const hasGraph = nodes.length >= 2;

    return (
        <div className="flex flex-col h-full bg-white">
            {/* 헤더 */}
            <div className="h-16 px-4 bg-white border-b border-slate-200 flex justify-between items-center shrink-0 z-10 shadow-sm">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors shrink-0" title="메인으로">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <span className="mr-1 shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md bg-teal-100 text-teal-600">
                        <GitBranch className="w-4 h-4" />
                    </span>
                    <h2 className="font-bold text-slate-800 text-sm md:text-base whitespace-nowrap truncate">메모 마인드맵</h2>
                </div>
            </div>

            {/* 그래프 영역 */}
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
                        {/* 줌 컨트롤 */}
                        <div className="absolute bottom-6 right-4 flex flex-col bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden">
                            <button onClick={() => zoomBy(1.3)} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="확대">
                                <ZoomIn className="w-4 h-4" />
                            </button>
                            <div className="h-px bg-slate-100" />
                            <button onClick={() => zoomBy(1 / 1.3)} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="축소">
                                <ZoomOut className="w-4 h-4" />
                            </button>
                            <div className="h-px bg-slate-100" />
                            <button onClick={resetView} className="p-2.5 text-slate-600 hover:bg-slate-50 transition-colors" title="화면 초기화">
                                <RotateCcw className="w-4 h-4" />
                            </button>
                        </div>

                        {/* 안내문 */}
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
        </div>
    );
};

export default MindMapView;
