/**
 * كل قراءة/كتابة Firestore الخاصة بإعدادات بوابات الدفع، في مكان واحد.
 *
 * الانقسام المهم:
 *  - مستند خاص  stores/{storeId}/settings/{gatewayId}  — بيانات الاعتماد
 *    والبيئة وحالة الاتصال. قواعد Firestore تجعله للأدمن فقط، ويكتبه الخادم.
 *  - نسخة عامة  stores/{storeId}/settings/store.paymentGateways[gatewayId]  —
 *    خالية من الأسرار، وهي وحدها ما يقرأه المتجر. يكتبها Admin SDK فقط
 *    (القاعدة في firestore.rules ترفض أي كتابة أدمن تلمس paymentGateways)،
 *    فـ connected: true تصريح لا يصدر إلا بعد اختبار شبكي حقيقي.
 */

import * as admin from "firebase-admin";

import { settingsRef, storeRef } from "./storePaths";
import type {
  GatewayAdapter,
  GatewayContext,
  GatewayCredentials,
  TestConnectionResult,
} from "./gatewayTypes";

export type GatewayEnvironment = "sandbox" | "production";

export type ConnectionStatus = "untested" | "connected" | "failed";

export interface PublicGatewayStatusPatch {
  enabled?: boolean;
  connected?: boolean;
  environment?: GatewayEnvironment;
  minAmountSAR?: number | null;
  lastVerifiedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp;
}

export class GatewayConfigError extends Error {}

export const isGatewayConfigError = (e: unknown): e is GatewayConfigError =>
  e instanceof GatewayConfigError;

const normalizeEnvironment = (value: unknown): GatewayEnvironment =>
  value === "production" ? "production" : "sandbox";

/** يقنّع سرّاً لعرضه للأدمن: آخر أربع خانات فقط. */
export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/** اسم متغيّر البيئة الاحتياطي، مثل MISPAY_APP_SECRET. */
const envVarName = (gatewayId: string, field: string): string =>
  `${gatewayId.toUpperCase()}_${field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()}`;

/**
 * يقرأ بيانات اعتماد بوابة لمتجر معيّن.
 *
 * طبقتان، نفس شكل initTamaraToken في index.ts: مستند الإعدادات أولاً، ثم
 * متغيّرات البيئة كاحتياطي على مستوى المشروع. يُعيد كائناً *جديداً* في كل
 * نداء؛ لا شيء يُحفظ في نطاق الوحدة، فلا تحمل حاوية دافئة مفاتيح متجر آخر.
 */
export async function loadGatewayCredentials(
  storeId: string,
  adapter: GatewayAdapter,
): Promise<{ creds: GatewayCredentials; environment: GatewayEnvironment }> {
  const snap = await settingsRef(storeId, adapter.id).get();
  const data = snap.data() || {};
  const stored = (data.credentials || {}) as Record<string, unknown>;

  const creds: GatewayCredentials = {};
  const missing: string[] = [];

  for (const field of adapter.requiredCredentials) {
    const fromDoc = stored[field];
    const value =
      typeof fromDoc === "string" && fromDoc.trim()
        ? fromDoc.trim()
        : (process.env[envVarName(adapter.id, field)] || "").trim();
    if (!value) {
      missing.push(field);
      continue;
    }
    creds[field] = value;
  }

  if (missing.length > 0) {
    throw new GatewayConfigError(
      `إعدادات البوابة غير مكتملة: الحقول الناقصة ${missing.join(", ")}`,
    );
  }

  return { creds, environment: normalizeEnvironment(data.environment) };
}

/** يكتب بيانات الاعتماد ويُرجع الحالة إلى "لم تُختبر". */
export async function writeGatewayCredentials(opts: {
  storeId: string;
  gatewayId: string;
  credentials: GatewayCredentials;
  environment: GatewayEnvironment;
  uid: string;
}): Promise<void> {
  const { storeId, gatewayId, credentials, environment, uid } = opts;

  await settingsRef(storeId, gatewayId).set(
    {
      credentials,
      environment,
      connection: { status: "untested" as ConnectionStatus },
      // أي مفتاح جديد يُبطل الرمز المؤقّت المخزّن
      tokenCache: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true },
  );

  // حفظ مفاتيح جديدة لا يعني أنها تعمل: نُخفي البوابة حتى ينجح اختبار.
  await mirrorPublicStatus(storeId, gatewayId, {
    connected: false,
    environment,
  });
}

/** يكتب نتيجة اختبار الاتصال في المستند الخاص، ويُحدّث النسخة العامة. */
export async function recordConnectionResult(opts: {
  storeId: string;
  gatewayId: string;
  environment: GatewayEnvironment;
  minAmountSAR?: number;
  result: TestConnectionResult;
}): Promise<void> {
  const { storeId, gatewayId, environment, minAmountSAR, result } = opts;
  const now = admin.firestore.FieldValue.serverTimestamp();

  await settingsRef(storeId, gatewayId).set(
    {
      environment,
      connection: {
        status: result.success ? "connected" : "failed",
        message: result.message,
        // التفصيل قد يحمل نصّ خطأ المزوّد: يبقى في المستند الخاص فقط
        detail: result.detail || null,
        lastTestedAt: now,
        ...(result.success ? { lastVerifiedAt: now } : {}),
      },
      updatedAt: now,
    },
    { merge: true },
  );

  await mirrorPublicStatus(storeId, gatewayId, {
    connected: result.success,
    environment,
    minAmountSAR: typeof minAmountSAR === "number" ? minAmountSAR : null,
    ...(result.success ? { lastVerifiedAt: now } : {}),
  });
}

/** يفعّل/يعطّل عرض البوابة للعميل دون المساس ببيانات الاعتماد. */
export async function setGatewayEnabled(
  storeId: string,
  gatewayId: string,
  enabled: boolean,
): Promise<void> {
  await settingsRef(storeId, gatewayId).set(
    {
      enabled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await mirrorPublicStatus(storeId, gatewayId, { enabled });
}

/**
 * ينسخ الحالة الخالية من الأسرار إلى المستند العام الذي يقرأه المتجر.
 * دمج بمسارات النقطة حتى لا تُمسح بوابة أخرى أو بقية إعدادات المتجر.
 */
export async function mirrorPublicStatus(
  storeId: string,
  gatewayId: string,
  patch: PublicGatewayStatusPatch,
): Promise<void> {
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    update[`paymentGateways.${gatewayId}.${key}`] =
      value === null ? admin.firestore.FieldValue.delete() : value;
  }
  if (Object.keys(update).length === 0) return;

  const ref = settingsRef(storeId, "store");
  try {
    await ref.update(update);
  } catch {
    // المستند غير موجود بعد: set + merge لا يفهم مسارات النقطة، فنبني الشكل.
    const nested: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      nested[key] = value;
    }
    await ref.set({ paymentGateways: { [gatewayId]: nested } }, { merge: true });
  }
}

/**
 * تُنادى من مسار إنشاء الدفع عندما يرفض المزوّد بيانات الاعتماد.
 * تُنزّل البوابة فوراً حتى لا يرى المشتري التالي خياراً ميّتاً.
 */
export async function markGatewayUnhealthy(
  storeId: string,
  gatewayId: string,
  reason: string,
): Promise<void> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await settingsRef(storeId, gatewayId).set(
    {
      connection: {
        status: "failed" as ConnectionStatus,
        message: "رفض المزوّد بيانات الاعتماد. أعد الاختبار من الإعدادات.",
        detail: reason,
        lastTestedAt: now,
      },
      updatedAt: now,
    },
    { merge: true },
  );
  await mirrorPublicStatus(storeId, gatewayId, { connected: false });
}

export interface GatewayAdminView {
  fields: Record<string, string>;
  environment: GatewayEnvironment;
  enabled: boolean;
  connection: {
    status: ConnectionStatus;
    message?: string;
    lastTestedAt?: string;
    lastVerifiedAt?: string;
  };
}

/** العرض الذي تُرجعه لوحة التحكم: حقول مُقنّعة + حالة محفوظة، بلا أي سرّ. */
export async function readGatewayAdminView(
  storeId: string,
  adapter: GatewayAdapter,
  secretFields: readonly string[],
): Promise<GatewayAdminView> {
  const snap = await settingsRef(storeId, adapter.id).get();
  const data = snap.data() || {};
  const stored = (data.credentials || {}) as Record<string, unknown>;
  const connection = (data.connection || {}) as Record<string, unknown>;

  const fields: Record<string, string> = {};
  for (const field of adapter.requiredCredentials) {
    const value =
      typeof stored[field] === "string" ? (stored[field] as string) : "";
    fields[field] = secretFields.includes(field) ? maskSecret(value) : value;
  }

  const asIso = (value: unknown): string | undefined =>
    value instanceof admin.firestore.Timestamp
      ? value.toDate().toISOString()
      : undefined;

  return {
    fields,
    environment: normalizeEnvironment(data.environment),
    enabled: data.enabled !== false,
    connection: {
      status: (connection.status as ConnectionStatus) || "untested",
      message:
        typeof connection.message === "string" ? connection.message : undefined,
      lastTestedAt: asIso(connection.lastTestedAt),
      lastVerifiedAt: asIso(connection.lastVerifiedAt),
    },
  };
}

/**
 * يبني سياق النداء. روابط العودة تُشتق على الخادم من stores/{storeId}.domain
 * ولا تُقبل من العميل: رابط عودة يأتي من المتصفح هو ثغرة تحويل مفتوح يراها
 * المشتري على صفحة البوابة.
 */
export async function buildGatewayContext(
  storeId: string,
  environment: GatewayEnvironment,
): Promise<GatewayContext> {
  const snap = await storeRef(storeId).get();
  const domain = snap.data()?.domain;
  const raw =
    typeof domain === "string" && domain.trim()
      ? domain.trim()
      : process.env.STOREFRONT_BASE_URL || "";
  const baseUrl = raw.replace(/\/+$/, "");

  if (!baseUrl) {
    throw new GatewayConfigError(
      `نطاق المتجر (domain) غير مضبوط في stores/${storeId}، وبدونه لا يمكن بناء روابط العودة من بوابة الدفع.`,
    );
  }

  const project =
    process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "";
  const region = process.env.FUNCTIONS_REGION || "us-central1";
  const functionsBaseUrl = (
    process.env.FUNCTIONS_BASE_URL ||
    (project ? `https://${region}-${project}.cloudfunctions.net` : "")
  ).replace(/\/+$/, "");

  return { storeId, environment, baseUrl, functionsBaseUrl };
}
