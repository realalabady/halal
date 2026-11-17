"use strict";
/**
 * كل قراءة/كتابة Firestore الخاصة بإعدادات بوابات الدفع، في مكان واحد.
 *
 * الانقسام المهم:
 *  - مستند خاص  stores/{storeId}/settings/{gatewayId}  — بيانات الاعتماد
 *    والبيئة وحالة الاتصال. قواعد Firestore تجعله للأدمن فقط، ويكتبه الخادم.
 *  - نسخة عامة  stores/{storeId}/settings/store.paymentGateways[gatewayId]  —
 *    خالية من الأسرار، وهي وحدها ما يقرأه المتجر. يكتبها Admin SDK فقط
 *    (القاعدة في firestore.rules ترفض أي كتابة أدمن تلمس paymentGateways)،
 *    فـ connected: true تصريح لا يصدر إلا بعد اختبار شبكي حقيقي.
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
exports.isGatewayConfigError = exports.GatewayConfigError = void 0;
exports.maskSecret = maskSecret;
exports.loadGatewayCredentials = loadGatewayCredentials;
exports.writeGatewayCredentials = writeGatewayCredentials;
exports.recordConnectionResult = recordConnectionResult;
exports.setGatewayEnabled = setGatewayEnabled;
exports.mirrorPublicStatus = mirrorPublicStatus;
exports.markGatewayUnhealthy = markGatewayUnhealthy;
exports.readGatewayAdminView = readGatewayAdminView;
exports.buildGatewayContext = buildGatewayContext;
const admin = __importStar(require("firebase-admin"));
const storePaths_1 = require("./storePaths");
class GatewayConfigError extends Error {
}
exports.GatewayConfigError = GatewayConfigError;
const isGatewayConfigError = (e) => e instanceof GatewayConfigError;
exports.isGatewayConfigError = isGatewayConfigError;
const normalizeEnvironment = (value) => value === "production" ? "production" : "sandbox";
/** يقنّع سرّاً لعرضه للأدمن: آخر أربع خانات فقط. */
function maskSecret(value) {
    if (!value)
        return "";
    return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
/** اسم متغيّر البيئة الاحتياطي، مثل MISPAY_APP_SECRET. */
const envVarName = (gatewayId, field) => `${gatewayId.toUpperCase()}_${field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()}`;
/**
 * يقرأ بيانات اعتماد بوابة لمتجر معيّن.
 *
 * طبقتان، نفس شكل initTamaraToken في index.ts: مستند الإعدادات أولاً، ثم
 * متغيّرات البيئة كاحتياطي على مستوى المشروع. يُعيد كائناً *جديداً* في كل
 * نداء؛ لا شيء يُحفظ في نطاق الوحدة، فلا تحمل حاوية دافئة مفاتيح متجر آخر.
 */
async function loadGatewayCredentials(storeId, adapter) {
    const snap = await (0, storePaths_1.settingsRef)(storeId, adapter.id).get();
    const data = snap.data() || {};
    const stored = (data.credentials || {});
    const creds = {};
    const missing = [];
    for (const field of adapter.requiredCredentials) {
        const fromDoc = stored[field];
        const value = typeof fromDoc === "string" && fromDoc.trim()
            ? fromDoc.trim()
            : (process.env[envVarName(adapter.id, field)] || "").trim();
        if (!value) {
            missing.push(field);
            continue;
        }
        creds[field] = value;
    }
    if (missing.length > 0) {
        throw new GatewayConfigError(`إعدادات البوابة غير مكتملة: الحقول الناقصة ${missing.join(", ")}`);
    }
    return { creds, environment: normalizeEnvironment(data.environment) };
}
/** يكتب بيانات الاعتماد ويُرجع الحالة إلى "لم تُختبر". */
async function writeGatewayCredentials(opts) {
    const { storeId, gatewayId, credentials, environment, uid } = opts;
    await (0, storePaths_1.settingsRef)(storeId, gatewayId).set({
        credentials,
        environment,
        connection: { status: "untested" },
        // أي مفتاح جديد يُبطل الرمز المؤقّت المخزّن
        tokenCache: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: uid,
    }, { merge: true });
    // حفظ مفاتيح جديدة لا يعني أنها تعمل: نُخفي البوابة حتى ينجح اختبار.
    await mirrorPublicStatus(storeId, gatewayId, {
        connected: false,
        environment,
    });
}
/** يكتب نتيجة اختبار الاتصال في المستند الخاص، ويُحدّث النسخة العامة. */
async function recordConnectionResult(opts) {
    const { storeId, gatewayId, environment, minAmountSAR, result } = opts;
    const now = admin.firestore.FieldValue.serverTimestamp();
    await (0, storePaths_1.settingsRef)(storeId, gatewayId).set({
        environment,
        connection: {
            status: result.success ? "connected" : "failed",
            message: result.message,
            // التفصيل قد يحمل نصّ خطأ المزوّد: يبقى في المستند الخاص فقط
            detail: result.detail || null,
            lastTestedAt: now,
            ...(result.success ? { lastVerifiedAt: now } : {}),
        },
        updatedAt: now,
    }, { merge: true });
    await mirrorPublicStatus(storeId, gatewayId, {
        connected: result.success,
        environment,
        minAmountSAR: typeof minAmountSAR === "number" ? minAmountSAR : null,
        ...(result.success ? { lastVerifiedAt: now } : {}),
    });
}
/** يفعّل/يعطّل عرض البوابة للعميل دون المساس ببيانات الاعتماد. */
async function setGatewayEnabled(storeId, gatewayId, enabled) {
    await (0, storePaths_1.settingsRef)(storeId, gatewayId).set({
        enabled,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await mirrorPublicStatus(storeId, gatewayId, { enabled });
}
/**
 * ينسخ الحالة الخالية من الأسرار إلى المستند العام الذي يقرأه المتجر.
 * دمج بمسارات النقطة حتى لا تُمسح بوابة أخرى أو بقية إعدادات المتجر.
 */
async function mirrorPublicStatus(storeId, gatewayId, patch) {
    const update = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        update[`paymentGateways.${gatewayId}.${key}`] =
            value === null ? admin.firestore.FieldValue.delete() : value;
    }
    if (Object.keys(update).length === 0)
        return;
    const ref = (0, storePaths_1.settingsRef)(storeId, "store");
    try {
        await ref.update(update);
    }
    catch (_a) {
        // المستند غير موجود بعد: set + merge لا يفهم مسارات النقطة، فنبني الشكل.
        const nested = {};
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === null)
                continue;
            nested[key] = value;
        }
        await ref.set({ paymentGateways: { [gatewayId]: nested } }, { merge: true });
    }
}
/**
 * تُنادى من مسار إنشاء الدفع عندما يرفض المزوّد بيانات الاعتماد.
 * تُنزّل البوابة فوراً حتى لا يرى المشتري التالي خياراً ميّتاً.
 */
async function markGatewayUnhealthy(storeId, gatewayId, reason) {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await (0, storePaths_1.settingsRef)(storeId, gatewayId).set({
        connection: {
            status: "failed",
            message: "رفض المزوّد بيانات الاعتماد. أعد الاختبار من الإعدادات.",
            detail: reason,
            lastTestedAt: now,
        },
        updatedAt: now,
    }, { merge: true });
    await mirrorPublicStatus(storeId, gatewayId, { connected: false });
}
/** العرض الذي تُرجعه لوحة التحكم: حقول مُقنّعة + حالة محفوظة، بلا أي سرّ. */
async function readGatewayAdminView(storeId, adapter, secretFields) {
    const snap = await (0, storePaths_1.settingsRef)(storeId, adapter.id).get();
    const data = snap.data() || {};
    const stored = (data.credentials || {});
    const connection = (data.connection || {});
    const fields = {};
    for (const field of adapter.requiredCredentials) {
        const value = typeof stored[field] === "string" ? stored[field] : "";
        fields[field] = secretFields.includes(field) ? maskSecret(value) : value;
    }
    const asIso = (value) => value instanceof admin.firestore.Timestamp
        ? value.toDate().toISOString()
        : undefined;
    return {
        fields,
        environment: normalizeEnvironment(data.environment),
        enabled: data.enabled !== false,
        connection: {
            status: connection.status || "untested",
            message: typeof connection.message === "string" ? connection.message : undefined,
            lastTestedAt: asIso(connection.lastTestedAt),
            lastVerifiedAt: asIso(connection.lastVerifiedAt),
        },
    };
}
/**
 * يبني سياق النداء. روابط العودة تُشتق على الخادم من stores/{storeId}.domain
 * ولا تُقبل من العميل: رابط عودة يأتي من المتصفح هو ثغرة تحويل مفتوح يراها
 * المشتري على صفحة البوابة.
 */
async function buildGatewayContext(storeId, environment) {
    var _a;
    const snap = await (0, storePaths_1.storeRef)(storeId).get();
    const domain = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.domain;
    const raw = typeof domain === "string" && domain.trim()
        ? domain.trim()
        : process.env.STOREFRONT_BASE_URL || "";
    const baseUrl = raw.replace(/\/+$/, "");
    if (!baseUrl) {
        throw new GatewayConfigError(`نطاق المتجر (domain) غير مضبوط في stores/${storeId}، وبدونه لا يمكن بناء روابط العودة من بوابة الدفع.`);
    }
    const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "";
    const region = process.env.FUNCTIONS_REGION || "us-central1";
    const functionsBaseUrl = (process.env.FUNCTIONS_BASE_URL ||
        (project ? `https://${region}-${project}.cloudfunctions.net` : "")).replace(/\/+$/, "");
    return { storeId, environment, baseUrl, functionsBaseUrl };
}
//# sourceMappingURL=gatewayStore.js.map