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
// FieldValue/Timestamp تُستورد مباشرة من firebase-admin/firestore بدل
// admin.firestore.* : الشكل الثاني يعتمد على خصائص ساكنة على دالة،
// وهي تختفي تحت غلاف محاكي الدوال فتفشل الكتابة محلياً. الاستيراد
// المباشر هو الشكل الموصى به ويعمل في البيئتين بلا فرق.
import { FieldValue, Timestamp } from "firebase-admin/firestore";

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
  lastVerifiedAt?: FieldValue | Timestamp;
}

export class GatewayConfigError extends Error {}

export const isGatewayConfigError = (e: unknown): e is GatewayConfigError =>
  e instanceof GatewayConfigError;

const normalizeEnvironment = (value: unknown): GatewayEnvironment =>
  value === "production" ? "production" : "sandbox";

/**
 * البيئة المحفوظة، مع قاعدة توافق خلفي واحدة.
 *
 * المستندات التي كتبتها tamaraSaveSettings/tabbySaveSettings القديمة لا تحمل
 * حقل environment أصلاً، وكان العميل القديم يستخدم مضيف *الإنتاج* دائماً
 * (tamaraClient.ts: `const TAMARA_API_URL = TAMARA_PRODUCTION_URL`). لو
 * افترضنا "تجربة" لتلك المستندات لذهب مفتاح إنتاج إلى مضيف التجربة وفشل
 * الاختبار برسالة "المفتاح غير صحيح" وهي مُضلِّلة تماماً.
 *
 * العلامة على المستند القديم ليست غياب الحقول وحده — وإلا عُدّت كل بوابة
 * *غير مُعدّة* إنتاجاً، وهو عكس الصواب تماماً. الشرط أن يحمل المستند فعلاً
 * بيانات اعتماد في جذره بالشكل القديم. أي مستند فارغ أو جديد ⇒ تجربة.
 */
function resolveEnvironment(
  data: Record<string, unknown>,
  credentialFields: readonly string[],
): GatewayEnvironment {
  if (data.environment !== undefined) {
    return normalizeEnvironment(data.environment);
  }
  const hasNewShape =
    typeof data.credentials === "object" && data.credentials !== null;
  if (hasNewShape) return "sandbox";

  const hasLegacyCredentials = credentialFields.some((field) => {
    const value = data[field];
    return typeof value === "string" && value.trim().length > 0;
  });

  return hasLegacyCredentials ? "production" : "sandbox";
}

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
    // ثلاث طبقات بالترتيب:
    //  1) credentials.{field} — الشكل الذي يكتبه السجل الجديد.
    //  2) {field} في جذر المستند — شكل tamaraSaveSettings/tabbySaveSettings
    //     القديم (apiToken / publicKey / secretKey مباشرة في الجذر). بدون
    //     هذه الطبقة تفقد المتاجر التي أعدّت تمارا أو تابي مفاتيحها عند
    //     انتقالهما إلى السجل.
    //  3) متغيّر بيئة على مستوى المشروع.
    const candidates = [stored[field], data[field]];
    let value = "";
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        value = candidate.trim();
        break;
      }
    }
    if (!value) {
      value = (process.env[envVarName(adapter.id, field)] || "").trim();
    }
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

  return {
    creds,
    environment: resolveEnvironment(data, adapter.requiredCredentials),
  };
}

/** يكتب بيانات الاعتماد ويُرجع الحالة إلى "لم تُختبر". */
export async function writeGatewayCredentials(opts: {
  storeId: string;
  gatewayId: string;
  credentials: GatewayCredentials;
  environment: GatewayEnvironment;
  uid: string;
}): Promise<{ changed: boolean }> {
  const { storeId, gatewayId, credentials, environment, uid } = opts;

  const ref = settingsRef(storeId, gatewayId);
  const existing = (await ref.get()).data() || {};
  const storedCreds = (existing.credentials || {}) as Record<string, unknown>;

  // هل تغيّر شيء فعلاً؟
  //
  // الحفظ كان يُصفّر حالة الاتصال دائماً، فالأدمن الذي يختبر بنجاح ثم يضغط
  // "حفظ الإعدادات" كان يُخفي بوابةً عاملة دون أن يدري. إعادة حفظ نفس القيم
  // ليست تغييراً، فلا تُبطل اتصالاً مُثبتاً.
  const credentialsChanged = Object.entries(credentials).some(
    ([key, value]) => storedCreds[key] !== value,
  );
  const environmentChanged = existing.environment !== environment;
  const changed = credentialsChanged || environmentChanged;

  await ref.set(
    {
      credentials: { ...storedCreds, ...credentials },
      environment,
      ...(changed
        ? {
            connection: { status: "untested" as ConnectionStatus },
            // مفتاح أو بيئة جديدة تُبطل الرمز المؤقّت المخزّن
            tokenCache: FieldValue.delete(),
          }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true },
  );

  await syncPublicStatus({ storeId, gatewayId });

  // يُعاد للنادي: رسالة "اضغط اختبار الاتصال" بعد حفظ لم يغيّر
  // شيئاً تجعل الأدمن يظنّ أن اختباره الناجح أُلغي.
  return { changed };
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
  const now = FieldValue.serverTimestamp();

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

  await syncPublicStatus({ storeId, gatewayId, minAmountSAR });
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
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await syncPublicStatus({ storeId, gatewayId });
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
  // النسخة العامة يجب أن تحمل enabled دائماً.
  //
  // كان يُكتب فقط عند تبديل المفتاح يدوياً (setGatewayEnabled)، فبوابة
  // وصلت واتصلت ولم يلمس الأدمن مفتاحها تبقى بلا الحقل في النسخة العامة،
  // ويقرأه الـ checkout undefined فيُخفيها إلى الأبد رغم أن اللوحة تعرض
  // المفتاح مُشغّلاً. كما كانت القيمتان (الخاصة والعامة) تفترقان.
  // المصدر الواحد هو المستند الخاص: الغياب يعني "مُفعّلة".
  if (patch.enabled === undefined) {
    const snap = await settingsRef(storeId, gatewayId).get();
    patch = { ...patch, enabled: snap.data()?.enabled !== false };
  }

  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    update[`paymentGateways.${gatewayId}.${key}`] =
      value === null ? FieldValue.delete() : value;
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
 * النسخة العامة = إسقاط للمستند الخاص، لا كتابة مستقلّة.
 *
 * لماذا: كانت أربعة مواضع تكتب في النسخة العامة كلٌّ بما يعرفه، فافترقت عن
 * الحقيقة. آخر ما حدث فعلياً: اختبار ناجح كتب connected: true ثم ضغطة
 * "حفظ الإعدادات" كتبت connected: false فوقه — فبقيت اللوحة تقول "متصل"
 * بينما يُخفي الـ checkout البوابة. الآن تقرأ هذه الدالة المستند الخاص
 * وتشتقّ منه كل شيء، فلا يمكن للاثنين أن يفترقا مهما كان ترتيب النداءات.
 *
 * ينادونها بعد كتابة المستند الخاص، لا قبلها.
 */
export async function syncPublicStatus(opts: {
  storeId: string;
  gatewayId: string;
  credentialFields?: readonly string[];
  minAmountSAR?: number;
}): Promise<void> {
  const { storeId, gatewayId, credentialFields = [], minAmountSAR } = opts;

  const snap = await settingsRef(storeId, gatewayId).get();
  const data = snap.data() || {};
  const connection = (data.connection || {}) as Record<string, unknown>;

  const patch: PublicGatewayStatusPatch = {
    // الغياب يعني "مُفعّلة"، نفس عرف لوحة التحكم
    enabled: data.enabled !== false,
    // متّصلة فقط إذا قال المستند الخاص ذلك
    connected: connection.status === "connected",
  };

  // البيئة تُكتب فقط عندما نعرفها حقاً: مستند قديم بلا الحقل ولا قائمة
  // بالحقول المطلوبة لا يُخمَّن له شيء، فتبقى القيمة السابقة كما هي.
  if (data.environment !== undefined || credentialFields.length > 0) {
    patch.environment = resolveEnvironment(data, credentialFields);
  }

  if (typeof minAmountSAR === "number") {
    patch.minAmountSAR = minAmountSAR;
  }
  if (connection.lastVerifiedAt instanceof Timestamp) {
    patch.lastVerifiedAt = connection.lastVerifiedAt;
  }

  await mirrorPublicStatus(storeId, gatewayId, patch);
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
  const now = FieldValue.serverTimestamp();
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
  await syncPublicStatus({ storeId, gatewayId });
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
    // نفس التوافق الخلفي: مفاتيح تمارا/تابي القديمة في جذر المستند
    const raw =
      typeof stored[field] === "string"
        ? (stored[field] as string)
        : typeof data[field] === "string"
          ? (data[field] as string)
          : "";
    fields[field] = secretFields.includes(field) ? maskSecret(raw) : raw;
  }

  const asIso = (value: unknown): string | undefined =>
    value instanceof Timestamp
      ? value.toDate().toISOString()
      : undefined;

  return {
    fields,
    environment: resolveEnvironment(data, adapter.requiredCredentials),
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
  // ثلاثة مصادر: جذر المتجر، ثم حقل "رابط المتجر" في الإعدادات (يملؤه
  // الأدمن من اللوحة)، ثم متغيّر بيئة على مستوى المشروع.
  const [rootSnap, settingsSnap] = await Promise.all([
    storeRef(storeId).get(),
    settingsRef(storeId, "store").get(),
  ]);

  const storeBlock = (settingsSnap.data()?.store || {}) as Record<
    string,
    unknown
  >;
  const candidates = [
    rootSnap.data()?.domain,
    storeBlock.storeUrl,
    process.env.STOREFRONT_BASE_URL,
  ];

  let baseUrl = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      baseUrl = candidate.trim().replace(/\/+$/, "");
      break;
    }
  }

  // لا نرمي هنا: اختبار الاتصال لا يحتاج رابط عودة إطلاقاً، وكان رميُ
  // الخطأ في هذه النقطة يمنع الأدمن من اختبار مفاتيحه أصلاً. الخطأ يقع
  // حيث تُستعمل القيمة فعلاً — عند إنشاء الدفع (requireStorefrontBaseUrl).

  const project =
    process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "";
  const region = process.env.FUNCTIONS_REGION || "us-central1";
  const functionsBaseUrl = (
    process.env.FUNCTIONS_BASE_URL ||
    (project ? `https://${region}-${project}.cloudfunctions.net` : "")
  ).replace(/\/+$/, "");

  return { storeId, environment, baseUrl, functionsBaseUrl };
}

/**
 * يتحقّق أن للمتجر رابطاً عاماً قبل إنشاء عملية دفع.
 * يُنادى عند إنشاء الدفع فقط — لا عند اختبار الاتصال.
 */
export function requireStorefrontBaseUrl(ctx: GatewayContext): string {
  if (!ctx.baseUrl) {
    throw new GatewayConfigError(
      "رابط المتجر غير مضبوط، وبدونه لا يمكن بناء روابط العودة من بوابة " +
        "الدفع. أضفه في لوحة التحكم ← الإعدادات ← المتجر ← رابط المتجر.",
    );
  }
  return ctx.baseUrl;
}
