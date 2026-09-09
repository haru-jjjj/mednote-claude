
import { Note } from '../types';

const DB_NAME = 'MediNoteDB';
const STORE_NAME = 'notes';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
        dbPromise = null;
        reject(request.error);
    };
    
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      let store: IDBObjectStore;
      
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      } else {
        store = (event.target as IDBOpenDBRequest).transaction!.objectStore(STORE_NAME);
      }

      // Create an index on 'updatedAt' for fast sorting/retrieval of recent notes
      if (!store.indexNames.contains('updatedAt')) {
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
  });
  return dbPromise;
};

// Fetch only a limited number of recent notes for fast startup
export const getRecentNotesFromDB = async (limit: number = 20): Promise<Note[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const notes: Note[] = [];
        
        // Use the index if available to get sorted results directly
        let request: IDBRequest;
        if (store.indexNames.contains('updatedAt')) {
            const index = store.index('updatedAt');
            request = index.openCursor(null, 'prev'); // 'prev' gives descending order (newest first)
        } else {
            // Fallback if index issue (rare)
            request = store.openCursor(null, 'prev');
        }

        request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result;
            if (cursor && notes.length < limit) {
                const note = cursor.value;
                // Exclude heavy images
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { images, ...lightweightNote } = note;
                notes.push(lightweightNote as Note);
                cursor.continue();
            } else {
                resolve(notes);
            }
        };
        request.onerror = () => reject(request.error);
    });
};

export const getAllNotesFromDB = async (): Promise<Note[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const notes: Note[] = [];
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;
      if (cursor) {
        const note = cursor.value;
        // Optimization: Exclude heavy image data (base64 strings) from the initial list view load.
        // This drastically reduces memory usage and parse time during startup.
        // We will fetch the full note with images only when opening details.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { images, ...lightweightNote } = note;
        
        // Push the lightweight version (images is undefined or empty)
        notes.push(lightweightNote as Note);
        cursor.continue();
      } else {
        resolve(notes);
      }
    };
    request.onerror = () => reject(request.error);
  });
};

export const getNoteFromDB = async (id: string): Promise<Note | undefined> => {
   const db = await openDB();
   return new Promise((resolve, reject) => {
     const transaction = db.transaction(STORE_NAME, 'readonly');
     const store = transaction.objectStore(STORE_NAME);
     const request = store.get(id);
     request.onsuccess = () => resolve(request.result);
     request.onerror = () => reject(request.error);
   });
};

export const saveNoteToDB = async (note: Note): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(note);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

export const deleteNoteFromDB = async (id: string): Promise<void> => {
    const db = await openDB();
     return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

export const saveAllNotesToDB = async (notes: Note[]): Promise<void> => {
    if (notes.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        
        notes.forEach(note => store.put(note));
    });
};
