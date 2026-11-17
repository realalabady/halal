"use strict";
/**
 * نقاط النهاية العامة لبوابات الدفع — مجموعة واحدة لكل البوابات.
 *
 * لماذا مجموعة عامة بدل أربع دوال لكل بوابة (نمط Tabby/Tamara الحالي):
 * كل بوابة جديدة كانت ستضيف أربع دوال إلى النشر (بدء بارد، حصص، إدارة)
 * وأربع أغلفة في الواجهة. الاختيار يبقى على الخادم من خريطة مغلقة، وبيانات
 * الاعتماد تُقرأ لكل متجر في كل نداء، فالعزل لم يتغيّر.
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
exports.GatewayConfigError = void 0;
exports.normalizeSaudiMobile = normalizeSaudiMobile;
exports.buildPaymentGatewayFunctions = buildPaymentGatewayFunctions;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const crypto_1 = require("crypto");
const storePaths_1 = require("./storePaths");
const gatewayRegistry_1 = require("./gatewayRegistry");
const gatewayStore_1 = require("./gatewayStore");
Object.defineProperty(exports, "GatewayConfigError", { enumerable: true, get: function () { return gatewayStore_1.GatewayConfigError; } });
const gatewayHttp_1 = require("./gatewayHttp");
const orderPricing_1 = require("./orderPricing");
const paymentReconcile_1 = require("./paymentReconcile");
/** ساعتان: بعدها تُعدّ محاولة الدفع منتهية. */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const asString = (value) => typeof value === "string" ? value.trim() : "";
const normalizeEnvironment = (value) => value === "production" ? "production" : "sandbox";
/** يحوّل أخطاء الإعداد إلى HttpsError بالعربية. */
function toHttpsError(error, fallback) {
    if (error instanceof functions.https.HttpsError)
        throw error;
    if ((0, gatewayStore_1.isGatewayConfigError)(error)) {
        throw new functions.https.HttpsError("failed-precondition", error.message);
    }
    console.error(fallback, error);
    throw new functions.https.HttpsError("internal", fallback);
}
/**
 * يرقّم هاتفاً سعودياً إلى الشكل الذي تتوقّعه البوابات (05XXXXXXXX).
 * الاختلاف بين 05 و +9665 سبب شائع لرفض إنشاء الدفع.
 */
function normalizeSaudiMobile(raw) {
    const digits = (raw || "").replace(/[^\d]/g, "");
    if (digits.startsWith("966"))
        return `0${digits.slice(3)}`;
    if (digits.startsWith("00966"))
        return `0${digits.slice(5)}`;
    if (digits.startsWith("5") && digits.length === 9)
        return `0${digits}`;
    return digits;
}
/**
 * يبني مجموعة الدوال. تُمرَّر المساعدات من index.ts بدل تصديرها، حتى لا
 * تتغيّر أي نقطة تحقّق قائمة.
 */
function buildPaymentGatewayFunctions(deps) {
    const { requireStoreId, requireStoreAdmin, parseStoreIdParam } = deps;
    // ==================== حفظ بيانات الاعتماد ====================
    const paymentGatewaySaveSettings = functions.https.onCall(async (data, context) => {
        const storeId = await requireStoreAdmin(data, context);
        const adapter = (0, gatewayRegistry_1.requireAdapter)(data === null || data === void 0 ? void 0 : data.gateway);
        const environment = normalizeEnvironment(data === null || data === void 0 ? void 0 : data.environment);
        const incoming = ((data === null || data === void 0 ? void 0 : data.credentials) || {});
        // الحقول السرّية تُعاد مُقنّعة إلى الواجهة؛ إن أعادها الأدمن كما هي
        // فهو لم يُعدّلها، فنُبقي المحفوظ بدل كتابة "••••1234" مكان السرّ.
        const existing = await (0, gatewayStore_1.readGatewayAdminView)(storeId, adapter, (0, gatewayRegistry_1.secretFieldsOf)(adapter.id));
        const credentials = {};
        const missing = [];
        for (const field of adapter.requiredCredentials) {
            const value = asString(incoming[field]);
            const isMasked = value !== "" && value === existing.fields[field];
            if (isMasked)
                continue;
            if (!value) {
                missing.push(field);
                continue;
            }
            credentials[field] = value;
        }
        // الحقول الاختيارية (مثل iv و gatewayHost في neoleap)
        for (const [key, raw] of Object.entries(incoming)) {
            if (adapter.requiredCredentials.includes(key))
                continue;
            const value = asString(raw);
            if (value && value !== (0, gatewayStore_1.maskSecret)(value))
                credentials[key] = value;
        }
        if (missing.length > 0) {
            throw new functions.https.HttpsError("invalid-argument", `الحقول التالية مطلوبة: ${missing.join(", ")}`);
        }
        try {
            await (0, gatewayStore_1.writeGatewayCredentials)({
                storeId,
                gatewayId: adapter.id,
                credentials,
                environment,
                uid: context.auth.uid,
            });
            if (typeof (data === null || data === void 0 ? void 0 : data.enabled) === "boolean") {
                await (0, gatewayStore_1.setGatewayEnabled)(storeId, adapter.id, data.enabled);
            }
            return {
                success: true,
                message: "تم حفظ الإعدادات. اضغط \"اختبار الاتصال\" لتفعيل البوابة للعملاء.",
            };
        }
        catch (error) {
            toHttpsError(error, "خطأ في حفظ إعدادات بوابة الدفع");
        }
    });
    // ==================== اختبار الاتصال ====================
    const paymentGatewayTestConnection = functions.https.onCall(async (data, context) => {
        const storeId = await requireStoreAdmin(data, context);
        const adapter = (0, gatewayRegistry_1.requireAdapter)(data === null || data === void 0 ? void 0 : data.gateway);
        try {
            // نختبر ما هو محفوظ فعلاً: اختبار يمرّ على مفاتيح في الحمولة قد ينجح
            // ثم يفشل الدفع لأن المحفوظ مختلف.
            const { creds, environment } = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
            const ctx = await (0, gatewayStore_1.buildGatewayContext)(storeId, environment);
            const result = await adapter.testConnection(creds, ctx);
            await (0, gatewayStore_1.recordConnectionResult)({
                storeId,
                gatewayId: adapter.id,
                environment,
                minAmountSAR: adapter.minAmountSAR,
                result,
            });
            return {
                success: result.success,
                message: result.message,
                connected: result.success,
            };
        }
        catch (error) {
            if ((0, gatewayStore_1.isGatewayConfigError)(error)) {
                throw new functions.https.HttpsError("failed-precondition", error.message);
            }
            const detail = (0, gatewayHttp_1.describeGatewayError)(error);
            await (0, gatewayStore_1.recordConnectionResult)({
                storeId,
                gatewayId: adapter.id,
                environment: normalizeEnvironment(data === null || data === void 0 ? void 0 : data.environment),
                minAmountSAR: adapter.minAmountSAR,
                result: { success: false, message: "فشل اختبار الاتصال.", detail },
            }).catch(() => undefined);
            return {
                success: false,
                connected: false,
                message: `فشل اختبار الاتصال: ${detail}`,
            };
        }
    });
    // ==================== حالة الإعدادات للوحة التحكم ====================
    const paymentGatewayGetStatus = functions.https.onCall(async (data, context) => {
        const storeId = await requireStoreAdmin(data, context);
        const adapter = (0, gatewayRegistry_1.requireAdapter)(data === null || data === void 0 ? void 0 : data.gateway);
        try {
            const view = await (0, gatewayStore_1.readGatewayAdminView)(storeId, adapter, (0, gatewayRegistry_1.secretFieldsOf)(adapter.id));
            return { gateway: adapter.id, ...view };
        }
        catch (error) {
            toHttpsError(error, "خطأ في قراءة إعدادات بوابة الدفع");
        }
    });
    // ==================== تفعيل/تعطيل العرض للعميل ====================
    const paymentGatewaySetEnabled = functions.https.onCall(async (data, context) => {
        const storeId = await requireStoreAdmin(data, context);
        const adapter = (0, gatewayRegistry_1.requireAdapter)(data === null || data === void 0 ? void 0 : data.gateway);
        const enabled = (data === null || data === void 0 ? void 0 : data.enabled) === true;
        try {
            await (0, gatewayStore_1.setGatewayEnabled)(storeId, adapter.id, enabled);
            return { success: true, enabled };
        }
        catch (error) {
            toHttpsError(error, "خطأ في تحديث حالة بوابة الدفع");
        }
    });
    // ==================== إنشاء عملية دفع ====================
    const paymentGatewayCreateCheckout = functions.https.onCall(async (data, context) => {
        var _a;
        const storeId = await requireStoreId(data);
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "يجب تسجيل الدخول لإتمام الدفع");
        }
        const uid = context.auth.uid;
        const adapter = (0, gatewayRegistry_1.requireAdapter)(data === null || data === void 0 ? void 0 : data.gateway);
        // ===== التسعير على الخادم =====
        // الأسعار والأسماء تُقرأ من مستندات المنتجات؛ ما يُرسله المتصفّح
        // يُستخدم للتحقق فقط، والمبلغ الذي تراه البوابة هو مبلغ الخادم.
        const pricing = await (0, orderPricing_1.computeOrderPricing)(storeId, data === null || data === void 0 ? void 0 : data.items);
        await (0, orderPricing_1.validateOrderAmountFromPricing)(pricing, Number(data === null || data === void 0 ? void 0 : data.total));
        if (adapter.minAmountSAR && pricing.total < adapter.minAmountSAR) {
            throw new functions.https.HttpsError("failed-precondition", `الحد الأدنى لهذه الطريقة ${adapter.minAmountSAR} ر.س`);
        }
        const mobile = normalizeSaudiMobile(asString(data === null || data === void 0 ? void 0 : data.phone));
        if (!mobile) {
            throw new functions.https.HttpsError("invalid-argument", "رقم الجوال مطلوب لإتمام الدفع");
        }
        const fulfillment = (data === null || data === void 0 ? void 0 : data.fulfillment) === "pickup" ? "pickup" : "delivery";
        const address = ((data === null || data === void 0 ? void 0 : data.address) || {});
        const customerName = asString(data === null || data === void 0 ? void 0 : data.customer) || "عميل";
        // معرّف قصير: يصبح معرّف مستند الطلب وأيضاً orderId عند المزوّد،
        // وبعض المزوّدين يحدّون طوله ومحارفه.
        const orderRef = `${adapter.id}-${(0, crypto_1.randomUUID)().replace(/-/g, "").slice(0, 10)}`;
        const draft = {
            userId: uid,
            customer: customerName,
            email: asString(data === null || data === void 0 ? void 0 : data.email) || ((_a = context.auth.token) === null || _a === void 0 ? void 0 : _a.email) || "",
            phone: mobile,
            items: pricing.items.map((item) => ({
                productId: item.productId,
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                image: item.image || "",
            })),
            total: pricing.total,
            subtotal: pricing.subtotal,
            shippingCost: pricing.shippingCost,
            paymentMethod: adapter.id,
            fulfillment,
            shippingAddress: asString(data === null || data === void 0 ? void 0 : data.shippingAddress),
            address: {
                fullName: customerName,
                phone: mobile,
                city: asString(address.city),
                district: asString(address.district),
                street: asString(address.street),
                building: asString(address.building),
                nationalAddress: asString(address.nationalAddress),
            },
            notes: asString(data === null || data === void 0 ? void 0 : data.notes),
        };
        let creds;
        let environment;
        try {
            const loaded = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
            creds = loaded.creds;
            environment = loaded.environment;
        }
        catch (error) {
            if ((0, gatewayStore_1.isGatewayConfigError)(error)) {
                throw new functions.https.HttpsError("failed-precondition", "طريقة الدفع غير مُعدّة في هذا المتجر.");
            }
            throw error;
        }
        const ctx = await (0, gatewayStore_1.buildGatewayContext)(storeId, environment);
        const returnBase = `${ctx.baseUrl}/payment/return/${adapter.id}?ref=${encodeURIComponent(orderRef)}`;
        // يُكتب قبل النداء: إن نجح إنشاء الدفع عند المزوّد ثم انقطع الاتصال
        // قبل وصول الردّ، يبقى للمسح الدوري سجلّ يصالحه.
        await (0, storePaths_1.pendingPaymentRef)(orderRef).set({
            storeId,
            userId: uid,
            gateway: adapter.id,
            environment,
            status: "CREATED",
            amount: pricing.total,
            subtotal: pricing.subtotal,
            shippingAmount: pricing.shippingCost,
            vat: pricing.vat,
            currency: "SAR",
            draft,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + PENDING_TTL_MS),
        });
        try {
            const result = await adapter.createCheckout({
                orderRef,
                amount: pricing.total,
                currency: "SAR",
                subtotal: pricing.subtotal,
                shippingAmount: pricing.shippingCost,
                vat: pricing.vat,
                items: pricing.items.map((item) => ({
                    productId: item.productId,
                    name: item.name,
                    quantity: item.quantity,
                    unitPrice: item.price,
                    image: item.image,
                })),
                customer: {
                    name: customerName,
                    email: draft.email,
                    mobile,
                },
                address: {
                    city: draft.address.city,
                    district: draft.address.district,
                    street: draft.address.street,
                    building: draft.address.building,
                },
                returnUrl: returnBase,
                cancelUrl: `${returnBase}&outcome=cancel`,
                failureUrl: `${returnBase}&outcome=failure`,
                lang: "ar",
            }, creds, ctx);
            await (0, storePaths_1.pendingPaymentRef)(orderRef).set({ providerRef: result.providerRef, redirectUrl: result.redirectUrl }, { merge: true });
            return { redirectUrl: result.redirectUrl, orderRef };
        }
        catch (error) {
            const detail = (0, gatewayHttp_1.describeGatewayError)(error);
            await (0, storePaths_1.pendingPaymentRef)(orderRef).set({
                status: "FAILED",
                lastError: detail,
                resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            if (adapter.isAuthError(error)) {
                // المفاتيح ميّتة: نُخفي البوابة فوراً عن بقية المشترين.
                await (0, gatewayStore_1.markGatewayUnhealthy)(storeId, adapter.id, detail).catch(() => undefined);
                throw new functions.https.HttpsError("failed-precondition", "طريقة الدفع غير متاحة حالياً. اختر طريقة أخرى.");
            }
            console.error(`[${adapter.id}] createCheckout فشل:`, detail);
            throw new functions.https.HttpsError("internal", "تعذّر بدء عملية الدفع. حاول مرة أخرى.");
        }
    });
    // ==================== صفحة العودة: تسوية الحالة ====================
    const paymentGatewayResolveReturn = functions.https.onCall(async (data, context) => {
        var _a, _b;
        const storeId = await requireStoreId(data);
        if (!context.auth) {
            throw new functions.https.HttpsError("unauthenticated", "يجب تسجيل الدخول");
        }
        const orderRef = asString(data === null || data === void 0 ? void 0 : data.orderRef);
        if (!orderRef) {
            throw new functions.https.HttpsError("invalid-argument", "مرجع الدفع مطلوب");
        }
        const snap = await (0, storePaths_1.pendingPaymentRef)(orderRef).get();
        if (!snap.exists || ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.storeId) !== storeId) {
            throw new functions.https.HttpsError("not-found", "سجل الدفع غير موجود");
        }
        if (((_b = snap.data()) === null || _b === void 0 ? void 0 : _b.userId) !== context.auth.uid) {
            throw new functions.https.HttpsError("permission-denied", "هذا الدفع لا يخص المستخدم الحالي");
        }
        try {
            const result = await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, orderRef);
            return result;
        }
        catch (error) {
            toHttpsError(error, "خطأ في تأكيد الدفع");
        }
    });
    // ==================== عودة المتصفّح من MIS Pay ====================
    //
    // MIS Pay تُنادي رابط العودة المسجّل مسبقاً بـ  ?_=<base64>  مشفّراً
    // AES-GCM بسرّ التاجر، فهو موثّق ضد التلاعب — وهذا نادر في روابط العودة.
    // ومع ذلك لا نُعلّم الطلب مدفوعاً منه: العودة قناة يتحكّم بها متصفّح
    // العميل، و code قد يُعاد تشغيله من عملية ناجحة أقدم. المصالحة تستعلم.
    //
    // المتجر لا يمكن استنتاجه من المغلّف (orderId داخل التشفير)، فنُسجّل
    // الرابط بـ ?store=<storeId>.
    const mispayReturn = functions.https.onRequest(async (req, res) => {
        var _a;
        const storeId = parseStoreIdParam(req.query.store);
        const blob = typeof req.query._ === "string" ? req.query._ : "";
        if (!storeId) {
            res.status(400).send("missing store");
            return;
        }
        let redirect = "/";
        try {
            const adapter = (0, gatewayRegistry_1.requireAdapter)("mispay");
            const { creds, environment } = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
            const ctx = await (0, gatewayStore_1.buildGatewayContext)(storeId, environment);
            redirect = `${ctx.baseUrl}/payment/return/mispay`;
            if (blob) {
                const { decryptMisPayCallback } = await Promise.resolve().then(() => __importStar(require("./mispayClient")));
                const payload = decryptMisPayCallback(blob, creds.appSecret);
                const snap = await (0, storePaths_1.pendingPaymentRef)(payload.orderId).get();
                if (snap.exists && ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.storeId) === storeId) {
                    await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, payload.orderId);
                }
                else {
                    console.warn(`[mispay] عودة بمرجع غير معروف: ${payload.orderId}`);
                }
                redirect = `${redirect}?ref=${encodeURIComponent(payload.orderId)}`;
            }
        }
        catch (error) {
            console.error("[mispay] فشل معالجة العودة:", (0, gatewayHttp_1.describeGatewayError)(error));
        }
        res.redirect(302, redirect);
    });
    // ==================== webhook الخاص بـ MIS Pay ====================
    //
    // الحمولة نصّية: { checkoutId, orderId, code, appId }. غير موقّعة — لا
    // توقيع ولا HMAC، فقط قائمة IP — وتُرسل *مرة واحدة بلا إعادة محاولة*.
    // لذلك: نتجاهل code ونستعلم من الخادم، والمسح الدوري هو الضمان الحقيقي.
    const mispayWebhook = functions.https.onRequest(async (req, res) => {
        var _a;
        const body = (req.body || {});
        const orderRef = asString(body.orderId);
        if (!orderRef) {
            res.status(200).send("ignored");
            return;
        }
        try {
            const snap = await (0, storePaths_1.pendingPaymentRef)(orderRef).get();
            if (!snap.exists) {
                // 200 دائماً: لا إعادة محاولة أصلاً، ولا نُفصح عمّا نعرف.
                console.warn(`[mispay] webhook بمرجع غير معروف: ${orderRef}`);
                res.status(200).send("ok");
                return;
            }
            const storeId = String(((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.storeId) || "");
            const adapter = (0, gatewayRegistry_1.requireAdapter)("mispay");
            const { creds } = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
            const { appIdMatches } = await Promise.resolve().then(() => __importStar(require("./mispayClient")));
            // تحقّق ضعيف لكنه يمنع النكز الأعمى بين المتاجر.
            if (!appIdMatches(asString(body.appId), creds.appId)) {
                console.warn(`[mispay] webhook بـ appId غير مطابق للمرجع ${orderRef}`);
                res.status(200).send("ok");
                return;
            }
            await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, orderRef);
            res.status(200).send("ok");
        }
        catch (error) {
            console.error("[mispay] فشل webhook:", (0, gatewayHttp_1.describeGatewayError)(error));
            // 200 حتى لا تُحسب محاولة فاشلة؛ المسح الدوري يلتقط الباقي.
            res.status(200).send("ok");
        }
    });
    // ==================== webhook الخاص بـ Madfu ====================
    //
    // الحمولة: { orderId, status, orderStatus, invoceCode (بهذا الإملاء في
    // وثائقهم), merchantReference }. غير موقّعة أيضاً، فنعتمد على الاستعلام.
    // merchantReference هو orderRef الذي أرسلناه.
    const madfuWebhook = functions.https.onRequest(async (req, res) => {
        var _a, _b;
        const body = (req.body || {});
        const orderRef = asString(body.merchantReference) || asString(body.MerchantReference);
        if (!orderRef) {
            console.warn("[madfu] webhook بلا merchantReference");
            res.status(200).send("ok");
            return;
        }
        try {
            const snap = await (0, storePaths_1.pendingPaymentRef)(orderRef).get();
            if (!snap.exists || ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.gateway) !== "madfu") {
                console.warn(`[madfu] webhook بمرجع غير معروف: ${orderRef}`);
                res.status(200).send("ok");
                return;
            }
            await (0, paymentReconcile_1.reconcileGatewayPayment)(String(((_b = snap.data()) === null || _b === void 0 ? void 0 : _b.storeId) || ""), orderRef);
            res.status(200).send("ok");
        }
        catch (error) {
            console.error("[madfu] فشل webhook:", (0, gatewayHttp_1.describeGatewayError)(error));
            res.status(200).send("ok");
        }
    });
    // ==================== عودة المتصفّح من neoleap ====================
    //
    // البوابة تُرسل POST إلى responseURL بحقل trandata مشفّر، وتتوقّع في
    // بعض الإصدارات أن يردّ التاجر بجسم  REDIRECT=<url>  بدل تحويل 302.
    // ندعم الشكلين: نكتب REDIRECT= لطلبات POST، ونحوّل 302 لطلبات GET.
    const neoleapReturn = functions.https.onRequest(async (req, res) => {
        var _a;
        const storeId = parseStoreIdParam(req.query.store);
        const source = (req.method === "POST" ? req.body : req.query) || {};
        const trandata = asString(source.trandata);
        if (!storeId) {
            res.status(400).send("missing store");
            return;
        }
        let target = "/";
        try {
            const adapter = (0, gatewayRegistry_1.requireAdapter)("neoleap");
            const { creds, environment } = await (0, gatewayStore_1.loadGatewayCredentials)(storeId, adapter);
            const ctx = await (0, gatewayStore_1.buildGatewayContext)(storeId, environment);
            target = `${ctx.baseUrl}/payment/return/neoleap`;
            if (trandata) {
                const { decodeNeoleapReturn } = await Promise.resolve().then(() => __importStar(require("./neoleapClient")));
                const payload = decodeNeoleapReturn(trandata, creds);
                const orderRef = asString(payload.trackId) ||
                    asString(payload.trackid) ||
                    asString(payload.udf1);
                if (orderRef) {
                    const snap = await (0, storePaths_1.pendingPaymentRef)(orderRef).get();
                    if (snap.exists && ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.storeId) === storeId) {
                        await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, orderRef);
                    }
                    target = `${target}?ref=${encodeURIComponent(orderRef)}`;
                }
            }
        }
        catch (error) {
            console.error("[neoleap] فشل معالجة العودة:", (0, gatewayHttp_1.describeGatewayError)(error));
        }
        if (req.method === "POST") {
            // صيغة Tranportal: الجسم نفسه يحمل الوجهة.
            res.status(200).send(`REDIRECT=${target}`);
            return;
        }
        res.redirect(302, target);
    });
    // ==================== المسح الدوري ====================
    //
    // هذا هو الضمان، وليس الـ webhook: MIS Pay تُرسل مرة واحدة بلا إعادة
    // محاولة، و Madfu لا توثّق سياسة إعادة. أي دفعة نجحت وضاع إشعارها تُصالَح
    // هنا خلال خمس دقائق.
    const paymentReconcileSweep = functions.pubsub
        .schedule("every 5 minutes")
        .onRun(async () => {
        const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
        const snap = await (0, storePaths_1.pendingPaymentsCol)()
            .where("status", "==", "CREATED")
            .where("createdAt", ">", cutoff)
            .limit(200)
            .get();
        let reconciled = 0;
        let expired = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            const storeId = String(data.storeId || "");
            if (!storeId)
                continue;
            const expiresAt = data.expiresAt;
            if (expiresAt && expiresAt.toMillis() < Date.now()) {
                // منتهية الصلاحية، لكن نستعلم مرة أخيرة: قد يكون الدفع تمّ فعلاً.
                try {
                    const result = await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, doc.id);
                    if (result.state === "paid") {
                        reconciled += 1;
                        continue;
                    }
                }
                catch (error) {
                    console.error(`[sweep] ${doc.id}:`, (0, gatewayHttp_1.describeGatewayError)(error));
                }
                await (0, paymentReconcile_1.expirePendingPayment)(doc.id);
                expired += 1;
                continue;
            }
            try {
                const result = await (0, paymentReconcile_1.reconcileGatewayPayment)(storeId, doc.id);
                if (result.state === "paid")
                    reconciled += 1;
            }
            catch (error) {
                console.error(`[sweep] ${doc.id}:`, (0, gatewayHttp_1.describeGatewayError)(error));
            }
        }
        console.log(`[sweep] فُحصت ${snap.size} دفعة معلّقة: ${reconciled} مُصالَحة، ${expired} منتهية`);
        return null;
    });
    return {
        paymentGatewaySaveSettings,
        paymentGatewayTestConnection,
        paymentGatewayGetStatus,
        paymentGatewaySetEnabled,
        paymentGatewayCreateCheckout,
        paymentGatewayResolveReturn,
        mispayReturn,
        mispayWebhook,
        madfuWebhook,
        neoleapReturn,
        paymentReconcileSweep,
    };
}
//# sourceMappingURL=paymentGatewayApi.js.map