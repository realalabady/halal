/**
 * مصالحة الدفع — المكان الوحيد الذي يصبح فيه طلب بوابة "مدفوعاً".
 *
 * قرار التصميم: مستند الطلب لا يُنشأ إلا *بعد* تأكيد الدفع، بمعرّف مستند
 * يساوي orderRef.
 *
 * لماذا لا نُنشئه قبل التحويل: onOrderCreated يخصم المخزون ذرّياً *و* يُرسل
 * للعميل "تم استلام طلبك". طلب يُنشأ قبل الدفع يعني رسالة تأكيد لسلّة قد لا
 * تُدفع أبداً، ومخزوناً يُستهلك مع كل تحويل مهجور. تأخير الإنشاء يُبقي
 * المبدأ القائم كما هو: "وجود الطلب يعني أنه حقيقي".
 *
 * ولأن معرّف المستند حتميّ، فالإنشاء المزدوج مستحيل بنيوياً: create داخل
 * معاملة يرفع ALREADY_EXISTS، وكل المداخل الثلاثة (الـ webhook، صفحة العودة،
 * المسح الدوري) تنادي هذه الدالة نفسها.
 */

import * as admin from "firebase-admin";

import { pendingPaymentRef, storeDoc } from "./storePaths";
import { requireAdapter } from "./gatewayRegistry";
import {
  buildGatewayContext,
  loadGatewayCredentials,
  markGatewayUnhealthy,
} from "./gatewayStore";
import { describeGatewayError } from "./gatewayHttp";
import type { GatewayPaymentState } from "./gatewayTypes";

export type PendingStatus =
  | "CREATED"
  | "RECONCILED"
  | "CANCELLED"
  | "FAILED"
  | "EXPIRED";

export interface PendingPaymentDraft {
  userId?: string;
  customer: string;
  email: string;
  phone: string;
  items: {
    productId: string;
    name: string;
    quantity: number;
    price: number;
    image?: string;
  }[];
  total: number;
  subtotal: number;
  shippingCost: number;
  vat?: number;
  paymentMethod: string;
  fulfillment?: "delivery" | "pickup";
  shippingAddress: string;
  address?: Record<string, string>;
  notes?: string;
}

export interface ReconcileResult {
  state: GatewayPaymentState | "expired";
  orderId?: string;
  providerCode?: string;
  /** رسالة عربية صالحة للعرض للعميل */
  message: string;
}

const MESSAGES: Record<string, string> = {
  paid: "تم تأكيد الدفع.",
  pending: "لم يكتمل الدفع بعد.",
  cancelled: "أُلغيت عملية الدفع.",
  failed: "فشلت عملية الدفع.",
  refunded: "تم استرداد المبلغ.",
  expired: "انتهت مدة صلاحية عملية الدفع.",
};

/**
 * يصالح دفعة معلّقة مع المزوّد وينشئ الطلب إن كانت مدفوعة.
 *
 * آمنة للتكرار وللنداء المتزامن: مستند الطلب حتميّ، والتحقق يقع داخل معاملة.
 */
export async function reconcileGatewayPayment(
  storeId: string,
  orderRef: string,
): Promise<ReconcileResult> {
  const pendingRef = pendingPaymentRef(orderRef);
  const pendingSnap = await pendingRef.get();

  if (!pendingSnap.exists) {
    return { state: "failed", message: "سجل الدفع غير موجود." };
  }

  const pending = pendingSnap.data() as Record<string, unknown>;

  if (pending.storeId !== storeId) {
    // مرجع دفع لا يخصّ هذا المتجر: لا نُفصح عن وجوده.
    return { state: "failed", message: "سجل الدفع غير موجود." };
  }

  // مسار سريع آمن للتكرار: مصالحة سابقة أنجزت العمل.
  if (pending.status === "RECONCILED") {
    return {
      state: "paid",
      orderId: (pending.orderId as string) || orderRef,
      message: MESSAGES.paid,
    };
  }

  if (pending.status === "CANCELLED" || pending.status === "FAILED") {
    const state = pending.status === "CANCELLED" ? "cancelled" : "failed";
    return { state, message: MESSAGES[state] };
  }

  const gatewayId = String(pending.gateway || "");
  const adapter = requireAdapter(gatewayId);

  // ===== الحالة المعتمدة تأتي من المزوّد، خادماً إلى خادم =====
  // لا من حمولة العودة (قناة يتحكّم بها متصفّح العميل) ولا من الـ webhook
  // (غير موقّع في MIS Pay و Madfu معاً).
  let status;
  try {
    const { creds, environment } = await loadGatewayCredentials(storeId, adapter);
    const ctx = await buildGatewayContext(storeId, environment);
    status = await adapter.getStatus(
      String(pending.providerRef || orderRef),
      creds,
      ctx,
    );
  } catch (error) {
    const reason = describeGatewayError(error);
    if (adapter.isAuthError(error)) {
      await markGatewayUnhealthy(storeId, gatewayId, reason);
    }
    console.error(`[reconcile] ${gatewayId}/${orderRef} فشل الاستعلام:`, reason);
    // لا نُغيّر شيئاً: المسح الدوري سيعيد المحاولة.
    return { state: "pending", message: MESSAGES.pending };
  }

  if (status.state !== "paid") {
    const terminal =
      status.state === "cancelled"
        ? "CANCELLED"
        : status.state === "failed"
          ? "FAILED"
          : null;

    if (terminal) {
      await pendingRef.set(
        {
          status: terminal as PendingStatus,
          providerCode: status.providerCode || null,
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    return {
      state: status.state,
      providerCode: status.providerCode,
      message: MESSAGES[status.state] || MESSAGES.pending,
    };
  }

  // ===== مدفوع: تحقّق من المبلغ ثم أنشئ الطلب =====
  const expected = Number(pending.amount ?? 0);
  if (
    typeof status.amount === "number" &&
    Number.isFinite(status.amount) &&
    Math.abs(status.amount - expected) > 0.01
  ) {
    // لا نُنشئ طلباً بمبلغ لا يطابق ما حسبه الخادم.
    await pendingRef.set(
      {
        status: "FAILED" as PendingStatus,
        amountMismatch: { expected, received: status.amount },
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    console.error(
      `[reconcile] ${gatewayId}/${orderRef} عدم تطابق المبلغ: متوقّع ${expected} ووارد ${status.amount}`,
    );
    return {
      state: "failed",
      message: "المبلغ المدفوع لا يطابق إجمالي الطلب. تواصل مع المتجر.",
    };
  }

  const draft = (pending.draft || {}) as PendingPaymentDraft;
  const orderDocRef = storeDoc(storeId, "orders", orderRef);

  try {
    await admin.firestore().runTransaction(async (tx) => {
      const existing = await tx.get(orderDocRef);
      if (existing.exists) {
        // سبقتنا مصالحة أخرى؛ نكمل لتثبيت حالة pending فقط.
        tx.set(
          pendingRef,
          {
            status: "RECONCILED" as PendingStatus,
            orderId: orderRef,
            reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return;
      }

      // إعادة فحص المخزون: قد يكون نفد أثناء وجود العميل على صفحة البوابة.
      // الطلب المدفوع لا يُسقَط أبداً — نُعلّمه ونُنبّه صاحب المتجر.
      let stockShortfall = false;
      for (const item of draft.items || []) {
        const productSnap = await tx.get(
          storeDoc(storeId, "products", item.productId),
        );
        const stock = Number(productSnap.data()?.stock ?? 0);
        if (!productSnap.exists || stock < item.quantity) {
          stockShortfall = true;
          break;
        }
      }

      tx.create(orderDocRef, {
        ...draft,
        status: "pending",
        paymentStatus: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        gateway: gatewayId,
        gatewayRef: orderRef,
        gatewayProviderRef: pending.providerRef || null,
        gatewayStatusCode: status.providerCode || null,
        ...(stockShortfall ? { stockShortfall: true } : {}),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(
        pendingRef,
        {
          status: "RECONCILED" as PendingStatus,
          orderId: orderRef,
          providerCode: status.providerCode || null,
          reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(stockShortfall ? { stockShortfall: true } : {}),
        },
        { merge: true },
      );
    });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    // ALREADY_EXISTS = 6 في gRPC: مصالحة متزامنة كسبت السبق. نجاح.
    if (code === 6 || code === "already-exists") {
      return { state: "paid", orderId: orderRef, message: MESSAGES.paid };
    }
    throw error;
  }

  console.log(`[reconcile] ${gatewayId}/${orderRef} ⇒ مدفوع، أُنشئ الطلب`);
  return {
    state: "paid",
    orderId: orderRef,
    providerCode: status.providerCode,
    message: MESSAGES.paid,
  };
}

/** يُعلّم دفعة معلّقة منتهية الصلاحية (يستخدمه المسح الدوري). */
export async function expirePendingPayment(orderRef: string): Promise<void> {
  await pendingPaymentRef(orderRef).set(
    {
      status: "EXPIRED" as PendingStatus,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
