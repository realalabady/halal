/**
 * MIS Pay — اشتر الآن وادفع لاحقاً
 * https://doc.mispay.co/docs/api-integration
 *
 * تدفّق الدفع:
 *   GET  /token                  → مغلّف مشفّر AES-256-GCM يُفكّ بـ appSecret ⇒ JWT صالح ٨ ساعات
 *   POST /start-checkout         → { url, trackId } ونحوّل العميل إلى url
 *   GET  /track-checkout/{id}    → الحالة المعتمدة (نحن نسأل الخادم، لا نثق بالعودة)
 *   POST /refund
 *
 * لا حالة قابلة للتغيير في نطاق هذه الوحدة: كل دالة تأخذ بيانات الاعتماد
 * وسيطاً، والـ JWT يُخزَّن في Firestore داخل مستند المتجر نفسه — لا في الذاكرة —
 * فلا تحمل حاوية دافئة رمز متجر إلى متجر آخر.
 */

import * as admin from "firebase-admin";
import {
  createDecipheriv,
  createHash,
  randomUUID,
  timingSafeEqual,
} from "crypto";

import { settingsRef } from "./storePaths";
import {
  GatewayHttpError,
  describeGatewayError,
  gatewayRequest,
} from "./gatewayHttp";
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  GatewayAdapter,
  GatewayContext,
  GatewayCredentials,
  GatewayStatusResult,
  TestConnectionResult,
} from "./gatewayTypes";
import { GatewayAuthError } from "./gatewayTypes";

const HOSTS = {
  sandbox: "https://api-sandbox.mispay.dev/v1/api",
  production: "https://api.mispay.co/v1/api",
} as const;

/** الحد الأدنى الذي يرفضه المزوّد برمز ME13. */
export const MISPAY_MIN_AMOUNT_SAR = 145;

/** رموز حالة MIS Pay. */
export const MISPAY_CODES = {
  SUCCESS: "MP00",
  TIMEOUT: "MP01",
  CANCELED: "MP02",
  REFUNDED: "MP03",
} as const;

/** أخطاء اعتماد: معرّف أو سرّ خاطئ، أو رمز غير صالح/منتهٍ. */
const AUTH_ERROR_CODES = ["ME01", "ME02", "ME03", "ME10", "ME11"];

const baseUrl = (ctx: GatewayContext): string => HOSTS[ctx.environment];

// ==================== فكّ التشفير (AES-256-GCM) ====================
//
// الوثائق تقول "فُكّ الرمز بـ AES-256-GCM باستخدام x-app-secret" ولا تذكر
// طول الـ IV، ولا موضع الـ tag، ولا كيف يُشتقّ المفتاح من السرّ. وهي تُحوّل
// المطوّر إلى حِزم PHP/JS الرسمية.
//
// الحل هنا لا يخمّن: GCM مُستوثَق، فالـ tag نفسه يقول إن التخطيط صحيح.
// نجرّب التخطيطات المعقولة ونقبل أول واحد يجتاز التحقق، ثم نسجّل أيّها نجح
// حتى يُثبَّت في الكود بعد أول اتصال حقيقي بالـ sandbox.

type KeyDerivation = "utf8" | "sha256" | "base64" | "hex";

interface BlobLayout {
  ivLength: number;
  tagPosition: "suffix" | "prefix";
  derivation: KeyDerivation;
}

const CANDIDATE_LAYOUTS: BlobLayout[] = [];
for (const derivation of ["utf8", "sha256", "base64", "hex"] as KeyDerivation[]) {
  for (const ivLength of [12, 16]) {
    for (const tagPosition of ["suffix", "prefix"] as const) {
      CANDIDATE_LAYOUTS.push({ ivLength, tagPosition, derivation });
    }
  }
}

const TAG_LENGTH = 16;

function deriveKey(secret: string, derivation: KeyDerivation): Buffer | null {
  let key: Buffer;
  switch (derivation) {
    case "utf8":
      key = Buffer.from(secret, "utf8");
      break;
    case "sha256":
      key = createHash("sha256").update(secret, "utf8").digest();
      break;
    case "base64":
      try {
        key = Buffer.from(secret, "base64");
      } catch {
        return null;
      }
      break;
    case "hex":
      if (!/^[0-9a-fA-F]+$/.test(secret)) return null;
      key = Buffer.from(secret, "hex");
      break;
  }
  return key.length === 32 ? key : null;
}

function tryLayout(
  raw: Buffer,
  secret: string,
  layout: BlobLayout,
): string | null {
  const key = deriveKey(secret, layout.derivation);
  if (!key) return null;
  if (raw.length <= layout.ivLength + TAG_LENGTH) return null;

  const iv = raw.subarray(0, layout.ivLength);
  const rest = raw.subarray(layout.ivLength);
  const tag =
    layout.tagPosition === "suffix"
      ? rest.subarray(rest.length - TAG_LENGTH)
      : rest.subarray(0, TAG_LENGTH);
  const ciphertext =
    layout.tagPosition === "suffix"
      ? rest.subarray(0, rest.length - TAG_LENGTH)
      : rest.subarray(TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    // نقبل فقط ما يبدو حمولة MIS Pay: JSON كائن
    return out.trimStart().startsWith("{") ? out : null;
  } catch {
    return null;
  }
}

/**
 * يفكّ مغلّفاً مشفّراً من MIS Pay (الرمز أو حمولة العودة) إلى نصّه.
 * يُسجّل التخطيط الناجح؛ ثبّته في الكود بعد أول نجاح على الـ sandbox.
 */
export function decryptMisPayBlob(blobBase64: string, appSecret: string): string {
  const raw = Buffer.from(blobBase64, "base64");
  if (raw.length === 0) {
    throw new Error("مغلّف MIS Pay فارغ أو ليس base64 صحيحاً");
  }

  for (const layout of CANDIDATE_LAYOUTS) {
    const plain = tryLayout(raw, appSecret, layout);
    if (plain !== null) {
      console.log(
        `[mispay] تخطيط AES-GCM المطابق: iv=${layout.ivLength} tag=${layout.tagPosition} key=${layout.derivation}`,
      );
      return plain;
    }
  }

  throw new Error(
    "تعذّر فكّ تشفير مغلّف MIS Pay بأي تخطيط معروف. راجع كود المزوّد الرسمي " +
      "(حِزم PHP/JS) وثبّت التخطيط في mispayClient.ts.",
  );
}

export interface MisPayCallbackPayload {
  orderId: string;
  code: string;
  checkoutId: string;
}

/** يفكّ حمولة رابط العودة  ?_=<base64>  إلى { orderId, code, checkoutId }. */
export function decryptMisPayCallback(
  blobBase64: string,
  appSecret: string,
): MisPayCallbackPayload {
  const parsed = JSON.parse(decryptMisPayBlob(blobBase64, appSecret)) as Record<
    string,
    unknown
  >;
  const orderId = String(parsed.orderId ?? "");
  if (!orderId) throw new Error("حمولة العودة من MIS Pay بلا orderId");
  return {
    orderId,
    code: String(parsed.code ?? ""),
    checkoutId: String(parsed.checkoutId ?? ""),
  };
}

/** مقارنة ثابتة الزمن لمعرّفات التطبيق في الـ webhook. */
export function appIdMatches(a: string, b: string): boolean {
  const left = Buffer.from(a || "", "utf8");
  const right = Buffer.from(b || "", "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// ==================== الرمز (JWT) ====================

interface TokenCache {
  jwt: string;
  expiresAt: number;
  environment: string;
  appIdHash: string;
}

const hashAppId = (appId: string): string =>
  createHash("sha256").update(appId).digest("hex").slice(0, 16);

/** هامش أمان قبل انتهاء الرمز. */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

async function readCachedJwt(
  ctx: GatewayContext,
  appId: string,
): Promise<string | null> {
  const snap = await settingsRef(ctx.storeId, "mispay").get();
  const cache = snap.data()?.tokenCache as TokenCache | undefined;
  if (!cache?.jwt) return null;
  if (cache.environment !== ctx.environment) return null;
  if (cache.appIdHash !== hashAppId(appId)) return null;
  if (!(cache.expiresAt > Date.now() + TOKEN_SKEW_MS)) return null;
  return cache.jwt;
}

async function writeCachedJwt(
  ctx: GatewayContext,
  appId: string,
  jwt: string,
  expiresAt: number,
): Promise<void> {
  const cache: TokenCache = {
    jwt,
    expiresAt,
    environment: ctx.environment,
    appIdHash: hashAppId(appId),
  };
  await settingsRef(ctx.storeId, "mispay").set({ tokenCache: cache }, { merge: true });
}

interface TokenResponse {
  status?: string;
  result?: { token?: string };
}

/** ينتزع تاريخ الانتهاء من حمولة الرمز المفكوكة، أو يفترض ٨ ساعات. */
function parseExpiry(payload: Record<string, unknown>): number {
  const raw = payload.expiration ?? payload.expiresAt ?? payload.exp;
  if (typeof raw === "number") {
    // ثوان أو ميلي ثانية
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 8 * 60 * 60 * 1000;
}

/** يجلب رمز JWT صالحاً، من مخزن المتجر إن أمكن وإلا من /token. */
async function getJwt(
  creds: GatewayCredentials,
  ctx: GatewayContext,
): Promise<string> {
  const appId = creds.appId;
  const cached = await readCachedJwt(ctx, appId);
  if (cached) return cached;

  const response = await gatewayRequest<TokenResponse>(
    `${baseUrl(ctx)}/token`,
    {
      gateway: "mispay",
      method: "GET",
      headers: { "x-app-id": appId, "x-app-secret": creds.appSecret },
    },
  );

  const blob = response?.result?.token;
  if (!blob) {
    throw new GatewayAuthError(
      "MIS Pay لم يُرجع رمزاً. تحقّق من معرّف التطبيق والسرّ.",
    );
  }

  const payload = JSON.parse(decryptMisPayBlob(blob, creds.appSecret)) as Record<
    string,
    unknown
  >;
  const jwt = typeof payload.token === "string" ? payload.token : "";
  if (!jwt) {
    throw new Error("حمولة رمز MIS Pay المفكوكة بلا حقل token");
  }

  const expiresAt = parseExpiry(payload);
  await writeCachedJwt(ctx, appId, jwt, expiresAt);
  return jwt;
}

/** ترويسات أي نداء بعد الحصول على الرمز. */
async function authHeaders(
  creds: GatewayCredentials,
  ctx: GatewayContext,
): Promise<Record<string, string>> {
  const jwt = await getJwt(creds, ctx);
  return { authorization: `Bearer ${jwt}`, "x-app-id": creds.appId };
}

/** يستخرج رمز خطأ MIS Pay (MExx) من جسم الرد. */
function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof GatewayHttpError)) return null;
  const body = error.body;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const match = text.match(/ME\d{2}/);
  return match ? match[0] : null;
}

// ==================== المحوّل ====================

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface StartCheckoutResponse {
  status?: string;
  result?: { url?: string; trackId?: string };
}

interface TrackCheckoutResponse {
  status?: string;
  result?: {
    checkoutId?: string;
    orderId?: string;
    purchaseAmount?: number | string;
    purchaseCurrency?: string;
    status?: string;
  };
}

/** يحوّل حالة MIS Pay النصّية إلى حالتنا الموحّدة. */
function mapTrackStatus(raw: string | undefined): GatewayStatusResult["state"] {
  switch ((raw || "").toLowerCase()) {
    case "success":
      return "paid";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
    case "refunded":
      return "refunded";
    case "pending":
    case "in-progress":
    default:
      return "pending";
  }
}

export const misPayAdapter: GatewayAdapter = {
  id: "mispay",
  requiredCredentials: ["appId", "appSecret"] as const,
  minAmountSAR: MISPAY_MIN_AMOUNT_SAR,

  isAuthError(error: unknown): boolean {
    if (error instanceof GatewayAuthError) return true;
    const code = errorCodeOf(error);
    if (code && AUTH_ERROR_CODES.includes(code)) return true;
    return error instanceof GatewayHttpError && [401, 403].includes(error.status);
  },

  /**
   * اختبار اتصال حقيقي: GET /token يتحقّق من x-app-id و x-app-secret
   * (ME01/ME02/ME03 عند الخطأ) ثم نفكّ المغلّف — فينجح الاختبار فقط إذا كان
   * السرّ صحيحاً *و* قادراً على فكّ التشفير، وهو ما سيستخدمه الدفع فعلاً.
   */
  async testConnection(creds, ctx): Promise<TestConnectionResult> {
    try {
      const jwt = await getJwt(creds, ctx);
      return {
        success: true,
        message: `تم الاتصال بـ MIS Pay بنجاح (${
          ctx.environment === "production" ? "الإنتاج" : "التجربة"
        }).`,
        detail: `jwt length=${jwt.length}`,
      };
    } catch (error) {
      const code = errorCodeOf(error);
      const arabic =
        code === "ME01"
          ? "معرّف التطبيق (App ID) مفقود."
          : code === "ME02"
            ? "سرّ التطبيق (App Secret) مفقود."
            : code === "ME03"
              ? "معرّف التطبيق أو السرّ غير صحيح."
              : "فشل الاتصال بـ MIS Pay.";
      return {
        success: false,
        message: arabic,
        detail: describeGatewayError(error),
      };
    }
  },

  async createCheckout(
    input: CreateCheckoutInput,
    creds,
    ctx,
  ): Promise<CreateCheckoutResult> {
    if (input.amount < MISPAY_MIN_AMOUNT_SAR) {
      throw new Error(
        `MIS Pay لا يقبل أقل من ${MISPAY_MIN_AMOUNT_SAR} ر.س (ME13).`,
      );
    }

    const headers = await authHeaders(creds, ctx);

    const body = {
      // الوثائق تُلزم بهذه القيمة بالحرف
      version: "v1.2",
      orderId: input.orderRef,
      invoiceId: input.orderRef,
      serialNumber: randomUUID(),
      // الوثائق: purchaseAmount = totalPrice + shippingAmount + vat - discount
      // أسعار المتجر شاملة للضريبة، فـ totalPrice هو الصافي بعد نزع حصّتها،
      // وبذلك تتحقّق المعادلة ويبقى purchaseAmount مساوياً للإجمالي المستحق.
      totalPrice: String(round2(input.subtotal - input.vat)),
      shippingAmount: String(round2(input.shippingAmount)),
      vat: String(round2(input.vat)),
      purchaseAmount: String(round2(input.amount)),
      purchaseCurrency: input.currency,
      lang: input.lang === "en" ? "en" : "ar",
      isMobile: false,
      callbackUri: input.returnUrl,
      customerDetails: {
        mobileNumber: input.customer.mobile,
        firstName: input.customer.name.split(" ")[0] || input.customer.name,
        lastName: input.customer.name.split(" ").slice(1).join(" ") || undefined,
        email: input.customer.email || undefined,
      },
      shippingDetails: {
        firstName: input.customer.name.split(" ")[0] || input.customer.name,
        lastName: input.customer.name.split(" ").slice(1).join(" ") || undefined,
        countryCode: "SA",
        city: input.address.city,
        district: input.address.district,
        line1: input.address.street,
        line2: input.address.building || undefined,
      },
      orderDetails: {
        items: input.items.map((item) => ({
          id: item.productId,
          sku: item.productId,
          nameArabic: item.name,
          nameEnglish: item.name,
          quantity: String(item.quantity),
          unitPrice: String(round2(item.unitPrice)),
          imageUrl: item.image || undefined,
        })),
      },
    };

    const response = await gatewayRequest<StartCheckoutResponse>(
      `${baseUrl(ctx)}/start-checkout`,
      { gateway: "mispay", method: "POST", headers, body },
    );

    const url = response?.result?.url;
    const trackId = response?.result?.trackId;
    if (!url || !trackId) {
      throw new Error("MIS Pay لم يُرجع رابط الدفع أو trackId");
    }

    // الوثائق: الرابط خاصّ بهذه العملية ولا يُخزَّن ولا يُشارَك.
    return { redirectUrl: url, providerRef: trackId };
  },

  async getStatus(providerRef, creds, ctx): Promise<GatewayStatusResult> {
    const headers = await authHeaders(creds, ctx);
    const response = await gatewayRequest<TrackCheckoutResponse>(
      `${baseUrl(ctx)}/track-checkout/${encodeURIComponent(providerRef)}`,
      { gateway: "mispay", method: "GET", headers },
    );

    const result = response?.result || {};
    const amount =
      result.purchaseAmount === undefined
        ? undefined
        : Number(result.purchaseAmount);

    return {
      state: mapTrackStatus(result.status),
      providerCode: result.status,
      amount: Number.isFinite(amount) ? amount : undefined,
      raw: { checkoutId: result.checkoutId, status: result.status },
    };
  },

  async refund(providerRef, amount, creds, ctx): Promise<void> {
    const headers = await authHeaders(creds, ctx);
    await gatewayRequest(`${baseUrl(ctx)}/refund`, {
      gateway: "mispay",
      method: "POST",
      headers,
      body: {
        purchaseId: providerRef,
        amount: String(round2(amount)),
        currency: "SAR",
        merchantRefundId: randomUUID(),
      },
    });
  },
};

/**
 * عناوين IP التي يُرسل منها MIS Pay الـ webhook (الوثائق).
 * الـ webhook غير موقّع — لا توقيع ولا HMAC — فهذه القائمة هي كل ما نملك،
 * ولذلك لا نثق بالحمولة أبداً: المصالحة تعيد السؤال عبر track-checkout.
 */
export const MISPAY_WEBHOOK_IPS = {
  sandbox: ["34.166.87.228", "34.18.98.212", "34.1.37.179"],
  production: ["34.166.244.41", "34.166.229.134", "34.166.83.56"],
} as const;

/** يمسح الرمز المخزّن (يُستخدم عند تغيير المفاتيح). */
export async function clearMisPayTokenCache(storeId: string): Promise<void> {
  await settingsRef(storeId, "mispay").set(
    { tokenCache: admin.firestore.FieldValue.delete() },
    { merge: true },
  );
}
