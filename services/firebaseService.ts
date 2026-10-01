
import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  startAfter,
  getDocs,
  where,
  documentId,
  getDoc,
  updateDoc,
  deleteField
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { v4 as uuidv4 } from 'uuid';
import { Note } from "../types";

const firebaseConfig = {
  apiKey: "AIzaSyCW1hIHQQ9IE7oQSThytWMU6fGSKAnxWP4",
  authDomain: "study-65680.firebaseapp.com",
  projectId: "study-65680",
  storageBucket: "study-65680.firebasestorage.app",
  messagingSenderId: "973612375260",
  appId: "1:973612375260:web:e9cb61bccbcd050d692819"
};

const app = initializeApp(firebaseConfig);

// ignoreUndefinedProperties: true — 이전 버전에서는 note 객체에 `undefined` 필드(예: 이미지
// 변경 시 transcription을 undefined로 리셋)가 섞여 있으면 Firestore가
// "Unsupported field value: undefined" 오류를 던지며 저장에 조용히 실패했습니다.
// https://firebase.google.com/docs/reference/node/firebase.firestore.Settings
const db = initializeFirestore(app, { ignoreUndefinedProperties: true });

const auth = getAuth(app);

// Helper to ensure auth is ready
// 버그 수정: 앱을 열자마자 PIN 확인·자동 잠금 설정 확인·메모 동기화가 동시에 이 함수를 불렀는데,
// 그 시점엔 저장돼 있던 로그인 정보가 아직 복원되기 전이라(auth.currentUser가 잠깐 null) 각자
// 새 익명 계정을 만들었습니다. 그러면 사용자 정보가 연달아 바뀌면서 실시간 동기화 연결이 끊겼다
// 다시 붙는 일이 생겨 동기화가 늦거나 빠지는 원인이 됐습니다. 이제 (1) 저장된 로그인 복원을 먼저
// 기다리고, (2) 동시에 여러 번 불려도 로그인은 한 번만 합니다.
let authInFlight: Promise<any> | null = null;
const ensureAuth = async () => {
    if (auth.currentUser) return auth.currentUser;
    if (authInFlight) return authInFlight;
    authInFlight = (async () => {
        try {
            try { await (auth as any).authStateReady?.(); } catch { /* 구버전 등: 무시 */ }
            if (auth.currentUser) return auth.currentUser;
            const userCredential = await signInAnonymously(auth);
            return userCredential.user;
        } catch (error: any) {
            if (error.code === 'auth/network-request-failed') {
                console.warn("Firebase Auth: Network failed, operating offline.");
                return null;
            }
            console.error("Firebase Authentication Failed:", error.code, error.message);
            throw error;
        } finally {
            authInFlight = null;
        }
    })();
    return authInFlight;
};

// Real-time synchronization using onSnapshot
// OPTIMIZATION: Only listen to the latest 30 notes to save API reads.
const SYNC_LIMIT = 30;

export const syncNotesFromFirestore = (onNotesUpdate: (notes: Note[]) => void) => {
  let unsubs: (() => void)[] = [];
  let isCancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let starting = false;

  const stopAll = () => { unsubs.forEach(u => { try { u(); } catch { /* 무시 */ } }); unsubs = []; };

  // 두 가지를 실시간으로 받습니다:
  // 1) 내용이 최근에 바뀐 메모 30개 (updatedAt 순)
  // 2) 분류·확인함·복습 일정·요약·삭제 같은 "내용 밖" 정보가 최근에 바뀐 메모 30개 (metaUpdatedAt 순)
  //    — 예전엔 1)만 받아서, 다른 기기에서 분류를 바꾸거나 메모를 지운 것이 실시간으로 안 넘어왔습니다.
  // 바뀐 문서만 넘겨서(docChanges) 매번 30개 전체를 다시 처리하지 않습니다.
  const startListeners = async () => {
      if (isCancelled || starting || unsubs.length > 0) return;
      starting = true;
      try {
          const user = await ensureAuth();
          if (isCancelled) return;
          if (!user && !auth.currentUser) {
              console.log("Firebase: Operating in offline mode (Auth failed). 연결되면 다시 시도합니다.");
              return;
          }
          const handle = (snapshot: any) => {
            const notes: Note[] = [];
            snapshot.docChanges().forEach((c: any) => {
              if (c.type !== 'removed') notes.push(c.doc.data() as Note); // removed = 30개 범위 밖으로 밀려난 것(삭제 아님)
            });
            if (notes.length === 0) return;
            notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            onNotesUpdate(notes);
          };
          // 오류로 리스너가 끊기면(권한·연결 문제 등) 잠시 뒤 다시 연결
          const onError = (error: any) => {
            console.warn("Firebase Snapshot Error — 5초 뒤 다시 연결합니다:", error?.code || error);
            stopAll();
            if (!isCancelled && !retryTimer) {
                retryTimer = setTimeout(() => { retryTimer = null; startListeners(); }, 5000);
            }
          };
          unsubs = [
              onSnapshot(query(collection(db, "notes"), orderBy("updatedAt", "desc"), limit(SYNC_LIMIT)), handle, onError),
              onSnapshot(query(collection(db, "notes"), orderBy("metaUpdatedAt", "desc"), limit(SYNC_LIMIT)), handle, onError)
          ];
          if (isCancelled) stopAll();
      } catch (e) {
          console.error("Firebase Init Sequence Failed:", e);
      } finally {
          starting = false;
      }
  };

  startListeners();
  // 처음 열 때 오프라인이었으면, 연결되는 순간 리스너를 붙임
  const onOnline = () => startListeners();
  window.addEventListener('online', onOnline);

  return () => {
      isCancelled = true;
      window.removeEventListener('online', onOnline);
      if (retryTimer) clearTimeout(retryTimer);
      stopAll();
  };
};

// Fetch older notes manually (Pagination)
export const fetchOlderNotes = async (lastNoteDate: number): Promise<Note[]> => {
    try {
        await ensureAuth();
        // Query for notes older than the last one we have
        const q = query(
            collection(db, "notes"),
            orderBy("updatedAt", "desc"),
            startAfter(lastNoteDate),
            limit(20) // Batch size for "Load More"
        );

        let snapshot = await getDocs(q);
        const notes: Note[] = [];
        // 삭제 표시만 있는 페이지면 다음 페이지로 (최대 5번) — "더 이상 메모 없음"으로 잘못 끝나지 않게
        for (let page = 0; page < 5; page++) {
            let lastUpdated: number | null = null;
            snapshot.forEach((doc) => {
                const n = doc.data() as Note;
                lastUpdated = n.updatedAt || 0;
                if (!n.deleted) notes.push(n);
            });
            if (notes.length > 0 || snapshot.size < 20 || lastUpdated === null) break;
            snapshot = await getDocs(query(collection(db, "notes"), orderBy("updatedAt", "desc"), startAfter(lastUpdated), limit(20)));
        }
        
        return notes;
    } catch (error) {
        console.error("Error fetching older notes:", error);
        return [];
    }
};

// Fetch ALL notes from Firestore at once
export const fetchAllNotesFromFirestore = async (): Promise<Note[]> => {
    try {
        await ensureAuth();
        const q = query(
            collection(db, "notes"),
            orderBy("updatedAt", "desc")
        );

        const snapshot = await getDocs(q);
        const notes: Note[] = [];
        snapshot.forEach((doc) => {
            notes.push(doc.data() as Note);
        });
        
        return notes;
    } catch (error) {
        console.error("Error fetching all notes:", error);
        return [];
    }
};

// 랜덤 탐색 지점 ID 생성.
// 버그 수정: 예전 구현은 대소문자+숫자 20자(Firestore Auto-ID 스타일) 문자열을 만들어
// documentId() 범위 쿼리의 기준점으로 썼지만, 실제 노트 ID는 uuidv4()가 만드는
// 소문자 16진수+하이픈 형식이라 문자 집합과 정렬 순서가 전혀 달랐습니다. 그 결과
// 임의 탐색 지점이 실제 문서가 존재하는 ID 구간을 거의 벗어나 "클러스터 프로빙"이
// 빈손으로 돌아오고 매번 최신 100개 폴백으로 빠지는 경우가 많았습니다.
// 실제 ID 형식과 동일한 uuidv4()를 탐색 지점으로 사용해 분포를 맞춥니다.
const generateAutoId = () => uuidv4();

// Fetch a SINGLE random note efficiently with "Cluster Probing" Strategy
// Improved to remove "Gap Bias" where notes after large ID gaps were selected too often.
export const fetchRandomNoteFromFirestore = async (excludedIds: string[] = []): Promise<Note | null> => {
    try {
        await ensureAuth();
        
        // Strategy: "Cluster Probing"
        // Instead of fetching 1 document at a random ID (which favors documents after large gaps),
        // we fetch a small cluster (e.g., 5 docs) starting from a random ID.
        // We do this at multiple random points (Probes) to gather a diverse pool.
        // Then we pick one random note from that combined pool.
        
        const PROBE_COUNT = 3;  // Number of random entry points
        const CLUSTER_SIZE = 5; // Number of docs to fetch per point to jump over gaps
        
        const promises = [];
        for(let i=0; i < PROBE_COUNT; i++) {
            const randomId = generateAutoId();
            const direction = Math.random() < 0.5 ? 'asc' : 'desc';
            const operator = direction === 'asc' ? '>=' : '<';
            
            const q = query(
                collection(db, "notes"),
                where(documentId(), operator, randomId),
                orderBy(documentId(), direction),
                limit(CLUSTER_SIZE)
            );
            promises.push(getDocs(q));
        }

        const snapshots = await Promise.all(promises);
        
        // Aggregate all unique candidates from the clusters
        const candidateMap = new Map<string, Note>();
        snapshots.forEach(snap => {
            snap.forEach(doc => {
                const data = doc.data() as Note;
                // Exclude already seen IDs (and deleted-note markers)
                if (!data.deleted && !excludedIds.includes(data.id)) {
                    candidateMap.set(data.id, data);
                }
            });
        });

        // Convert to array
        let validCandidates = Array.from(candidateMap.values());

        // Fallback: If probing missed everything (e.g. extremely small DB or unlucky),
        // fetch the most recent notes to ensure we return *something*.
        // INCREASED LIMIT FROM 15 TO 100 TO INCREASE DIVERSITY IN FALLBACK
        if (validCandidates.length === 0) {
            const qFallback = query(
                collection(db, "notes"), 
                orderBy("updatedAt", "desc"),
                limit(100) 
            );
            const snap = await getDocs(qFallback);
            snap.forEach(doc => {
                 const n = doc.data() as Note;
                 if (!n.deleted && !excludedIds.includes(n.id)) validCandidates.push(n);
            });
        }
        
        // Final Random Selection from the Pool
        if (validCandidates.length > 0) {
            // Fisher-Yates Shuffle for good measure
            for (let i = validCandidates.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [validCandidates[i], validCandidates[j]] = [validCandidates[j], validCandidates[i]];
            }
            return validCandidates[0];
        }

        return null;

    } catch (error) {
        console.error("Error fetching random note:", error);
        return null;
    }
};

/**
 * Optimized Batch Fetch for Random Notes from the Cloud
 * Allows "Quiz" and "Study Guide" to use the ENTIRE database without syncing everything.
 */
export const fetchRandomNotesBatch = async (count: number, excludedIds: string[], localNotes: Note[]): Promise<Note[]> => {
    try {
        // Run single random fetches in parallel.
        // Since fetchRandomNoteFromFirestore now uses "Cluster Probing", 
        // calling it multiple times ensures very high randomness.
        const promises = Array(count).fill(null).map(() => fetchRandomNoteFromFirestore(excludedIds));
        const results = await Promise.all(promises);
        
        const finalNotes: Note[] = [];
        const seenIds = new Set(excludedIds);

        for (const note of results) {
            if (note && !seenIds.has(note.id)) {
                seenIds.add(note.id);
                
                // OPTIMIZATION: Check if we have this note locally.
                // If yes, prefer local (it might be newer, and saves downloading large images again if we just got metadata from cloud)
                const localMatch = localNotes.find(n => n.id === note.id);
                if (localMatch) {
                    finalNotes.push(localMatch);
                } else {
                    finalNotes.push(note);
                }
            }
        }
        
        return finalNotes;
    } catch (e) {
        console.error("Batch random fetch failed:", e);
        return [];
    }
};

// 같은 메모에 대한 클라우드 쓰기는 순서대로 처리 (전체 저장 → 부분 수정 순서가 뒤바뀌지 않게)
const writeChains = new Map<string, Promise<unknown>>();
const enqueueWrite = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = writeChains.get(id) || Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    writeChains.set(id, run);
    const cleanup = () => { if (writeChains.get(id) === run) writeChains.delete(id); };
    run.then(cleanup, cleanup);
    return run;
};

// 서버 확인을 아직 못 받은 쓰기 수 (오프라인이면 계속 남아 있음) — 중복 재업로드 방지용
const pendingAcks = new Map<string, number>();

// 클라우드 저장이 아직 확인되지 않은 메모를 기기에 기록(앱을 껐다 켜도 남음).
// - c: 아직 확인 안 된 "전체 저장"의 내용 수정 시각, m: 부가정보 수정 시각, d: 삭제
// - 실시간 동기화에서 이 기기 사본이 더 최신일 때, 정말 이 기기에서 고치고 못 올린 메모만 유지·재업로드하고
//   그 외에는 클라우드를 따릅니다(기기 시계가 어긋나 다른 기기의 최신 수정을 덮는 일 방지).
// - 임베딩 같은 부분 저장의 확인으로 "전체 저장 미확인" 표시가 지워지지 않도록 종류별로 따로 관리.
type UnsyncedEntry = { c?: number; m?: number; d?: boolean };
const UNSYNCED_KEY = 'medinote_unsynced_notes_v2';
const readUnsynced = (): Map<string, UnsyncedEntry> => {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(UNSYNCED_KEY) || '{}'))); } catch { return new Map(); }
};
const unsynced = readUnsynced();
const persistUnsynced = () => {
    try { localStorage.setItem(UNSYNCED_KEY, JSON.stringify(Object.fromEntries(unsynced))); } catch { /* 무시 */ }
};
const markUnsynced = (id: string, patch: UnsyncedEntry) => {
    const cur = unsynced.get(id) || {};
    unsynced.set(id, {
        c: patch.c !== undefined ? Math.max(cur.c || 0, patch.c) : cur.c,
        m: patch.m !== undefined ? Math.max(cur.m || 0, patch.m) : cur.m,
        d: patch.d || cur.d
    });
    persistUnsynced();
};
const clearUnsynced = (id: string, acked: UnsyncedEntry) => {
    const cur = unsynced.get(id);
    if (!cur) return;
    const next: UnsyncedEntry = { ...cur };
    if (acked.c !== undefined && next.c !== undefined && acked.c >= next.c) delete next.c;
    if (acked.m !== undefined && next.m !== undefined && acked.m >= next.m) delete next.m;
    if (acked.d) delete next.d;
    if (next.c === undefined && next.m === undefined && !next.d) unsynced.delete(id); else unsynced.set(id, next);
    persistUnsynced();
};
export const isUnsyncedNote = (id: string): boolean => unsynced.has(id);
export const forgetUnsynced = (id: string) => { if (unsynced.delete(id)) persistUnsynced(); };
export const listUnsyncedNotes = (): { id: string; deleted: boolean }[] =>
    Array.from(unsynced.entries()).map(([id, e]) => ({ id, deleted: !!e.d }));

// 이번 세션에서 클라우드가 거절한 저장(용량 초과·권한 등) — 같은 메모를 계속 다시 올리지 않도록
const failedIds = new Set<string>();
export const hasFailedCloudWrite = (id: string): boolean => failedIds.has(id);

const trackAck = (id: string, p: Promise<unknown>, acked: UnsyncedEntry) => {
    pendingAcks.set(id, (pendingAcks.get(id) || 0) + 1);
    const settle = (ok: boolean | null) => {
        const n = (pendingAcks.get(id) || 1) - 1;
        if (n <= 0) pendingAcks.delete(id); else pendingAcks.set(id, n);
        if (ok === true) { clearUnsynced(id, acked); failedIds.delete(id); }
        else if (ok === false) failedIds.add(id); // 표시는 남겨서 이 기기 사본이 덮이지 않게
        // ok === null(연결 문제): 표시만 남기고 다음에 다시 시도
    };
    p.then(() => settle(true), (e: any) => settle(e?.code === 'unavailable' ? null : false));
    return p;
};

// 저장 직전 확인에서 "다른 기기에서 이미 지운 메모"로 밝혀졌을 때 앱에 알림 (이 기기에서도 지우도록)
let remoteDeletedHandler: ((id: string) => void) | null = null;
export const setRemoteDeletedHandler = (fn: ((id: string) => void) | null) => { remoteDeletedHandler = fn; };

// 이 메모의 클라우드 저장이 서버에서 확인될 때까지 기다림 (시간 초과·실패면 false)
export const waitForCloudSave = async (id: string, timeoutMs = 20000): Promise<boolean> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (!writeChains.has(id) && !pendingAcks.has(id)) return !failedIds.has(id) && !unsynced.has(id);
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
};
export const hasPendingCloudWrite = (id: string): boolean => writeChains.has(id) || pendingAcks.has(id);

// 이 세션에서 삭제한 메모: 늦게 도착한 저장/동기화가 되살리지 않도록 기억
const deletedIds = new Set<string>();
export const isDeletedNoteId = (id: string): boolean => deletedIds.has(id);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

// 복습 일정·오답 노트·가이드라인 점검처럼 "내용 밖" 정보. 다른 기기에서 더 최근에 바뀌었으면
// 이 기기에서 메모 전체를 저장할 때 클라우드 쪽 값을 유지합니다(오래된 사본으로 덮지 않도록).
const META_FIELDS: (keyof Note)[] = ['quizMasteryCount', 'reviewDueAt', 'reviewIntervalDays', 'lastReviewedAt', 'wrongAnswers', 'guidelineCheck', 'followUpCheckedAt', 'followUpIntervalDays', 'followUpDueAt', 'tag', 'work', 'summary', 'sources', 'summarizedAt', 'summaryKind'];

// Save a note to Firestore (Add/Update)
// opts.replay: 지난번에 못 올린 변경을 다시 올리는 경우 — 클라우드 확인이 안 되면 이번엔 올리지 않음(다음에 재시도)
export const saveNoteToFirestore = (note: Note, opts?: { replay?: boolean }): Promise<void> => {
  // 대기열에 넣는 순간 "미확인"으로 표시 (확인 전에 앱을 꺼도 다음에 다시 올림)
  markUnsynced(note.id, { c: note.updatedAt || 0, m: note.metaUpdatedAt || 0 });
  const versions = { c: note.updatedAt || 0, m: note.metaUpdatedAt || 0 };
  return enqueueWrite(note.id, async () => {
  try {
    await ensureAuth();
    const ref = doc(db, "notes", note.id);
    const noteToSave: Record<string, any> = {
        ...note,
        updatedAt: note.updatedAt || Date.now()
    };
    try {
        const snap: any = await withTimeout<any>(getDoc(ref), 4000);
        if (snap.exists()) {
            const remote = snap.data() as Note;
            // 다른 기기에서 이 메모를 지운 뒤라면(그 뒤에 이 기기에서 고친 게 아니면) 되살리지 않음
            // (이 기기에서의 삭제는 실시간 동기화·전체 불러오기가 삭제 표시를 보고 처리)
            if (remote.deleted && (remote.updatedAt || 0) >= (note.updatedAt || 0)) {
                clearUnsynced(note.id, { c: note.updatedAt || 0, m: note.metaUpdatedAt || 0 });
                remoteDeletedHandler?.(note.id);
                return;
            }
            // 클라우드의 내용이 더 최신이면(다른 기기에서 그 뒤에 고침) 내용은 덮지 않고,
            // 이 기기의 부가정보가 더 최신일 때만 그것만 보냄
            if (!remote.deleted && (remote.updatedAt || 0) > (note.updatedAt || 0)) {
                if ((note.metaUpdatedAt || 0) > (remote.metaUpdatedAt || 0)) {
                    const meta: Record<string, any> = { metaUpdatedAt: note.metaUpdatedAt };
                    META_FIELDS.forEach(k => { meta[k] = (note as any)[k] === undefined ? deleteField() : (note as any)[k]; });
                    trackAck(note.id, updateDoc(ref, meta), versions).catch(() => undefined);
                } else {
                    clearUnsynced(note.id, versions);
                }
                return;
            }
            if ((remote.metaUpdatedAt || 0) > (note.metaUpdatedAt || 0)) {
                META_FIELDS.forEach(k => { noteToSave[k] = (remote as any)[k]; });
                noteToSave.metaUpdatedAt = remote.metaUpdatedAt;
            }
        }
    } catch {
        // 오프라인/지연이면 확인 없이 그대로 저장 (다시 올리기는 확인될 때까지 미룸)
        if (opts?.replay) return;
    }
    if (deletedIds.has(note.id)) { clearUnsynced(note.id, versions); return; }
    // 쓰기 순서는 Firestore 클라이언트가 보장하므로 서버 확인까지 대기열을 붙잡아 두지 않음
    trackAck(note.id, setDoc(ref, noteToSave), versions).catch((error: any) => {
        if (error?.code === 'unavailable') return;
        console.error("Error saving note to Firestore:", error);
    });
  } catch (error: any) {
    if (error.code === 'unavailable') return;
    console.error("Error saving note to Firestore:", error);
  }
  });
};

// 메모의 일부 필드만 클라우드에 반영 (값이 undefined면 필드 삭제).
// 문서가 없으면(다른 기기에서 삭제됨 등) 되살리지 않고 조용히 넘어갑니다.
export const updateNoteFieldsInFirestore = (id: string, fields: Partial<Note>): Promise<void> => enqueueWrite(id, async () => {
  try {
    await ensureAuth();
    const data: Record<string, any> = {};
    Object.entries(fields).forEach(([k, v]) => { data[k] = v === undefined ? deleteField() : v; });
    if (Object.keys(data).length === 0 || deletedIds.has(id)) return;
    const m = typeof fields.metaUpdatedAt === 'number' ? fields.metaUpdatedAt : undefined;
    if (m !== undefined) markUnsynced(id, { m });
    trackAck(id, updateDoc(doc(db, "notes", id), data), m !== undefined ? { m } : {}).catch((error: any) => {
        if (error?.code === 'unavailable' || error?.code === 'not-found') return;
        console.error("Error updating note fields in Firestore:", error);
    });
  } catch (error: any) {
    if (error?.code === 'unavailable' || error?.code === 'not-found') return;
    console.error("Error updating note fields in Firestore:", error);
  }
});

// Delete a note from Firestore
// 삭제도 같은 대기열로 보내, 먼저 요청된 저장이 삭제 뒤에 도착해 메모를 되살리지 않게 함
export const deleteNoteFromFirestore = (id: string): Promise<void> => {
  deletedIds.add(id);
  markUnsynced(id, { d: true });
  return enqueueWrite(id, async () => {
    try {
      await ensureAuth();
      // 문서를 없애는 대신 "삭제됨" 표시만 남김 → 다른 기기의 실시간 동기화·전체 불러오기가 이를 보고
      // 그 기기에서도 지움 (예전엔 문서가 그냥 사라져서 다른 기기에는 지운 메모가 계속 남았음)
      const now = Date.now();
      trackAck(id, setDoc(doc(db, "notes", id), { id, deleted: true, title: '', content: '', summary: '', sources: [], images: [], createdAt: 0, updatedAt: now, metaUpdatedAt: now, isEnhancing: false }), { d: true }).catch((error: any) => {
        if (error?.code === 'unavailable') return;
        console.error("Error deleting note from Firestore:", error);
      });
    } catch (error: any) {
      if (error.code === 'unavailable') return;
      console.error("Error deleting note from Firestore:", error);
    }
  });
};

// ----------------------------------------------------------------------------
// 앱 설정: 접속 PIN (앱 안에서 바꿀 수 있도록 Firestore에 저장)
// - PIN 자체가 아니라 salt를 섞은 SHA-256 해시만 저장합니다.
// - 메모(notes)와 섞이지 않도록 별도 컬렉션(appSettings)의 문서 1개를 씁니다.
// ----------------------------------------------------------------------------
export interface PinSetting {
    pinHash: string;
    salt: string;
    updatedAt: number;
}

const SETTINGS_COLLECTION = 'appSettings';
const PIN_DOC_ID = 'pin';

// null = 클라우드에 PIN이 아직 설정되지 않음 / 예외 = 네트워크·권한 문제로 확인 불가
export const fetchPinSetting = async (): Promise<PinSetting | null> => {
    await ensureAuth();
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, PIN_DOC_ID));
    if (!snap.exists()) return null;
    const data = snap.data() as Partial<PinSetting>;
    if (typeof data.pinHash !== 'string' || typeof data.salt !== 'string' || typeof data.updatedAt !== 'number') {
        return null;
    }
    return { pinHash: data.pinHash, salt: data.salt, updatedAt: data.updatedAt };
};

export const savePinSetting = async (setting: PinSetting): Promise<void> => {
    await ensureAuth();
    await setDoc(doc(db, SETTINGS_COLLECTION, PIN_DOC_ID), setting);
};

// ----------------------------------------------------------------------------
// 앱 설정: 자동 잠금 시간 등 (모든 기기 공통) — appSettings/prefs
// ----------------------------------------------------------------------------
export interface AppPrefs {
    idleLockMinutes?: number; // "이 기기 기억하기"를 안 한 기기의 자동 잠금 시간(분), 0 = 끔
}

export const fetchAppPrefs = async (): Promise<AppPrefs | null> => {
    await ensureAuth();
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, 'prefs'));
    return snap.exists() ? (snap.data() as AppPrefs) : null;
};

export const saveAppPrefs = async (prefs: AppPrefs): Promise<void> => {
    await ensureAuth();
    await setDoc(doc(db, SETTINGS_COLLECTION, 'prefs'), prefs, { merge: true });
};
