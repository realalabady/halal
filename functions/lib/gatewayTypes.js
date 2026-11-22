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
exports.isGatewayAuthError = exports.GatewayAuthError = exports.isGatewayDeclinedError = exports.GatewayDeclinedError = void 0;
/**
 * رفض تجاري من المزوّد: المفاتيح سليمة والنداء صحيح، لكن المزوّد لم يعتمد
 * هذه العملية (تقييم المشتري، مبلغ خارج حدّه، منتج غير متاح له).
 *
 * نوع مستقلّ لأن الفرق عمليّ: خطأ داخلي يُعالَج بإعادة المحاولة، أما الرفض
 * فإعادة المحاولة لن تغيّره أبداً — على المشتري اختيار طريقة أخرى. وبلا
 * تمييز كانت رسالة المزوّد الواضحة تُبتلع خلف "حاول مرة أخرى".
 */
class GatewayDeclinedError extends Error {
    constructor(message) {
        super(message);
        this.isGatewayDeclinedError = true;
        this.name = "GatewayDeclinedError";
    }
}
exports.GatewayDeclinedError = GatewayDeclinedError;
const isGatewayDeclinedError = (error) => error instanceof GatewayDeclinedError;
exports.isGatewayDeclinedError = isGatewayDeclinedError;
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