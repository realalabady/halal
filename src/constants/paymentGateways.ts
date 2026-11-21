/**
 * سجل بوابات الدفع — الجانب العميل (المتصفح)
 *
 * هذا الملف يحمل *فقط* ما يسمح للمتصفح بمعرفته: المعرّف، الأسماء العربية،
 * مسار الشعار، و*أشكال* حقول بيانات الاعتماد. لا تُخزَّن أي قيمة سرّية هنا،
 * ولا يقرر هذا الملف شيئاً عن الاتصال الفعلي — الخادم وحده يملك المحوّلات
 * (adapters) ويختارها من خريطة مغلقة عبر المعرّف النصّي فقط.
 *
 * انظر functions/src/gatewayTypes.ts للنصف الخاص بالخادم.
 */

import {
  CalendarClock,
  Clock,
  CreditCard,
  Truck,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** البوابات المدعومة. المعرّف هو اسم مستند الإعدادات الخاص بها أيضاً. */
export type GatewayId =
  | "mispay"
  | "madfu"
  | "neoleap"
  | "tamara"
  | "tabby";

export type GatewayEnvironment = "sandbox" | "production";

/**
 * حقل إدخال واحد في بطاقة إعدادات البوابة بلوحة التحكم.
 * `key` يطابق اسم الحقل في مستند الإعدادات الخاص (stores/{id}/settings/{gateway}).
 */
export interface GatewayCredentialField {
  key: string;
  /** التسمية المعروضة (عربية) */
  label: string;
  placeholder?: string;
  kind: "text" | "password" | "select";
  /** خيارات القائمة المنسدلة عندما kind === "select" */
  options?: { value: string; label: string }[];
  required: boolean;
  /** true ⇒ الخادم لا يُرجعه إلا مُقنّعاً (••••1234)، ولا يُرجعه صريحاً أبداً */
  secret: boolean;
  /** تلميح عربي تحت الحقل */
  help?: string;
}

export interface GatewayDescriptor {
  id: GatewayId;
  /** الاسم العربي في الـ checkout ولوحة التحكم */
  name: string;
  /** سطر وصف قصير تحت الاسم في صف طريقة الدفع */
  description: string;
  /** ملف داخل public/payments/ */
  logo: string;
  logoAlt: string;
  /** أيقونة بديلة تُرسم حتى يوصل ملف الشعار الرسمي */
  fallbackIcon: LucideIcon;
  credentialFields: readonly GatewayCredentialField[];
  /** الحد الأدنى لمبلغ الطلب بالريال. تحت هذا الحد تُخفى البوابة من الـ checkout. */
  minAmountSAR?: number;
  maxAmountSAR?: number;
  /** redirect = يخرج العميل من الموقع ويعود إلى /payment/return/:gateway */
  flow: "redirect";
  /** يُسجّل في دليل الإعداد: هل تطلب البوابة تثبيت IP الخادم؟ */
  requiresStaticEgressIp?: boolean;
}

/** خيارات البيئة، مشتركة بين البوابات الثلاث. */
const ENVIRONMENT_FIELD: GatewayCredentialField = {
  key: "environment",
  label: "البيئة",
  kind: "select",
  options: [
    { value: "sandbox", label: "تجربة (Sandbox)" },
    { value: "production", label: "إنتاج (Production)" },
  ],
  required: true,
  secret: false,
  help: "ابدأ بالتجربة، ولا تنتقل إلى الإنتاج إلا بعد نجاح طلب حقيقي.",
};

/**
 * البوابات المسجّلة.
 *
 * ترتيب العرض في لوحة التحكم هو ترتيب هذه القائمة، وهو ترتيب التنفيذ
 * المتفق عليه: MIS Pay ثم Madfu ثم neoleap.
 */
export const PAYMENT_GATEWAYS: readonly GatewayDescriptor[] = [
  {
    id: "mispay",
    name: "MIS Pay",
    description: "قسّم فاتورتك على أقساط دون فوائد",
    logo: "/payments/mispay.svg",
    logoAlt: "MIS Pay",
    fallbackIcon: CalendarClock,
    // الحد الأدنى من المزوّد نفسه: أقل منه يُرفض برمز ME13.
    minAmountSAR: 145,
    flow: "redirect",
    requiresStaticEgressIp: true,
    credentialFields: [
      {
        key: "appId",
        label: "معرّف التطبيق (App ID)",
        placeholder: "x-app-id",
        kind: "text",
        required: true,
        secret: false,
        help: "يصدر من فريق MIS Pay عند تسجيل المتجر.",
      },
      {
        key: "appSecret",
        label: "سرّ التطبيق (App Secret)",
        placeholder: "x-app-secret",
        kind: "password",
        required: true,
        secret: true,
        help: "يُستخدم أيضاً لفكّ تشفير الرمز وحمولة العودة. لا تشاركه.",
      },
      ENVIRONMENT_FIELD,
    ],
  },
  {
    id: "madfu",
    name: "مدفوع (Madfu)",
    description: "اشترِ الآن وادفع لاحقاً على أقساط",
    logo: "/payments/madfu.svg",
    logoAlt: "Madfu مدفوع",
    fallbackIcon: Wallet,
    flow: "redirect",
    credentialFields: [
      {
        key: "apiKey",
        label: "مفتاح الـ API (apikey)",
        kind: "password",
        required: true,
        secret: true,
      },
      {
        key: "appCode",
        label: "رمز التطبيق (appcode)",
        kind: "text",
        required: true,
        secret: false,
      },
      {
        key: "basicToken",
        label: "رمز Basic للمصادقة",
        placeholder: "القيمة التي تلي كلمة Basic",
        kind: "password",
        required: true,
        secret: true,
        help: "أدخل القيمة فقط، بدون كلمة Basic في أولها.",
      },
      {
        key: "userName",
        label: "بريد التاجر",
        kind: "text",
        required: true,
        secret: false,
        help: "نفس بريد الدخول إلى لوحة تاجر مدفوع.",
      },
      {
        key: "password",
        label: "كلمة مرور التاجر",
        kind: "password",
        required: true,
        secret: true,
      },
      {
        key: "platformTypeId",
        label: "نوع المنصّة (platformTypeId)",
        placeholder: "5",
        kind: "text",
        required: false,
        secret: false,
        help: "اتركه فارغاً ليُستخدم ٥ وهو المعتاد للويب.",
      },
      ENVIRONMENT_FIELD,
    ],
  },
  {
    id: "neoleap",
    name: "neoleap",
    description: "ادفع ببطاقة مدى أو فيزا أو ماستركارد",
    logo: "/payments/neoleap.svg",
    logoAlt: "neoleap",
    fallbackIcon: CreditCard,
    flow: "redirect",
    credentialFields: [
      {
        key: "tranportalId",
        label: "معرّف Tranportal",
        kind: "text",
        required: true,
        secret: false,
        help: "من حزمة التاجر التي يسلّمها البنك.",
      },
      {
        key: "tranportalPassword",
        label: "كلمة مرور Tranportal",
        kind: "password",
        required: true,
        secret: true,
      },
      {
        key: "resourceKey",
        label: "مفتاح التشفير (Resource Key)",
        kind: "password",
        required: true,
        secret: true,
        help: "٣٢ حرفاً بالضبط — هذا طول مفتاح AES-256.",
      },
      {
        key: "iv",
        label: "قيمة IV (اختياري)",
        kind: "password",
        required: false,
        secret: true,
        help: "١٦ حرفاً. اتركه فارغاً إن لم يسلّمك البنك قيمة خاصة.",
      },
      {
        key: "gatewayHost",
        label: "مضيف البوابة (اختياري)",
        placeholder: "https://digitalpayments.neoleap.com.sa",
        kind: "text",
        required: false,
        secret: false,
        help: "املأه فقط إذا خصّص لك البنك مضيفاً مختلفاً.",
      },
      ENVIRONMENT_FIELD,
    ],
  },
  {
    id: "tamara",
    name: "تمارا",
    description: "قسّمها على ٣ دفعات بدون فوائد",
    logo: "/payments/tamara.svg",
    logoAlt: "تمارا Tamara",
    fallbackIcon: CalendarClock,
    flow: "redirect",
    credentialFields: [
      {
        key: "apiToken",
        label: "مفتاح API",
        kind: "password",
        required: true,
        secret: true,
        help: "من لوحة تاجر تمارا. المفتاح نفسه يحدّد البيئة (تجربة أو إنتاج).",
      },
      ENVIRONMENT_FIELD,
    ],
  },
  {
    id: "tabby",
    name: "تابي",
    description: "قسّمها على ٤ دفعات بدون فوائد",
    logo: "/payments/tabby.svg",
    logoAlt: "تابي Tabby",
    fallbackIcon: CalendarClock,
    flow: "redirect",
    credentialFields: [
      {
        key: "publicKey",
        label: "المفتاح العام (Public Key)",
        kind: "password",
        required: true,
        secret: false,
        help: "يُستخدم لإنشاء جلسة الدفع.",
      },
      {
        key: "secretKey",
        label: "المفتاح السرّي (Secret Key)",
        kind: "password",
        required: true,
        secret: true,
        help: "يُستخدم للاستعلام والتحصيل. لا تشاركه.",
      },
      {
        key: "merchantCode",
        label: "رمز التاجر (اختياري)",
        kind: "text",
        required: false,
        secret: false,
        help: "املأه فقط إذا أعطاك تابي رمزاً خاصاً بالمتجر.",
      },
      ENVIRONMENT_FIELD,
    ],
  },
];

export const GATEWAY_BY_ID: Readonly<Partial<Record<string, GatewayDescriptor>>> =
  Object.freeze(
    Object.fromEntries(PAYMENT_GATEWAYS.map((g) => [g.id, g])),
  );

/** هل هذا المعرّف بوابة مسجّلة (وليس طريقة يدوية)؟ */
export const isGatewayId = (id: string | undefined): id is GatewayId =>
  !!id && id in GATEWAY_BY_ID;

/**
 * الطرق اليدوية التي ينفّذها المتجر بنفسه. سلوكها لا يتغيّر.
 * cash = الدفع عند الاستلام، bank = تحويل بنكي، emkan = إمكان (بدون API).
 */
export const MANUAL_METHOD_IDS = ["cash", "bank", "emkan"] as const;

/**
 * طرق مُخفاة عن واجهة العميل بقرار صريح. لا تحذف هذه القائمة:
 * بدونها يُقرأ الفلتر في الـ checkout كأنه سهو.
 *
 * بقي فيها "card" (PayPal) وحده: لا محوّل له في السجل، ومفتاحه في لوحة
 * التحكم كان معطّلاً أصلاً. تمارا وتابي خرجتا منها وأصبحتا بوابتين كاملتين
 * في السجل، فتظهران للعميل بعد نجاح اختبار الاتصال مثل البقية.
 */
export const HIDDEN_METHOD_IDS = ["card"] as const;

/** أوصاف الطرق اليدوية في صف طريقة الدفع (كانت ثلاثية شرطية داخل Checkout). */
const MANUAL_METHOD_DESCRIPTIONS: Record<string, string> = {
  cash: "ادفع نقداً عند وصول الطلب",
  bank: "حوّل المبلغ إلى حساب المتجر ثم أرسل الإيصال",
  emkan: "تقسيط عبر إمكان — يتواصل معك فريق المتجر لإكمال الإجراء",
};

/** أيقونات الطرق اليدوية (نفس ما يُرسم اليوم في الـ checkout). */
const MANUAL_METHOD_ICONS: Record<string, LucideIcon> = {
  cash: Truck,
  bank: CreditCard,
  emkan: Clock,
};

/** أسماء الطرق اليدوية. */
const MANUAL_METHOD_LABELS: Record<string, string> = {
  cash: "الدفع عند الاستلام",
  bank: "تحويل بنكي",
  emkan: "إمكان - تقسيط",
  // طريقة مُخفاة، تظهر فقط في لوحة التحكم على طلبات قديمة
  card: "بطاقة ائتمان",
};

/**
 * المصدر الوحيد لاسم طريقة الدفع.
 * يُستخدم في لوحة التحكم (الجدول، النافذة، تصدير CSV) بدل الثلاثيات الشرطية
 * التي كانت تُسمّي أي معرّف غير معروف "بطاقة ائتمان".
 */
export function paymentMethodLabel(id: string | undefined): string {
  if (!id) return "غير محدد";
  return GATEWAY_BY_ID[id]?.name ?? MANUAL_METHOD_LABELS[id] ?? id;
}

/** وصف طريقة الدفع في صف الـ checkout. */
export function paymentMethodDescription(id: string): string {
  return GATEWAY_BY_ID[id]?.description ?? MANUAL_METHOD_DESCRIPTIONS[id] ?? "";
}

/** أيقونة احتياطية لأي طريقة دفع. */
export function paymentMethodIcon(id: string): LucideIcon {
  return GATEWAY_BY_ID[id]?.fallbackIcon ?? MANUAL_METHOD_ICONS[id] ?? Wallet;
}

/**
 * الحالة العامة الخالية من الأسرار، تُنسخ إلى settings/store ليقرأها المتجر.
 * يكتبها Admin SDK وحده (انظر قاعدة settings/store في firestore.rules).
 */
export interface PublicGatewayStatus {
  enabled: boolean;
  /** true فقط بعد نجاح اختبار اتصال حقيقي على الخادم */
  connected: boolean;
  environment: GatewayEnvironment;
  minAmountSAR?: number;
  /** Firestore Timestamp عند القراءة الخام، Date بعد التحويل */
  lastVerifiedAt?: unknown;
}

export type PublicGatewayStatusMap = Partial<
  Record<GatewayId, PublicGatewayStatus>
>;
