/**
 * يُعدّ بوابة في المحاكي تماماً كما تفعل لوحة التحكم.
 *
 * يستدعي نفس دوال gatewayStore التي تستدعيها الدالة السحابية، فما يُكتب
 * هنا هو ما يكتبه حفظ الإعدادات + اختبار اتصال ناجح.
 *
 *   node functions/scripts/seed-emulator-gateway.js [gatewayId] [--fail]
 */

/* eslint-disable no-console */

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const admin = require("firebase-admin");

const PROJECT = process.env.GCLOUD_PROJECT || "estore-8f76b";
const STORE = process.env.SEED_STORE_ID || "demostore";
const gatewayId = process.argv[2] || "mockpay";
const shouldFail = process.argv.includes("--fail");

admin.initializeApp({ projectId: PROJECT });

const store = require("../lib/gatewayStore");
const registry = require("../lib/gatewayRegistry");

async function main() {
  const adapter = registry.GATEWAY_ADAPTERS[gatewayId];
  if (!adapter) {
    throw new Error(
      `بوابة غير معروفة: ${gatewayId}. المتاح: ${Object.keys(registry.GATEWAY_ADAPTERS).join(", ")}`,
    );
  }

  // ١) حفظ بيانات الاعتماد — نفس ما يفعله paymentGatewaySaveSettings
  const credentials = {};
  for (const field of adapter.requiredCredentials) {
    credentials[field] = shouldFail ? `bad_${field}` : `test_${field}`;
  }
  await store.writeGatewayCredentials({
    storeId: STORE,
    gatewayId,
    credentials,
    environment: "sandbox",
    uid: "seed-script",
  });

  // ٢) اختبار اتصال حقيقي عبر المحوّل — نفس ما يفعله paymentGatewayTestConnection
  const { creds, environment } = await store.loadGatewayCredentials(
    STORE,
    adapter,
  );
  const ctx = await store.buildGatewayContext(STORE, environment);
  const result = await adapter.testConnection(creds, ctx);

  await store.recordConnectionResult({
    storeId: STORE,
    gatewayId,
    environment,
    minAmountSAR: adapter.minAmountSAR,
    result,
  });

  const mirror = (
    await admin.firestore().doc(`stores/${STORE}/settings/store`).get()
  ).data().paymentGateways[gatewayId];

  console.log(`البوابة  : ${gatewayId}`);
  console.log(`الاختبار : ${result.success ? "نجح" : "فشل"} — ${result.message}`);
  console.log("النسخة العامة:", JSON.stringify(mirror));
  console.log(
    "تظهر للعميل:",
    mirror.connected === true && mirror.enabled !== false ? "نعم" : "لا",
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("فشل:", error);
    process.exit(1);
  },
);
