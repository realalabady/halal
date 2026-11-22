/**
 * عقد محوّل بوابة الدفع — الجانب الخادم
 *
 * كل دالة تأخذ بيانات الاعتماد كوسيط صريح. لا يوجد setter ولا حالة عامة
 * داخل الوحدة، بخلاف tamaraClient.ts / tabbyClient.ts التي تحفظ المفاتيح في
 * متغيّر على مستوى الوحدة — الدوال تُنشر مرة واحدة لكل المتاجر، فحاوية دافئة
 * تنسى إعادة التهيئة تستخدم مفاتيح متجر مع متجر آخر. الشكل هنا يجعل ذلك
 * الخطأ غير ممكن.
 */

export interface GatewayCredentials {
  [field: string]: string;
}

export interface GatewayContext {
  storeId: string;
  environment: "sandbox" | "production";
  /** أصل المتجر (https://...) لبناء روابط العودة */
  baseUrl: string;
  /** أصل دوال Cloud Functions لبناء روابط الـ callback والـ webhook */
  functionsBaseUrl: string;
}

export interface CheckoutItemInput {
  productId: string;
  name: string;
  quantity: number;
  /** سعر الوحدة كما حسبه الخادم */
  unitPrice: number;
  image?: string;
}

export interface CreateCheckoutInput {
  /** معرّفنا للطلب. يصبح أيضاً معرّف مستند pending_payments ومستند الطلب. */
  orderRef: string;
  /** الإجمالي الذي تحقّق منه الخادم — هو وحده ما تراه البوابة */
  amount: number;
  currency: string;
  subtotal: number;
  shippingAmount: number;
  vat: number;
  items: CheckoutItemInput[];
  customer: {
    name: string;
    email: string;
    mobile: string;
  };
  address: {
    city: string;
    district: string;
    street: string;
    building?: string;
  };
  returnUrl: string;
  cancelUrl: string;
  failureUrl: string;
  lang?: "ar" | "en";
}

export interface CreateCheckoutResult {
  /** الرابط الذي يُحوَّل إليه العميل */
  redirectUrl: string;
  /** مرجع البوابة: trackId / checkoutId / paymentId */
  providerRef: string;
  /** يُسجَّل مُنقّى من الأسرار، ولا يُرجَع للعميل أبداً */
  raw?: unknown;
}

export type GatewayPaymentState =
  | "paid"
  | "pending"
  | "cancelled"
  | "failed"
  | "refunded";

export interface GatewayStatusResult {
  state: GatewayPaymentState;
  /** رمز البوابة الأصلي، مثل MP00 */
  providerCode?: string;
  /** المبلغ كما تراه البوابة، للمطابقة مع إجمالي الطلب */
  amount?: number;
  raw?: unknown;
}

export interface TestConnectionResult {
  success: boolean;
  /** رسالة عربية آمنة لعرضها للأدمن */
  message: string;
  /** تفصيل خاص يُخزَّن في مستند الإعدادات فقط، لا يُعرض */
  detail?: string;
}

export interface GatewayAdapter {
  id: string;
  /** أسماء الحقول المطلوبة في مستند الإعدادات */
  requiredCredentials: readonly string[];
  minAmountSAR?: number;
  maxAmountSAR?: number;
  /**
   * يجب أن يكون نداءً شبكياً *حقيقياً*.
   * مُجرّد return { success: true } خطأ — انظر tabbyTestConnection في index.ts.
   */
  testConnection(
    creds: GatewayCredentials,
    ctx: GatewayContext,
  ): Promise<TestConnectionResult>;

  createCheckout(
    input: CreateCheckoutInput,
    creds: GatewayCredentials,
    ctx: GatewayContext,
  ): Promise<CreateCheckoutResult>;

  getStatus(
    providerRef: string,
    creds: GatewayCredentials,
    ctx: GatewayContext,
  ): Promise<GatewayStatusResult>;

  refund?(
    providerRef: string,
    amount: number,
    creds: GatewayCredentials,
    ctx: GatewayContext,
  ): Promise<void>;

  /**
   * true عندما يعني الخطأ "المفاتيح ميّتة" — وقتها نُنزّل الحالة العامة
   * إلى connected: false حتى لا يرى المشتري التالي خياراً معطّلاً.
   */
  isAuthError(error: unknown): boolean;
}

/**
 * رفض تجاري من المزوّد: المفاتيح سليمة والنداء صحيح، لكن المزوّد لم يعتمد
 * هذه العملية (تقييم المشتري، مبلغ خارج حدّه، منتج غير متاح له).
 *
 * نوع مستقلّ لأن الفرق عمليّ: خطأ داخلي يُعالَج بإعادة المحاولة، أما الرفض
 * فإعادة المحاولة لن تغيّره أبداً — على المشتري اختيار طريقة أخرى. وبلا
 * تمييز كانت رسالة المزوّد الواضحة تُبتلع خلف "حاول مرة أخرى".
 */
export class GatewayDeclinedError extends Error {
  readonly isGatewayDeclinedError = true;
  constructor(message: string) {
    super(message);
    this.name = "GatewayDeclinedError";
  }
}

export const isGatewayDeclinedError = (
  error: unknown,
): error is GatewayDeclinedError => error instanceof GatewayDeclinedError;

/** خطأ يحمل تصنيفاً حتى يميّز المحوّل أخطاء الاعتماد عن غيرها. */
export class GatewayAuthError extends Error {
  readonly isGatewayAuthError = true;
  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

export const isGatewayAuthError = (error: unknown): boolean =>
  error instanceof GatewayAuthError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { isGatewayAuthError?: boolean }).isGatewayAuthError === true);
