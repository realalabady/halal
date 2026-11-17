"use strict";
/**
 * عقد محوّل بوابة الدفع — الجانب الخادم
 *
 * كل دالة تأخذ بيانات الاعتماد كوسيط صريح. لا يوجد setter ولا حالة عامة
 * داخل الوحدة، بخلاف tamaraClient.ts / tabbyClient.ts التي تحفظ المفاتيح في
 * متغيّر على مستوى الوحدة — الدوال تُنشر مرة واحدة لكل المتاجر، فحاوية دافئة
 * تنسى إعادة التهيئة تستخدم مفاتيح متجر مع متجر آخر. الشكل هنا يجعل ذلك
 * الخطأ غير ممكن.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGatewayAuthError = exports.GatewayAuthError = void 0;
/** خطأ يحمل تصنيفاً حتى يميّز المحوّل أخطاء الاعتماد عن غيرها. */
class GatewayAuthError extends Error {
    constructor(message) {
        super(message);
        this.isGatewayAuthError = true;
        this.name = "GatewayAuthError";
    }
}
exports.GatewayAuthError = GatewayAuthError;
const isGatewayAuthError = (error) => error instanceof GatewayAuthError ||
    (typeof error === "object" &&
        error !== null &&
        error.isGatewayAuthError === true);
exports.isGatewayAuthError = isGatewayAuthError;
//# sourceMappingURL=gatewayTypes.js.map