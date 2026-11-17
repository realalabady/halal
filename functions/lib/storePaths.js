"use strict";
/**
 * بناة مسارات Firestore للمتجر (multi-tenant).
 *
 * عدة متاجر تتشارك مشروع Firebase واحداً، والدوال تُنشر مرة واحدة للمشروع
 * كله، فلا تُعرف هوية المتجر من متغير بيئة. استُخرجت هذه البناة من index.ts
 * ليستعملها كود بوابات الدفع الجديد بنفس المصدر الواحد بدل نسخها.
 *
 * ملاحظة: لا تُنادِ admin.firestore() وقت تحميل الوحدة — كلها داخل دوال،
 * حتى تبقى بعد admin.initializeApp() في index.ts.
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
exports.STORE_ID_PATTERN = void 0;
exports.storeRef = storeRef;
exports.storeCol = storeCol;
exports.storeDoc = storeDoc;
exports.settingsRef = settingsRef;
exports.pendingPaymentRef = pendingPaymentRef;
exports.pendingPaymentsCol = pendingPaymentsCol;
const admin = __importStar(require("firebase-admin"));
exports.STORE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** مستند جذر المتجر: stores/{storeId} */
function storeRef(storeId) {
    return admin.firestore().doc(`stores/${storeId}`);
}
/** مجموعة فرعية داخل المتجر: stores/{storeId}/{col} */
function storeCol(storeId, col) {
    return admin.firestore().collection(`stores/${storeId}/${col}`);
}
/** مستند داخل مجموعة فرعية: stores/{storeId}/{col}/{id} */
function storeDoc(storeId, col, id) {
    return admin.firestore().doc(`stores/${storeId}/${col}/${id}`);
}
/** مستند إعدادات داخل المتجر: stores/{storeId}/settings/{id} */
function settingsRef(storeId, id) {
    return storeDoc(storeId, "settings", id);
}
/** مجموعة الدفعات المعلّقة — عليا (top-level)، يكتبها Admin SDK وحده. */
function pendingPaymentRef(orderRef) {
    return admin.firestore().doc(`pending_payments/${orderRef}`);
}
function pendingPaymentsCol() {
    return admin.firestore().collection("pending_payments");
}
//# sourceMappingURL=storePaths.js.map