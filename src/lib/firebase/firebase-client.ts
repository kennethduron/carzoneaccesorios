import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getMessaging, isSupported, type Messaging } from "firebase/messaging";

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

let messagingPromise: Promise<Messaging | null> | null = null;

export function getFirebaseWebConfig(): FirebaseWebConfig {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  };
}

export function getFirebaseVapidKey() {
  return process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ?? "";
}

export function isFirebaseWebConfigured() {
  const config = getFirebaseWebConfig();
  return Boolean(
    config.apiKey &&
      config.authDomain &&
      config.projectId &&
      config.storageBucket &&
      config.messagingSenderId &&
      config.appId &&
      getFirebaseVapidKey(),
  );
}

function getFirebaseApp(): FirebaseApp | null {
  if (!isFirebaseWebConfigured()) {
    return null;
  }

  return getApps().length ? getApp() : initializeApp(getFirebaseWebConfig());
}

export async function getFirebaseMessagingClient() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!messagingPromise) {
    messagingPromise = isSupported()
      .then((supported) => {
        if (!supported) return null;
        const app = getFirebaseApp();
        return app ? getMessaging(app) : null;
      })
      .catch(() => null);
  }

  return messagingPromise;
}
