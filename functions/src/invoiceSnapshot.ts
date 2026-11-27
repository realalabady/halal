/**
 * لقطة الفاتورة على الخادم.
 *
 * نسخة مطابقة لـ src/utils/invoice.ts على العميل. التكرار مقصود وليس سهواً:
 * المجلدان مشروعا TypeScript منفصلان بحزمتين منفصلتين (functions/ له
 * package.json وtsconfig خاصّان)، فلا يستورد أحدهما من الآخر. أي تعديل على
 * صيغة الرقم التسلسلي أو حساب الضريبة يجب أن يُطبَّق في الملفّين.
 *
 * ولماذا على الخادم أصلاً: طلبات بوابات الدفع لا يكتبها العميل. الخادم
 * ينشئها في paymentReconcile.ts من المسوّدة المحفوظة، فلو خُتمت اللقطة على
 * العميل وحده لخرج كل طلب تابي أو تمارا أو مدفوع بلا رقم فاتورة.
 */

import { Timestamp } from "firebase-admin/firestore";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const pad = (n: number, width: number): string =>
  String(n).padStart(width, "0");

/** رقم تسلسلي مشتق من الوقت: HLY-20261127-51932 */
export function buildInvoiceSerial(date: Date, prefix = "HLY"): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1, 2);
  const d = pad(date.getDate(), 2);
  const secondsIntoDay =
    date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  const safePrefix = (prefix || "HLY").trim().toUpperCase() || "HLY";
  return `${safePrefix}-${y}${m}${d}-${pad(secondsIntoDay, 5)}`;
}

/** رقم ضريبي سعودي: ١٥ رقماً يبدأ بـ ٣ وينتهي بـ ٣. */
export function isValidSaudiVatNumber(value: string): boolean {
  return /^3\d{13}3$/.test((value || "").trim());
}

export interface InvoiceSnapshotFields {
  invoiceNumber: string;
  invoiceIssuedAt: Timestamp;
  invoiceVatRate: number;
  invoiceVatAmount: number;
  invoicePricesIncludeVat: boolean;
  invoiceVatNumber: string;
  invoiceCrNumber: string;
}

/**
 * يبني لقطة الفاتورة من كتلة `business` في settings/store.
 *
 * `vatAmount` يُؤخَذ من التسعير الذي حسبه الخادم (orderPricing) لا يُعاد
 * حسابه، فلا يختلف رقمٌ على الفاتورة عن رقمٍ أُرسل إلى البوابة.
 *
 * التاريخ `Timestamp.now()` لا `FieldValue.serverTimestamp()`: اللقطة تُكتب
 * في مستند الدفع المعلّق ثم تُقرأ وتُنسخ إلى مستند الطلب عند المصالحة،
 * والرمز البديل للوقت لا يصلح للقراءة ثم الكتابة مرة أخرى.
 */
export function buildInvoiceSnapshot(
  business: Record<string, unknown> | undefined,
  total: number,
  vatAmountFromPricing: number,
  issuedAt: Date = new Date(),
): InvoiceSnapshotFields {
  const b = business || {};
  const vatNumber = String(b.vatNumber ?? "");
  const vatActive = b.vatEnabled === true && isValidSaudiVatNumber(vatNumber);
  const rate = vatActive ? Number(b.vatRate) || 0 : 0;
  const includesVat = b.pricesIncludeVat !== false;

  let amount = 0;
  if (rate > 0) {
    amount =
      vatAmountFromPricing > 0
        ? round2(vatAmountFromPricing)
        : includesVat
          ? round2(total - total / (1 + rate / 100))
          : round2(total * (rate / 100));
  }

  return {
    invoiceNumber: buildInvoiceSerial(
      issuedAt,
      String(b.invoicePrefix ?? "HLY"),
    ),
    invoiceIssuedAt: Timestamp.fromDate(issuedAt),
    invoiceVatRate: rate,
    invoiceVatAmount: amount,
    invoicePricesIncludeVat: includesVat,
    invoiceVatNumber: vatActive ? vatNumber.trim() : "",
    invoiceCrNumber: String(b.crNumber ?? ""),
  };
}
