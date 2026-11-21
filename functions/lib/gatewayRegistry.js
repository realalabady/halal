"use strict";
/**
 * سجل محوّلات بوابات الدفع — الجانب الخادم.
 *
 * خريطة مغلقة: الاسم النصّي القادم من العميل لا يُستخدم إلا للبحث فيها،
 * فلا يستطيع عميل متلاعِب توسيع ما يفعله الخادم. المحوّلات كائنات في خريطة
 * (لا import داخل المصالحة) حتى يمكن تسجيل محوّل وهمي في اختبارات المحاكي.
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
exports.secretFieldsOf = exports.GATEWAY_SECRET_FIELDS = exports.GATEWAY_ADAPTERS = void 0;
exports.requireAdapter = requireAdapter;
exports.registerTestAdapter = registerTestAdapter;
const functions = __importStar(require("firebase-functions"));
const mispayClient_1 = require("./mispayClient");
const madfuClient_1 = require("./madfuClient");
const neoleapClient_1 = require("./neoleapClient");
const tabbyAdapter_1 = require("./tabbyAdapter");
const tamaraAdapter_1 = require("./tamaraAdapter");
exports.GATEWAY_ADAPTERS = {
    [mispayClient_1.misPayAdapter.id]: mispayClient_1.misPayAdapter,
    [madfuClient_1.madfuAdapter.id]: madfuClient_1.madfuAdapter,
    [neoleapClient_1.neoleapAdapter.id]: neoleapClient_1.neoleapAdapter,
    // تمارا وتابي انتقلتا إلى السجل ليظهرا للعميل عبر نفس المسار المتحقَّق
    // منه (اتصال مُختبَر + مصالحة خادم-إلى-خادم). ملفّاهما القديمان
    // tamaraClient.ts / tabbyClient.ts باقيان للدوال القديمة دون تغيير.
    [tamaraAdapter_1.tamaraAdapter.id]: tamaraAdapter_1.tamaraAdapter,
    [tabbyAdapter_1.tabbyAdapter.id]: tabbyAdapter_1.tabbyAdapter,
};
/** الحقول السرّية لكل بوابة: لا تُرجَع للوحة التحكم إلا مُقنّعة. */
exports.GATEWAY_SECRET_FIELDS = {
    mispay: ["appSecret"],
    madfu: ["basicToken", "password"],
    neoleap: ["tranportalPassword", "resourceKey", "iv"],
    tamara: ["apiToken"],
    tabby: ["secretKey"],
};
/** يُرجع المحوّل أو يرفع خطأ نداء واضحاً. */
function requireAdapter(gatewayId) {
    const id = typeof gatewayId === "string" ? gatewayId.trim() : "";
    const adapter = exports.GATEWAY_ADAPTERS[id];
    if (!adapter) {
        throw new functions.https.HttpsError("invalid-argument", `بوابة دفع غير معروفة: ${id || "(فارغ)"}`);
    }
    return adapter;
}
const secretFieldsOf = (gatewayId) => exports.GATEWAY_SECRET_FIELDS[gatewayId] || [];
exports.secretFieldsOf = secretFieldsOf;
/** للاختبارات فقط: تسجيل/إزالة محوّل وهمي في المحاكي. */
function registerTestAdapter(adapter) {
    if (!process.env.FUNCTIONS_EMULATOR) {
        throw new Error("registerTestAdapter متاح في المحاكي فقط");
    }
    exports.GATEWAY_ADAPTERS[adapter.id] = adapter;
}
//# sourceMappingURL=gatewayRegistry.js.map