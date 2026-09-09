
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
  documentId
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
const ensureAuth = async () => {
    if (auth.currentUser) return auth.currentUser;

    try {
        const userCredential = await signInAnonymously(auth);
        return userCredential.user;
    } catch (error: any) {
        if (error.code === 'auth/network-request-failed') {
            console.warn("Firebase Auth: Network failed, operating offline.");
            return null;
        }
        console.error("Firebase Authentication Failed:", error.code, error.message);
        throw error;
    }
};

// Real-time synchronization using onSnapshot
// OPTIMIZATION: Only listen to the latest 30 notes to save API reads.
const SYNC_LIMIT = 30;

export const syncNotesFromFirestore = (onNotesUpdate: (notes: Note[]) => void) => {
  let unsubscribe: (() => void) | null = null;
  let isCancelled = false;

  const initSync = async () => {
      try {
          const user = await ensureAuth();
          
          if (isCancelled) return;

          if (!user && !auth.currentUser) {
              console.log("Firebase: Operating in offline mode (Auth failed).");
              return;
          }

          // Optimized Query: Order by updatedAt desc and Limit to recent items.
          // This prevents downloading the entire database on startup.
          const q = query(
              collection(db, "notes"), 
              orderBy("updatedAt", "desc"), 
              limit(SYNC_LIMIT)
          );
          
          unsubscribe = onSnapshot(q, (snapshot) => {
            const notes: Note[] = [];
            snapshot.forEach((doc) => {
              notes.push(doc.data() as Note);
            });
            
            // Note: sorting is technically handled by the query, but we keep client sort for safety
            notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            
            onNotesUpdate(notes);
          }, (error) => {
            if (error.code === 'unavailable' || error.message.includes('offline')) {
                console.log("Firebase: Network unavailable, sync paused.");
            } else {
                console.error("Firebase Snapshot Error:", error);
            }
          });

      } catch (e) {
          console.error("Firebase Init Sequence Failed:", e);
      }
  };

  initSync();

  return () => {
      isCancelled = true;
      if (unsubscribe) {
          unsubscribe();
      }
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

        const snapshot = await getDocs(q);
        const notes: Note[] = [];
        snapshot.forEach((doc) => {
            notes.push(doc.data() as Note);
        });
        
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
                // Exclude already seen IDs
                if (!excludedIds.includes(data.id)) {
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
                 if (!excludedIds.includes(n.id)) validCandidates.push(n);
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

// Save a note to Firestore (Add/Update)
export const saveNoteToFirestore = async (note: Note) => {
  try {
    await ensureAuth();
    const noteToSave = {
        ...note,
        updatedAt: note.updatedAt || Date.now()
    };
    await setDoc(doc(db, "notes", note.id), noteToSave);
  } catch (error: any) {
    if (error.code === 'unavailable') return;
    console.error("Error saving note to Firestore:", error);
  }
};

// Delete a note from Firestore
export const deleteNoteFromFirestore = async (id: string) => {
  try {
    await ensureAuth();
    await deleteDoc(doc(db, "notes", id));
  } catch (error: any) {
    if (error.code === 'unavailable') return;
    console.error("Error deleting note from Firestore:", error);
  }
};
