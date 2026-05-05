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
  getFirestore,
  onSnapshot,
  orderBy,
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
    dbInstance = getFirestore(ensureApp());
  }
  return dbInstance;
}

// Subscribes to both auth state changes AND token refreshes, so promoting a
// user to admin (which mutates the token's custom claims) propagates without
// a re-login as soon as the token refreshes.
export function watchAuth(
  callback: (info: AuthInfo | null) => void,
): () => void {
  return onIdTokenChanged(ensureAuth(), async (user) => {
    if (!user) {
      callback(null);
      return;
    }
    const result = await user.getIdTokenResult();
    callback({ user, admin: result.claims.admin === true });
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

// Force-refreshes the ID token so a freshly-set admin claim is picked up
// without signing out. The watchAuth listener fires automatically on refresh.
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

export function watchPins(callback: (pins: Pin[]) => void): () => void {
  const q = query(pinsCollection(), orderBy("modifiedAt", "desc"));
  return onSnapshot(q, (snapshot) => {
    // serverTimestamps: "estimate" substitutes the local write time for
    // unresolved server timestamps so freshly-created pins don't surface as
    // nulls in the listener that fires before server-ack.
    callback(
      snapshot.docs.map((docSnap) =>
        docSnap.data({ serverTimestamps: "estimate" }),
      ),
    );
  });
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
