import type {
  FirestoreDataConverter,
  QueryDocumentSnapshot,
  SnapshotOptions,
  Timestamp,
} from "firebase/firestore";

export interface Pin {
  id: string;
  lat: number;
  lng: number;
  address: string;
  text: string;
  creator: string;
  createdAt: Date;
  lastModifier: string;
  modifiedAt: Date;
}

export interface PinDraft {
  lat: number;
  lng: number;
  address: string;
  text: string;
}

export interface PinDoc {
  lat: number;
  lng: number;
  address: string;
  text: string;
  creator: string;
  createdAt: Timestamp;
  lastModifier: string;
  modifiedAt: Timestamp;
}

export const pinConverter: FirestoreDataConverter<Pin, PinDoc> = {
  // pins are written raw with serverTimestamp() sentinels, never through this converter
  toFirestore(): PinDoc {
    throw new Error("pinConverter is read-only");
  },
  fromFirestore(
    snapshot: QueryDocumentSnapshot<PinDoc>,
    options?: SnapshotOptions,
  ): Pin {
    const data = snapshot.data(options);
    // without the "estimate" option an unresolved server timestamp reads as null; fall back to now
    return {
      id: snapshot.id,
      lat: data.lat,
      lng: data.lng,
      address: data.address,
      text: data.text ?? "",
      creator: data.creator,
      createdAt: data.createdAt?.toDate() ?? new Date(),
      lastModifier: data.lastModifier,
      modifiedAt: data.modifiedAt?.toDate() ?? new Date(),
    };
  },
};
