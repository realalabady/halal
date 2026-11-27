/**
 * منطق الفاتورة — خالص، بلا React وبلا Firestore.
 *
 * الفاتورة سجلّ تاريخي: أرقامها وهويتها النظامية تُلتقط لحظةَ إنشاء الطلب
 * وتُخزَّن على مستند الطلب (invoiceNumber, invoiceVatRate, ...). هذا الملف
 * يقرأ تلك اللقطة ولا يعيد حسابها من الإعدادات الحالية، حتى لا تتغيّر فاتورة
 * قديمة لأن التاجر عدّل رقمه الضريبي أو نسبة الضريبة بعد البيع.
 */

import type { BusinessInfo } from "../store/useStore";
import type { FirestoreOrder } from "../services/firestore";
import { GATEWAY_BY_ID, paymentMethodLabel } from "../constants/paymentGateways";

/** أي شكل للتاريخ قد يصل من Firestore: Date أو Timestamp أو نص. */
export type DateLike =
  | Date
  | string
  | number
  | { toDate: () => Date }
  | { seconds: number }
  | null
  | undefined;

/**
 * يُطبّع أي شكل تاريخ إلى Date.
 * الصفحات هنا تقرأ الطلب بـ getDoc الخام (مثل OrderConfirmation)، فتصل
 * التواريخ Timestamp لا Date. بدون هذا التطبيع تُطبع الفاتورة "Invalid Date".
 */
export function toDate(value: DateLike): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const d = value.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object" && "seconds" in value && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000);
  }
  const parsed = new Date(value as string | number);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * رقم تسلسلي مشتق من الوقت: HLY-20261127-51932
 * (البادئة + التاريخ + عدد الثواني المنقضية من اليوم، بخمس خانات).
 *
 * مشتق لا معدود: لا عدّاد في Firestore، ولا قاعدة أمان جديدة، ولا نقطة تسابق
 * بين طلبين متزامنين. فريد وتصاعدي ويُرتَّب نصّياً ترتيباً صحيحاً.
 */
export function buildInvoiceSerial(date: Date, prefix = "HLY"): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1, 2);
  const d = pad(date.getDate(), 2);
  const secondsIntoDay =
    date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  const safePrefix = (prefix || "HLY").trim().toUpperCase() || "HLY";
  return `${safePrefix}-${y}${m}${d}-${pad(secondsIntoDay, 5)}`;
}

/**
 * رقم الفاتورة المعروض.
 * الطلبات التي أُنشئت قبل هذه الميزة لا تحمل invoiceNumber، فيُشتق لها رقم
 * ثابت من createdAt — نفس الطلب يُعطي نفس الرقم في كل مرة.
 */
export function resolveInvoiceNumber(
  order: Pick<FirestoreOrder, "invoiceNumber" | "createdAt">,
  prefix = "HLY",
): string {
  if (order.invoiceNumber) return order.invoiceNumber;
  const created = toDate(order.createdAt as DateLike) ?? new Date(0);
  return buildInvoiceSerial(created, prefix);
}

/** تاريخ إصدار الفاتورة: لقطة الطلب إن وُجدت، وإلا تاريخ إنشائه. */
export function resolveInvoiceDate(
  order: Pick<FirestoreOrder, "invoiceIssuedAt" | "createdAt">,
): Date {
  return (
    toDate(order.invoiceIssuedAt as DateLike) ??
    toDate(order.createdAt as DateLike) ??
    new Date()
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface InvoiceTotals {
  /** إجمالي الأصناف كما يُعرض في المتجر */
  subtotal: number;
  shipping: number;
  /** الوعاء الخاضع للضريبة = الإجمالي − الضريبة */
  taxableTotal: number;
  vatAmount: number;
  vatRate: number;
  total: number;
  /**
   * true فقط إذا حملت لقطة الطلب رقماً ضريبياً ونسبةً فعلية.
   * عرض سطر ضريبة أو رقم ضريبي بلا تسجيل مخالفة، فهذا الشرط قانوني
   * لا تنسيقي: ما لم يُحفظ رقم ضريبي، تُطبع الوثيقة فاتورةً عادية.
   */
  isTaxInvoice: boolean;
}

/**
 * يقرأ أرقام الفاتورة من لقطة الطلب، مع احتياطات آمنة للطلبات القديمة.
 * الأسعار في المتجر شاملة الضريبة (ممارسة السعودية المعتادة)، فالضريبة
 * تُستخرج من الإجمالي ولا تُضاف إليه — الإجمالي لا يتحرك أبداً.
 */
export function computeInvoiceTotals(order: FirestoreOrder): InvoiceTotals {
  const total = round2(Number(order.total) || 0);
  const shipping = round2(Number(order.shippingCost) || 0);
  const subtotal = round2(
    order.subtotal != null ? Number(order.subtotal) : total - shipping,
  );

  const vatRate = Number(order.invoiceVatRate) || 0;
  const hasVatNumber = !!order.invoiceVatNumber;
  const pricesIncludeVat = order.invoicePricesIncludeVat !== false;

  let vatAmount = 0;
  if (vatRate > 0) {
    vatAmount =
      order.invoiceVatAmount != null
        ? round2(Number(order.invoiceVatAmount))
        : pricesIncludeVat
          ? round2(total - total / (1 + vatRate / 100))
          : round2(total * (vatRate / 100));
  }

  const isTaxInvoice = hasVatNumber && vatRate > 0 && vatAmount > 0;

  return {
    subtotal,
    shipping,
    taxableTotal: round2(total - (isTaxInvoice ? vatAmount : 0)),
    vatAmount: isTaxInvoice ? vatAmount : 0,
    vatRate,
    total,
    isTaxInvoice,
  };
}

/** مبلغ بالريال، بأرقام لاتينية مُحاذاة (الفاتورة وثيقة، لا واجهة). */
export function formatSAR(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export interface InvoiceDateTime {
  ar: string;
  en: string;
}

/**
 * التاريخ والوقت بالتقويم الميلادي، صراحةً.
 *
 * `toLocaleDateString("ar-SA")` وحده يُخرج تاريخاً هجرياً على بعض بيئات
 * التشغيل — غير مقبول على فاتورة تُقدَّم لجهة حكومية أو محاسب. اللاحقة
 * `-u-ca-gregory` تُثبّت التقويم، ويُطبَع سطر إنجليزي معه للتحقّق البصري.
 */
export function formatInvoiceDateTime(date: Date): InvoiceDateTime {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  return {
    ar: new Intl.DateTimeFormat("ar-SA-u-ca-gregory", options).format(date),
    en: new Intl.DateTimeFormat("en-GB", options).format(date),
  };
}

// ==================== تفاصيل الدفع والبوابات ====================

/**
 * عدد الدفعات المعلن لكل بوابة تقسيط.
 *
 * القيم مأخوذة حرفياً من نصوص البوابات في constants/paymentGateways.ts
 * (تابي «٤ دفعات»، تمارا «٣ دفعات»)، وهي النصوص المعروضة للعميل في الـ
 * checkout أصلاً. البوابات التي لا تُعلن عدداً (MIS Pay، مدفوع) تبقى بلا
 * عدد — لا نخترع جدول أقساط على وثيقة نظامية.
 */
const DECLARED_INSTALLMENTS: Partial<Record<string, number>> = {
  tabby: 4,
  tamara: 3,
};

export interface InvoicePaymentDetails {
  /** اسم طريقة الدفع العربي */
  methodLabel: string;
  /** معرّف البوابة إن كانت بوابة مسجّلة (لجلب الشعار) */
  gatewayId?: string;
  logo?: string;
  /** سطر الوصف المعلن للبوابة، مثل «قسّمها على ٤ دفعات بدون فوائد» */
  planNote?: string;
  /** عدد الدفعات وقيمة الدفعة، فقط للبوابات التي تُعلن العدد */
  installments?: { count: number; amount: number };
  /** مرجع المزوّد: payment id عند تابي، order id عند تمارا، trackId ... */
  providerRef?: string;
  providerRefLabel?: string;
  /** مرجع المتجر للعملية (هو نفسه معرّف المستند في طلبات البوابات) */
  storeRef?: string;
  statusCode?: string;
  paidAt: Date | null;
  isPaid: boolean;
  /** نص حالة الدفع المعروض */
  statusLabel: string;
}

/**
 * يجمع تفاصيل الدفع من كل المسارات في شكل واحد.
 *
 * المتجر يدفع عبر ستة مسارات كتبت حقولها في أزمنة مختلفة: البوابات الحديثة
 * (gateway/gatewayProviderRef)، ومسارات تابي وتمارا القديمة
 * (tabbyPaymentId/tamaraOrderId)، وPayPal (paypalCaptureId). الفاتورة يجب أن
 * تُظهر مرجع المزوّد أيّاً كان المسار، وإلا بقي العميل محتاجاً إلى إيصال
 * تابي المنفصل ليُثبت دفعه.
 */
export function resolvePaymentDetails(
  order: FirestoreOrder,
): InvoicePaymentDetails {
  const methodId = order.gateway || order.paymentMethod || "";
  const descriptor = GATEWAY_BY_ID[methodId];

  // أول مرجع مزوّد متوفّر، بترتيب الأحدث مسارياً.
  const providerRefCandidates: { ref?: string; label: string }[] = [
    { ref: order.gatewayProviderRef, label: "مرجع المزوّد" },
    { ref: order.tabbyPaymentId, label: "رقم عملية تابي" },
    { ref: order.tamaraOrderId, label: "رقم طلب تمارا" },
    { ref: order.paypalCaptureId, label: "رقم تحصيل PayPal" },
    { ref: order.paypalOrderId, label: "رقم طلب PayPal" },
  ];
  const providerMatch = providerRefCandidates.find((c) => !!c.ref);

  const isPaid = order.paymentStatus === "paid";
  const count = DECLARED_INSTALLMENTS[methodId];
  const total = Number(order.total) || 0;

  return {
    methodLabel: paymentMethodLabel(methodId),
    gatewayId: descriptor?.id,
    logo: descriptor?.logo,
    planNote: descriptor?.description,
    installments:
      count && total > 0
        ? { count, amount: round2(total / count) }
        : undefined,
    providerRef: providerMatch?.ref,
    providerRefLabel: providerMatch?.label,
    storeRef: order.gatewayRef,
    statusCode: order.gatewayStatusCode,
    paidAt: toDate(order.paidAt as DateLike),
    isPaid,
    statusLabel: isPaid
      ? "مدفوعة بالكامل"
      : order.paymentMethod === "cash"
        ? "تُحصَّل عند الاستلام"
        : "غير مدفوعة",
  };
}

// ==================== لقطة الهوية النظامية ====================

/** الحقول التي تُثبَّت على مستند الطلب لحظة إنشائه. */
export interface InvoiceSnapshot {
  invoiceNumber: string;
  invoiceIssuedAt: Date;
  invoiceVatRate: number;
  invoiceVatAmount: number;
  invoicePricesIncludeVat: boolean;
  invoiceVatNumber: string;
  invoiceCrNumber: string;
}

/**
 * يبني اللقطة من الهوية النظامية الحالية وإجمالي الطلب.
 *
 * الرقم الضريبي لا يُثبَّت إلا إذا كانت الضريبة مُفعّلة والرقم محفوظاً:
 * غيابه هو ما يجعل الفاتورة تُطبع «فاتورة» لا «فاتورة ضريبية».
 */
export function buildInvoiceSnapshot(
  business: BusinessInfo,
  total: number,
  issuedAt: Date = new Date(),
): InvoiceSnapshot {
  const vatActive = !!business.vatEnabled && !!business.vatNumber;
  const rate = vatActive ? Number(business.vatRate) || 0 : 0;
  const includesVat = business.pricesIncludeVat !== false;
  const amount =
    rate > 0
      ? includesVat
        ? round2(total - total / (1 + rate / 100))
        : round2(total * (rate / 100))
      : 0;

  return {
    invoiceNumber: buildInvoiceSerial(issuedAt, business.invoicePrefix),
    invoiceIssuedAt: issuedAt,
    invoiceVatRate: rate,
    invoiceVatAmount: amount,
    invoicePricesIncludeVat: includesVat,
    invoiceVatNumber: vatActive ? business.vatNumber : "",
    invoiceCrNumber: business.crNumber || "",
  };
}

/** رقم ضريبي سعودي: ١٥ رقماً يبدأ بـ ٣ وينتهي بـ ٣. */
export function isValidSaudiVatNumber(value: string): boolean {
  return /^3\d{13}3$/.test(value.trim());
}
