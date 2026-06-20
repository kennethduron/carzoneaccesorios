import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getFirebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  };
}

export async function GET() {
  const firebaseConfig = getFirebaseConfig();
  const configured = Object.values(firebaseConfig).every(Boolean) && Boolean(process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY);

  return NextResponse.json({ ok: true, configured, firebaseConfig });
}
