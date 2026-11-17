"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileGatewayPayment = reconcileGatewayPayment;
exports.expirePendingPayment = expirePendingPayment;
const admin = __importStar(require("firebase-admin"));
const storePaths_1 = require("./storePaths");
const gatewayRegistry_1 = require("./gatewayRegistry");
const gatewayStore_1 = require("./gatewayStore");
const gatewayHttp_1 = require("./gatewayHttp");
const MESSAGES = {
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
async function reconcileGatewayPayment(storeId, orderRef) {
    var _a;
    const pendingRef = (0, storePaths_1.pendingPaymentRef)(orderRef);
    const pendingSnap = await pendingRef.get();
    if (!pendingSnap.exists) {
        return { state: "failed", message: "سجل الدفع غير موجود." };
    }
    const pending = pendingSnap.data();
    if (pending.storeId !== storeId) {
        // مرجع دفع لا يخصّ هذا المتجر: لا نُفصح عن وجوده.
        return { state: "failed", message: "سجل الدفع غير موجود." };
    }
    // مسار سريع آمن للتكرار: مصالحة سابقة أنجزت العمل.
    if (pending.status === "RECONCILED") {
        return {
            state: "paid",
            orderId: pending.orderId || orderRef,
            message: MESSAGES.paid,
        };
    }
    if (pending.status === "CANCELLED" || pending.status === "FAILED") {
        const state = pending.status === "CANCELLED" ? "cancelled" : "failed";
        return { state, message: MESSAGES[state] };
    }
    const gatewayId = String(pending.gateway || "");
    const adapter = (0, gatewayRegistry_1.requireAdapter)(gatewayId);
    // ===== الحالة المعتمدة تأتي من المزوّد، خادماً إلى خادم =====
    // لا من حمولة العودة (قناة يتحكّم بها متصفّح العميل) ولا من الـ webhook
    // (غير موقّع في MIS Pay و Madfu معاً).
    let status;
    try {
        const { creds, environment } = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
        const ctx = await (0, gatewayStore_1.buildGatewayContext)(storeId, environment);
        status = await adapter.getStatus(String(pending.providerRef || orderRef), creds, ctx);
    }
    catch (error) {
        const reason = (0, gatewayHttp_1.describeGatewayError)(error);
        if (adapter.isAuthError(error)) {
            await (0, gatewayStore_1.markGatewayUnhealthy)(storeId, gatewayId, reason);
        }
        console.error(`[reconcile] ${gatewayId}/${orderRef} فشل الاستعلام:`, reason);
        // لا نُغيّر شيئاً: المسح الدوري سيعيد المحاولة.
        return { state: "pending", message: MESSAGES.pending };
    }
    if (status.state !== "paid") {
        const terminal = status.state === "cancelled"
            ? "CANCELLED"
            : status.state === "failed"
                ? "FAILED"
                : null;
        if (terminal) {
            await pendingRef.set({
                status: terminal,
                providerCode: status.providerCode || null,
                resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        return {
            state: status.state,
            providerCode: status.providerCode,
            message: MESSAGES[status.state] || MESSAGES.pending,
        };
    }
    // ===== مدفوع: تحقّق من المبلغ ثم أنشئ الطلب =====
    const expected = Number((_a = pending.amount) !== null && _a !== void 0 ? _a : 0);
    if (typeof status.amount === "number" &&
        Number.isFinite(status.amount) &&
        Math.abs(status.amount - expected) > 0.01) {
        // لا نُنشئ طلباً بمبلغ لا يطابق ما حسبه الخادم.
        await pendingRef.set({
            status: "FAILED",
            amountMismatch: { expected, received: status.amount },
            resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.error(`[reconcile] ${gatewayId}/${orderRef} عدم تطابق المبلغ: متوقّع ${expected} ووارد ${status.amount}`);
        return {
            state: "failed",
            message: "المبلغ المدفوع لا يطابق إجمالي الطلب. تواصل مع المتجر.",
        };
    }
    const draft = (pending.draft || {});
    const orderDocRef = (0, storePaths_1.storeDoc)(storeId, "orders", orderRef);
    try {
        await admin.firestore().runTransaction(async (tx) => {
            var _a, _b;
            const existing = await tx.get(orderDocRef);
            if (existing.exists) {
                // سبقتنا مصالحة أخرى؛ نكمل لتثبيت حالة pending فقط.
                tx.set(pendingRef, {
                    status: "RECONCILED",
                    orderId: orderRef,
                    reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
                return;
            }
            // إعادة فحص المخزون: قد يكون نفد أثناء وجود العميل على صفحة البوابة.
            // الطلب المدفوع لا يُسقَط أبداً — نُعلّمه ونُنبّه صاحب المتجر.
            let stockShortfall = false;
            for (const item of draft.items || []) {
                const productSnap = await tx.get((0, storePaths_1.storeDoc)(storeId, "products", item.productId));
                const stock = Number((_b = (_a = productSnap.data()) === null || _a === void 0 ? void 0 : _a.stock) !== null && _b !== void 0 ? _b : 0);
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
            tx.set(pendingRef, {
                status: "RECONCILED",
                orderId: orderRef,
                providerCode: status.providerCode || null,
                reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
                ...(stockShortfall ? { stockShortfall: true } : {}),
            }, { merge: true });
        });
    }
    catch (error) {
        const code = error.code;
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
async function expirePendingPayment(orderRef) {
    await (0, storePaths_1.pendingPaymentRef)(orderRef).set({
        status: "EXPIRED",
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
}
//# sourceMappingURL=paymentReconcile.js.map