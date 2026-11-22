// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectStorageEmulator, getStorage } from "firebase/storage";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// تحذير مبكر وواضح إذا لم تُضبط متغيرات البيئة (مثلاً على Vercel).
// بدون projectId يفشل Firebase عند الإقلاع وتظهر صفحة بيضاء.
if (!firebaseConfig.projectId) {
  console.error(
    "[Firebase] متغيرات البيئة غير مضبوطة. تأكد من إضافة متغيرات " +
      "VITE_FIREBASE_* في إعدادات Vercel (Environment Variables) ثم أعد النشر.",
  );
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

/**
 * وضع المحاكي (Firebase Emulators) — للتطوير والاختبار فقط.
 *
 * يُفعَّل بـ VITE_USE_EMULATORS=true في .env.local. يسمح بتشغيل التدفّق
 * كاملاً (لوحة التحكم، بوابات الدفع، الطلبات) على بيانات محلية دون لمس
 * مشروع الإنتاج. لا أثر له في البناء الحقيقي لأن المتغيّر غير مضبوط هناك.
 */
export const usingEmulators =
  import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "true";

if (usingEmulators) {
  const host = "127.0.0.1";
  connectFirestoreEmulator(db, host, 8080);
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectStorageEmulator(storage, host, 9199);
  connectFunctionsEmulator(getFunctions(app), host, 5001);
  console.warn("[Firebase] وضع المحاكي مُفعّل — لا تُستخدم بيانات الإنتاج.");
}

// Analytics اختياري: نهيّئه فقط عند دعمه ووجود measurementId، وبشكل غير
// حاجب حتى لا يتسبب فشله (أو حظره بمانع إعلانات) في تعطيل التطبيق بالكامل.
export let analytics: Analytics | null = null;
if (typeof window !== "undefined" && firebaseConfig.measurementId) {
  isSupported()
    .then((supported) => {
      if (supported) {
        analytics = getAnalytics(app);
      }
    })
    .catch(() => {
      /* تجاهل: Analytics غير متاح */
    });
}

export default app;
