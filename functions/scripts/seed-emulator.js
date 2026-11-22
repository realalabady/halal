/**
 * تعبئة محاكي Firestore/Auth ببيانات متجر كاملة للاختبار اليدوي.
 *
 * التشغيل (مع محاكي يعمل):
 *   node functions/scripts/seed-emulator.js
 *
 * ينشئ: متجر demostore بنطاق محلي، إعدادات، منتجات، ومستخدماً أدمن
 * (admin@test.local / Test123456) يمكن الدخول به من واجهة المتجر.
 */

/* eslint-disable no-console */

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

const admin = require("firebase-admin");

const PROJECT = process.env.GCLOUD_PROJECT || "estore-8f76b";
const STORE = process.env.SEED_STORE_ID || "demostore";
const BASE_URL = process.env.SEED_BASE_URL || "http://localhost:5173";
const EMAIL = "admin@test.local";
const PASSWORD = "Test123456";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const auth = admin.auth();

async function main() {
  // --- مستخدم أدمن ---
  let user;
  try {
    user = await auth.getUserByEmail(EMAIL);
  } catch {
    user = await auth.createUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: "مدير الاختبار",
      emailVerified: true,
    });
  }

  // --- جذر المتجر: domain هو ما تبني منه الدوال روابط العودة ---
  await db.doc(`stores/${STORE}`).set({
    name: "متجر الاختبار",
    domain: BASE_URL,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // --- الإعدادات العامة ---
  await db.doc(`stores/${STORE}/settings/store`).set({
    store: {
      storeName: "متجر الاختبار",
      storeEmail: "shop@test.local",
      storePhone: "0500000000",
      storeAddress: "الرياض، حي النخيل، شارع الأمير",
      storeUrl: BASE_URL,
      currency: "SAR",
      language: "ar",
      bankName: "",
      bankIban: "",
    },
    shipping: {
      freeShippingThreshold: 500,
      defaultShippingCost: 25,
      enableFreeShipping: true,
      estimatedDays: "3-5",
    },
    notifications: {
      orderNotifications: true,
      lowStockAlert: true,
      customerMessages: true,
      marketingEmails: false,
      lowStockThreshold: 3,
    },
    payment: {
      methods: [
        { id: "cash", name: "الدفع عند الاستلام", enabled: true },
        { id: "bank", name: "تحويل بنكي", enabled: false },
        { id: "emkan", name: "إمكان - تقسيط", enabled: true },
      ],
    },
  });

  // --- دور الأدمن داخل هذا المتجر ---
  await db.doc(`stores/${STORE}/users/${user.uid}`).set({
    email: EMAIL,
    name: "مدير الاختبار",
    role: "admin",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // --- منتجات ---
  const products = [
    { id: "prod-1", name: "خروف نعيمي", price: 1800, stock: 10 },
    { id: "prod-2", name: "خروف حري", price: 95, stock: 10 },
  ];
  for (const p of products) {
    await db.doc(`stores/${STORE}/products/${p.id}`).set({
      name: p.name,
      description: "منتج اختبار",
      price: p.price,
      stock: p.stock,
      category: "أغنام",
      images: [],
      featured: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  console.log("تمت التعبئة:");
  console.log("  المتجر   :", STORE, "->", BASE_URL);
  console.log("  الأدمن   :", EMAIL, "/", PASSWORD, "(uid:", user.uid + ")");
  console.log("  المنتجات :", products.map((p) => `${p.name} ${p.price}ر.س`).join("، "));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("فشلت التعبئة:", error);
    process.exit(1);
  },
);
