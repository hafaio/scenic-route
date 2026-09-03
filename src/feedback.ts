import type {
  FirestoreDataConverter,
  QueryDocumentSnapshot,
  SnapshotOptions,
  Timestamp,
} from "firebase/firestore";

export interface Feedback {
  id: string;
  text: string;
  createdAt: Date;
}

export interface FeedbackDoc {
  text: string;
  createdAt: Timestamp;
}

export const feedbackConverter: FirestoreDataConverter<Feedback, FeedbackDoc> =
  {
    // notes are written raw with a serverTimestamp() sentinel, never through this converter
    toFirestore(): FeedbackDoc {
      throw new Error("feedbackConverter is read-only");
    },
    fromFirestore(
      snapshot: QueryDocumentSnapshot<FeedbackDoc>,
      options?: SnapshotOptions,
    ): Feedback {
      const data = snapshot.data(options);
      // without the "estimate" option an unresolved server timestamp reads as null; fall back to now
      return {
        id: snapshot.id,
        text: data.text ?? "",
        createdAt: data.createdAt?.toDate() ?? new Date(),
      };
    },
  };
