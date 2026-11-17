/**
 * Madfu (مدفوع) — اشتر الآن وادفع لاحقاً
 * https://madfuapis.readme.io/reference/inittoken
 *
 * تدفّق الدفع على ثلاث خطوات، وهو ما يميّزه عن بقية البوابات:
 *   1) POST {api}/merchants/token/init   → رمز ابتدائي (من apiKey+appCode+Basic)
 *   2) POST {api}/Merchants/sign-in      → رمز الجلسة (من userName+password)
 *   3) POST {checkout}/Merchants/Checkout/CreateOrder → checkoutLink
 *      ثم GET {api}/Merchants/Order/OrderGet_OnlinePayment للحالة المعتمدة.
 *
 * ملاحظتان من الوثائق نفسها:
 *  - الـ webhook غير موقّع (لا توقيع ولا HMAC، فقط IP whitelisting)، فلا
 *    نثق بحمولته ونعيد السؤال دائماً عبر استعلام الحالة.
 *  - مستند الـ API يخلط حالة الأحرف (APIKey مقابل apikey، Order مقابل order).
 *    ASP.NET يربط JSON بلا حساسية لحالة الأحرف، فنستخدم شكل المخطّط الرسمي.
 */

import * as admin from "firebase-admin";
import { createHash, randomUUID } from "crypto";

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

const API_HOSTS = {
  sandbox: "https://api.staging.madfu.com.sa",
  production: "https://api.madfu.com.sa",
} as const;

/** مضيف صفحة الدفع — مختلف عن مضيف الـ API. */
const CHECKOUT_HOSTS = {
  sandbox: "https://checkout-staging.madfu.com.sa",
  production: "https://checkout.madfu.com.sa",
} as const;

/**
 * رموز حالة الطلب في Madfu.
 * الـ webhook لا يُرسل إلا 124 و125 و135 و136.
 */
export const MADFU_STATUS_CODES = {
  PENDING: "124",
  PAID: "125",
  TIMED_OUT: "135",
  EXPIRED: "136",
  REFUNDED: "140",
  REFUND_REQUESTED: "141",
  PARTIAL_REFUND: "142",
  REFUND_REJECTED: "143",
  NOT_FOUND: "404",
} as const;

const apiBase = (ctx: GatewayContext): string => API_HOSTS[ctx.environment];
const checkoutBase = (ctx: GatewayContext): string =>
  CHECKOUT_HOSTS[ctx.environment];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** الترويسات الثابتة التي يطلبها كل نداء. */
function baseHeaders(creds: GatewayCredentials): Record<string, string> {
  return {
    apikey: creds.apiKey,
    appcode: creds.appCode,
    platformTypeId: creds.platformTypeId || "5",
    Authorization: `Basic ${creds.basicToken}`,
  };
}

// ==================== سلسلة الرموز ====================
//
// مدّة صلاحية رمز الجلسة غير موثّقة. نخزّنه في مستند المتجر مع صلاحية
// محافظة (٢٠ دقيقة)، ونعيد المصادقة تلقائياً عند 401 — فلا يفشل دفع بسبب
// تقدير خاطئ للمدّة. التخزين في Firestore لا في الذاكرة: الدوال تُنشر مرة
// واحدة لكل المتاجر.

const SESSION_TTL_MS = 20 * 60 * 1000;

interface MadfuTokenCache {
  sessionToken: string;
  expiresAt: number;
  environment: string;
  apiKeyHash: string;
}

const hashKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

async function readCachedSession(
  ctx: GatewayContext,
  creds: GatewayCredentials,
): Promise<string | null> {
  const snap = await settingsRef(ctx.storeId, "madfu").get();
  const cache = snap.data()?.tokenCache as MadfuTokenCache | undefined;
  if (!cache?.sessionToken) return null;
  if (cache.environment !== ctx.environment) return null;
  if (cache.apiKeyHash !== hashKey(creds.apiKey)) return null;
  if (!(cache.expiresAt > Date.now() + 60_000)) return null;
  return cache.sessionToken;
}

async function writeCachedSession(
  ctx: GatewayContext,
  creds: GatewayCredentials,
  sessionToken: string,
): Promise<void> {
  const cache: MadfuTokenCache = {
    sessionToken,
    expiresAt: Date.now() + SESSION_TTL_MS,
    environment: ctx.environment,
    apiKeyHash: hashKey(creds.apiKey),
  };
  await settingsRef(ctx.storeId, "madfu").set({ tokenCache: cache }, { merge: true });
}

/** الخطوة ١: رمز ابتدائي من apiKey + appCode + Basic. */
async function initToken(
  creds: GatewayCredentials,
  ctx: GatewayContext,
): Promise<string> {
  const response = await gatewayRequest<{ token?: string }>(
    `${apiBase(ctx)}/merchants/token/init`,
    {
      gateway: "madfu",
      method: "POST",
      headers: baseHeaders(creds),
      body: { uuid: randomUUID(), systemInfo: "web" },
    },
  );
  const token = response?.token;
  if (!token) {
    throw new GatewayAuthError(
      "Madfu لم يُرجع الرمز الابتدائي. تحقّق من apiKey و appCode ورمز Basic.",
    );
  }
  return token;
}

export interface MadfuMerchantData {
  merchantName?: string;
  merchantid?: number;
  merchantCode?: string;
  email?: string;
  mobile?: string;
}

/** الخطوة ٢: تسجيل الدخول برمز ابتدائي + بريد وكلمة مرور التاجر. */
async function signIn(
  creds: GatewayCredentials,
  ctx: GatewayContext,
  initial: string,
): Promise<{ token: string; merchant: MadfuMerchantData }> {
  const response = await gatewayRequest<{
    token?: string;
    code?: string;
    merchantData?: MadfuMerchantData;
  }>(`${apiBase(ctx)}/Merchants/sign-in`, {
    gateway: "madfu",
    method: "POST",
    // الوثائق: الرمز يُرسل في ترويسة Token بدون البادئة Bearer
    headers: { ...baseHeaders(creds), Token: initial },
    body: { userName: creds.userName, password: creds.password },
  });

  const token = response?.token;
  if (!token) {
    throw new GatewayAuthError(
      "فشل تسجيل الدخول إلى Madfu. تحقّق من البريد وكلمة المرور.",
    );
  }
  return { token, merchant: response.merchantData || {} };
}

/** رمز جلسة صالح: من المخزن إن أمكن، وإلا init + sign-in. */
async function getSessionToken(
  creds: GatewayCredentials,
  ctx: GatewayContext,
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh) {
    const cached = await readCachedSession(ctx, creds);
    if (cached) return cached;
  }
  const initial = await initToken(creds, ctx);
  const { token } = await signIn(creds, ctx, initial);
  await writeCachedSession(ctx, creds, token);
  return token;
}

/**
 * ينفّذ نداءً مُصادقاً، ويعيد المحاولة مرة واحدة برمز جديد على 401.
 * السبب: مدّة صلاحية الرمز غير موثّقة، فالفشل بسببها متوقّع.
 */
async function authedRequest<T>(
  creds: GatewayCredentials,
  ctx: GatewayContext,
  url: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
  },
): Promise<T> {
  const call = async (token: string): Promise<T> =>
    gatewayRequest<T>(url, {
      gateway: "madfu",
      method: options.method || "GET",
      headers: { ...baseHeaders(creds), Token: token },
      body: options.body,
    });

  try {
    return await call(await getSessionToken(creds, ctx));
  } catch (error) {
    if (error instanceof GatewayHttpError && error.status === 401) {
      return call(await getSessionToken(creds, ctx, true));
    }
    throw error;
  }
}

// ==================== المحوّل ====================

interface CreateOrderResponse {
  token?: string;
  orderId?: number;
  MerchantReference?: string;
  merchantReference?: string;
  invoiceCode?: string;
  checkoutLink?: string;
}

interface OrderStatusResponse {
  order_Status?: string;
  statusCode?: string | number;
}

/** يحوّل حالة Madfu إلى حالتنا الموحّدة. */
function mapOrderStatus(
  orderStatus: string | undefined,
  statusCode: string | undefined,
): GatewayStatusResult["state"] {
  const byName = (orderStatus || "").toLowerCase();
  if (byName === "paid") return "paid";
  if (byName === "pending") return "pending";
  if (byName === "timedout" || byName === "timed out") return "failed";
  if (byName === "expired") return "failed";
  if (byName === "ordernotfound") return "failed";

  switch (statusCode) {
    case MADFU_STATUS_CODES.PAID:
      return "paid";
    case MADFU_STATUS_CODES.PENDING:
      return "pending";
    case MADFU_STATUS_CODES.REFUNDED:
    case MADFU_STATUS_CODES.PARTIAL_REFUND:
      return "refunded";
    case MADFU_STATUS_CODES.TIMED_OUT:
    case MADFU_STATUS_CODES.EXPIRED:
    case MADFU_STATUS_CODES.NOT_FOUND:
      return "failed";
    default:
      return "pending";
  }
}

/** يترجم رمز حالة الـ webhook إلى حالتنا (للسجلّ فقط — المصالحة تستعلم). */
export const madfuWebhookStateOf = (orderStatus: unknown): GatewayStatusResult["state"] =>
  mapOrderStatus(undefined, String(orderStatus ?? ""));

export const madfuAdapter: GatewayAdapter = {
  id: "madfu",
  requiredCredentials: [
    "apiKey",
    "appCode",
    "basicToken",
    "userName",
    "password",
  ] as const,

  isAuthError(error: unknown): boolean {
    if (error instanceof GatewayAuthError) return true;
    return (
      error instanceof GatewayHttpError && [401, 403].includes(error.status)
    );
  },

  /**
   * اختبار اتصال حقيقي: init + sign-in. ينجح فقط إذا كانت كل بيانات
   * الاعتماد الست صحيحة، وهي نفس السلسلة التي يستخدمها الدفع.
   */
  async testConnection(creds, ctx): Promise<TestConnectionResult> {
    try {
      const initial = await initToken(creds, ctx);
      const { token, merchant } = await signIn(creds, ctx, initial);
      await writeCachedSession(ctx, creds, token);
      const name = merchant.merchantName || merchant.merchantCode || "";
      return {
        success: true,
        message: name
          ? `تم الاتصال بـ Madfu بنجاح — التاجر: ${name}`
          : "تم الاتصال بـ Madfu بنجاح.",
        detail: `merchantId=${merchant.merchantid ?? "?"}`,
      };
    } catch (error) {
      const status =
        error instanceof GatewayHttpError ? error.status : undefined;
      const arabic =
        status === 401
          ? "بيانات الدخول إلى Madfu غير صحيحة."
          : status === 403
            ? "حساب التاجر غير متاح في Madfu."
            : "فشل الاتصال بـ Madfu.";
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
    // المخطّط يعلن Amount كـ int32 بينما الوصف يقول double. نرسل رقماً
    // بمنزلتين عشريتين؛ إن رفضه الـ sandbox فالحقل صحيح أنه عدد صحيح
    // وتحتاج هذه السطور تقريباً إلى أقرب ريال — أكّدها على البيئة التجريبية.
    const body = {
      Order: {
        Taxes: round2(input.vat),
        ActualValue: round2(input.subtotal),
        Amount: round2(input.amount),
        MerchantReference: input.orderRef,
      },
      OrderDetails: input.items.map((item) => ({
        productName: item.name,
        SKU: item.productId,
        productImage: item.image || "",
        count: item.quantity,
        totalAmount: round2(item.unitPrice * item.quantity),
      })),
      GuestOrderData: {
        CustomerMobile: input.customer.mobile,
        Lang: input.lang === "en" ? "En" : "Ar",
        CustomerName: input.customer.name,
        ShippingAddress: [
          input.address.street,
          input.address.building,
          input.address.district,
          input.address.city,
        ]
          .filter(Boolean)
          .join(", "),
      },
      MerchantUrls: {
        Success: input.returnUrl,
        Failure: input.failureUrl,
        Cancel: input.cancelUrl,
      },
    };

    const response = await authedRequest<CreateOrderResponse>(
      creds,
      ctx,
      `${checkoutBase(ctx)}/Merchants/Checkout/CreateOrder`,
      { method: "POST", body },
    );

    const invoiceCode = response?.invoiceCode;
    const link = response?.checkoutLink;
    if (!link || !invoiceCode) {
      throw new Error("Madfu لم يُرجع رابط الدفع أو invoiceCode");
    }

    // الرابط في الوثائق مكتوب بقالب {BaseUrl}Payment?token=...؛ إن عاد
    // نسبياً نبنيه على مضيف صفحة الدفع.
    const redirectUrl = /^https?:\/\//i.test(link)
      ? link
      : `${checkoutBase(ctx)}/${link.replace(/^\/+/, "")}`;

    return {
      redirectUrl,
      providerRef: invoiceCode,
      raw: { orderId: response.orderId },
    };
  },

  async getStatus(providerRef, creds, ctx): Promise<GatewayStatusResult> {
    const url = new URL(
      `${apiBase(ctx)}/Merchants/Order/OrderGet_OnlinePayment`,
    );
    url.searchParams.set("invoiceCode", providerRef);

    const response = await authedRequest<OrderStatusResponse>(
      creds,
      ctx,
      url.toString(),
      { method: "GET" },
    );

    const statusCode =
      response?.statusCode === undefined ? undefined : String(response.statusCode);

    return {
      state: mapOrderStatus(response?.order_Status, statusCode),
      providerCode: statusCode || response?.order_Status,
      // استعلام الحالة لا يُرجع المبلغ، فلا مطابقة ممكنة من هنا.
      amount: undefined,
      raw: { order_Status: response?.order_Status, statusCode },
    };
  },

  async refund(providerRef, amount, creds, ctx): Promise<void> {
    await authedRequest(creds, ctx, `${apiBase(ctx)}/api/Refund/Create`, {
      method: "POST",
      body: {
        refundAmount: round2(amount),
        merchantReference: providerRef,
        // رسوم الاسترداد تُحسب من endpoint الرسوم؛ صفر حتى يُحدّد التاجر سياسته.
        refundFees: 0,
        referenceNumber: randomUUID(),
      },
    });
  },
};

/** يمسح رمز الجلسة المخزّن (عند تغيير بيانات الاعتماد). */
export async function clearMadfuTokenCache(storeId: string): Promise<void> {
  await settingsRef(storeId, "madfu").set(
    { tokenCache: admin.firestore.FieldValue.delete() },
    { merge: true },
  );
}
