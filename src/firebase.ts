import { type FirebaseApp, initializeApp } from "firebase/app";
import {
  type Auth,
  getAuth,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import {
  addDoc,
  type CollectionReference,
  collection,
  deleteDoc,
  doc,
  type Firestore,
  type FirestoreError,
  initializeFirestore,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { type Pin, type PinDraft, pinConverter } from "./pin";

const firebaseConfig = {
  apiKey: "AIzaSyCUNeUTKnRphdhQ-QdR3-7-sACkaJqVPwU",
  authDomain: "hafaio-scenic-route.firebaseapp.com",
  projectId: "hafaio-scenic-route",
  storageBucket: "hafaio-scenic-route.firebasestorage.app",
  messagingSenderId: "988452416366",
  appId: "1:988452416366:web:1f265001362929a156ef7f",
};

const PINS = "pins";

export interface AuthInfo {
  user: User;
  admin: boolean;
}

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function isFirebaseConfigured(): boolean {
  return (
    !firebaseConfig.apiKey.startsWith("REPLACE_ME") &&
    !firebaseConfig.projectId.startsWith("REPLACE_ME")
  );
}

function ensureApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase is not configured");
  }
  if (!app) {
    app = initializeApp(firebaseConfig);
  }
  return app;
}

function ensureAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(ensureApp());
  }
  return authInstance;
}

function ensureDb(): Firestore {
  if (!dbInstance) {
    dbInstance = initializeFirestore(ensureApp(), {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  }
  return dbInstance;
}

// onIdTokenChanged (not onAuthStateChanged) so an admin promotion propagates on token refresh without re-login
export function watchAuth(
  callback: (info: AuthInfo | null) => void,
): () => void {
  let latestInvocation = 0;
  return onIdTokenChanged(ensureAuth(), async (user) => {
    const invocation = ++latestInvocation;
    if (!user) {
      callback(null);
      return;
    }
    // fall back to a non-admin session on a failed token refresh
    let admin = false;
    try {
      const result = await user.getIdTokenResult();
      admin = result.claims.admin === true;
    } catch {}
    // drop stale completions so a late token fetch can't revive a signed-out session
    if (invocation !== latestInvocation) {
      return;
    }
    callback({ user, admin });
  });
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(ensureAuth(), email, password);
}

export async function signOutUser(): Promise<void> {
  await signOut(ensureAuth());
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(ensureAuth(), email);
}

// force-refresh so a newly-granted admin claim is picked up without re-login; watchAuth then re-fires
export async function refreshClaims(): Promise<void> {
  const user = ensureAuth().currentUser;
  if (!user) {
    return;
  }
  await user.getIdToken(true);
}

function rawPinsCollection(): CollectionReference {
  return collection(ensureDb(), PINS);
}

function pinsCollection() {
  return rawPinsCollection().withConverter(pinConverter);
}

export function watchPins(
  callback: (pins: Pin[]) => void,
  onError?: (error: FirestoreError) => void,
): () => void {
  const q = query(pinsCollection(), orderBy("modifiedAt", "desc"));
  return onSnapshot(
    q,
    (snapshot) => {
      // "estimate" so freshly-created pins don't surface as null before server-ack
      callback(
        snapshot.docs.map((docSnap) =>
          docSnap.data({ serverTimestamps: "estimate" }),
        ),
      );
    },
    (error) => {
      onError?.(error);
    },
  );
}

export async function createPin(uid: string, draft: PinDraft): Promise<string> {
  const ref = await addDoc(rawPinsCollection(), {
    lat: draft.lat,
    lng: draft.lng,
    address: draft.address,
    text: draft.text,
    creator: uid,
    createdAt: serverTimestamp(),
    lastModifier: uid,
    modifiedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updatePin(
  uid: string,
  pinId: string,
  fields: Partial<Pick<PinDraft, "text" | "address" | "lat" | "lng">>,
): Promise<void> {
  const ref = doc(rawPinsCollection(), pinId);
  await updateDoc(ref, {
    ...fields,
    lastModifier: uid,
    modifiedAt: serverTimestamp(),
  });
}

export async function deletePin(pinId: string): Promise<void> {
  const ref = doc(rawPinsCollection(), pinId);
  await deleteDoc(ref);
}
