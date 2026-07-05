import {
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
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
  toFirestore(pin): PinDoc {
    return {
      lat: pin.lat as number,
      lng: pin.lng as number,
      address: pin.address as string,
      text: pin.text as string,
      creator: pin.creator as string,
      createdAt: Timestamp.fromDate(pin.createdAt as Date),
      lastModifier: pin.lastModifier as string,
      modifiedAt: Timestamp.fromDate(pin.modifiedAt as Date),
    };
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
