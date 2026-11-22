/**
 * بوابة وهمية — للمحاكي فقط، لا تُسجَّل في الإنتاج أبداً.
 *
 * تسمح بتشغيل التدفّق كاملاً محلياً: إعداد ← اختبار اتصال ← ظهور في
 * الـ checkout ← تحويل ← عودة ← إنشاء الطلب، دون حساب تاجر حقيقي.
 *
 * الحارس الوحيد الذي يهمّ: التسجيل يحدث فقط عند وجود FUNCTIONS_EMULATOR،
 * وهو متغيّر يضبطه مشغّل المحاكي ولا يوجد في Cloud Functions المنشورة.
 */

import * as admin from "firebase-admin";

import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  GatewayAdapter,
  GatewayStatusResult,
  TestConnectionResult,
} from "./gatewayTypes";

/**
 * حالة الدفع الوهمي في Firestore لا في الذاكرة: محاكي الدوال يشغّل كل دالة
 * في عملية مستقلّة، فصفحة الدفع و getStatus لا تتشاركان ذاكرة.
 */
const mockRef = (providerRef: string) =>
  admin.firestore().doc(`mock_payments/${providerRef}`);

/** يُستدعى من صفحة الدفع الوهمية لتعليم العملية مدفوعة. */
export async function markMockPaid(providerRef: string): Promise<void> {
  await mockRef(providerRef).set({ paid: true, at: Date.now() });
}

export const mockAdapter: GatewayAdapter = {
  id: "mockpay",
  requiredCredentials: ["apiKey"] as const,
  minAmountSAR: 50,

  isAuthError(): boolean {
    return false;
  },

  async testConnection(creds): Promise<TestConnectionResult> {
    // مفتاح يبدأ بـ bad_ يُمثّل مفتاحاً خاطئاً، لاختبار مسار الفشل أيضاً.
    if ((creds.apiKey || "").startsWith("bad_")) {
      return { success: false, message: "مفتاح وهمي غير صالح." };
    }
    return { success: true, message: "تم الاتصال بالبوابة الوهمية بنجاح." };
  },

  async createCheckout(
    input: CreateCheckoutInput,
    _creds,
    ctx,
  ): Promise<CreateCheckoutResult> {
    const providerRef = `mock_${input.orderRef}`;
    // صفحة دفع وهمية تستضيفها دالة في المحاكي
    const url =
      `${ctx.functionsBaseUrl}/mockPayPage` +
      `?ref=${encodeURIComponent(providerRef)}` +
      `&store=${encodeURIComponent(ctx.storeId)}` +
      `&amount=${encodeURIComponent(String(input.amount))}` +
      `&ret=${encodeURIComponent(input.returnUrl)}`;
    return { redirectUrl: url, providerRef };
  },

  async getStatus(providerRef): Promise<GatewayStatusResult> {
    const snap = await mockRef(providerRef).get();
    return snap.data()?.paid === true
      ? { state: "paid", providerCode: "MOCK_PAID" }
      : { state: "pending", providerCode: "MOCK_PENDING" };
  },
};

export const isEmulator = (): boolean => !!process.env.FUNCTIONS_EMULATOR;
