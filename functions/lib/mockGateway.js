"use strict";
/**
 * بوابة وهمية — للمحاكي فقط، لا تُسجَّل في الإنتاج أبداً.
 *
 * تسمح بتشغيل التدفّق كاملاً محلياً: إعداد ← اختبار اتصال ← ظهور في
 * الـ checkout ← تحويل ← عودة ← إنشاء الطلب، دون حساب تاجر حقيقي.
 *
 * الحارس الوحيد الذي يهمّ: التسجيل يحدث فقط عند وجود FUNCTIONS_EMULATOR،
 * وهو متغيّر يضبطه مشغّل المحاكي ولا يوجد في Cloud Functions المنشورة.
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
exports.isEmulator = exports.mockAdapter = void 0;
exports.markMockPaid = markMockPaid;
const admin = __importStar(require("firebase-admin"));
/**
 * حالة الدفع الوهمي في Firestore لا في الذاكرة: محاكي الدوال يشغّل كل دالة
 * في عملية مستقلّة، فصفحة الدفع و getStatus لا تتشاركان ذاكرة.
 */
const mockRef = (providerRef) => admin.firestore().doc(`mock_payments/${providerRef}`);
/** يُستدعى من صفحة الدفع الوهمية لتعليم العملية مدفوعة. */
async function markMockPaid(providerRef) {
    await mockRef(providerRef).set({ paid: true, at: Date.now() });
}
exports.mockAdapter = {
    id: "mockpay",
    requiredCredentials: ["apiKey"],
    minAmountSAR: 50,
    isAuthError() {
        return false;
    },
    async testConnection(creds) {
        // مفتاح يبدأ بـ bad_ يُمثّل مفتاحاً خاطئاً، لاختبار مسار الفشل أيضاً.
        if ((creds.apiKey || "").startsWith("bad_")) {
            return { success: false, message: "مفتاح وهمي غير صالح." };
        }
        return { success: true, message: "تم الاتصال بالبوابة الوهمية بنجاح." };
    },
    async createCheckout(input, _creds, ctx) {
        const providerRef = `mock_${input.orderRef}`;
        // صفحة دفع وهمية تستضيفها دالة في المحاكي
        const url = `${ctx.functionsBaseUrl}/mockPayPage` +
            `?ref=${encodeURIComponent(providerRef)}` +
            `&store=${encodeURIComponent(ctx.storeId)}` +
            `&amount=${encodeURIComponent(String(input.amount))}` +
            `&ret=${encodeURIComponent(input.returnUrl)}`;
        return { redirectUrl: url, providerRef };
    },
    async getStatus(providerRef) {
        var _a;
        const snap = await mockRef(providerRef).get();
        return ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.paid) === true
            ? { state: "paid", providerCode: "MOCK_PAID" }
            : { state: "pending", providerCode: "MOCK_PENDING" };
    },
};
const isEmulator = () => !!process.env.FUNCTIONS_EMULATOR;
exports.isEmulator = isEmulator;
//# sourceMappingURL=mockGateway.js.map