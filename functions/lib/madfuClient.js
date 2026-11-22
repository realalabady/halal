"use strict";
/**
 * Madfu (مدفوع) — اشتر الآن وادفع لاحقاً
 * https://madfuapis.readme.io/reference/inittoken
 *
 * تدفّق الدفع على ثلاث خطوات، وهو ما يميّزه عن بقية البوابات:
 *   1) POST {api}/merchants/token/init   → رمز ابتدائي (من apiKey+appCode+Basic)
 *   2) POST {api}/Merchants/sign-in      → رمز الجلسة (من userName+password)
 *   3) POST {checkout}/Merchants/Checkout/CreateOrder → checkoutLink
 *      ثم GET {api}/Merchants/Order/OrderGet_OnlinePayment للحالة المعتمدة.
 *
 * ملاحظتان من الوثائق نفسها:
 *  - الـ webhook غير موقّع (لا توقيع ولا HMAC، فقط IP whitelisting)، فلا
 *    نثق بحمولته ونعيد السؤال دائماً عبر استعلام الحالة.
 *  - مستند الـ API يخلط حالة الأحرف (APIKey مقابل apikey، Order مقابل order).
 *    ASP.NET يربط JSON بلا حساسية لحالة الأحرف، فنستخدم شكل المخطّط الرسمي.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.madfuAdapter = exports.madfuWebhookStateOf = exports.MADFU_STATUS_CODES = void 0;
exports.clearMadfuTokenCache = clearMadfuTokenCache;
// FieldValue/Timestamp تُستورد مباشرة من firebase-admin/firestore بدل
// admin.firestore.* : الشكل الثاني يعتمد على خصائص ساكنة على دالة،
// وهي تختفي تحت غلاف محاكي الدوال فتفشل الكتابة محلياً. الاستيراد
// المباشر هو الشكل الموصى به ويعمل في البيئتين بلا فرق.
const firestore_1 = require("firebase-admin/firestore");
const crypto_1 = require("crypto");
const storePaths_1 = require("./storePaths");
const gatewayHttp_1 = require("./gatewayHttp");
const gatewayTypes_1 = require("./gatewayTypes");
const API_HOSTS = {
    sandbox: "https://api.staging.madfu.com.sa",
    production: "https://api.madfu.com.sa",
};
/** مضيف صفحة الدفع — مختلف عن مضيف الـ API. */
const CHECKOUT_HOSTS = {
    sandbox: "https://checkout-staging.madfu.com.sa",
    production: "https://checkout.madfu.com.sa",
};
/**
 * رموز حالة الطلب في Madfu.
 * الـ webhook لا يُرسل إلا 124 و125 و135 و136.
 */
exports.MADFU_STATUS_CODES = {
    PENDING: "124",
    PAID: "125",
    TIMED_OUT: "135",
    EXPIRED: "136",
    REFUNDED: "140",
    REFUND_REQUESTED: "141",
    PARTIAL_REFUND: "142",
    REFUND_REJECTED: "143",
    NOT_FOUND: "404",
};
const apiBase = (ctx) => API_HOSTS[ctx.environment];
const checkoutBase = (ctx) => CHECKOUT_HOSTS[ctx.environment];
const round2 = (n) => Math.round(n * 100) / 100;
/** الترويسات الثابتة التي يطلبها كل نداء. */
function baseHeaders(creds) {
    return {
        apikey: creds.apiKey,
        appcode: creds.appCode,
        platformTypeId: creds.platformTypeId || "5",
        Authorization: `Basic ${creds.basicToken}`,
    };
}
// ==================== سلسلة الرموز ====================
//
// مدّة صلاحية رمز الجلسة غير موثّقة. نخزّنه في مستند المتجر مع صلاحية
// محافظة (٢٠ دقيقة)، ونعيد المصادقة تلقائياً عند 401 — فلا يفشل دفع بسبب
// تقدير خاطئ للمدّة. التخزين في Firestore لا في الذاكرة: الدوال تُنشر مرة
// واحدة لكل المتاجر.
const SESSION_TTL_MS = 20 * 60 * 1000;
const hashKey = (value) => (0, crypto_1.createHash)("sha256").update(value).digest("hex").slice(0, 16);
async function readCachedSession(ctx, creds) {
    var _a;
    const snap = await (0, storePaths_1.settingsRef)(ctx.storeId, "madfu").get();
    const cache = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.tokenCache;
    if (!(cache === null || cache === void 0 ? void 0 : cache.sessionToken))
        return null;
    if (cache.environment !== ctx.environment)
        return null;
    if (cache.apiKeyHash !== hashKey(creds.apiKey))
        return null;
    if (!(cache.expiresAt > Date.now() + 60000))
        return null;
    return cache.sessionToken;
}
async function writeCachedSession(ctx, creds, sessionToken) {
    const cache = {
        sessionToken,
        expiresAt: Date.now() + SESSION_TTL_MS,
        environment: ctx.environment,
        apiKeyHash: hashKey(creds.apiKey),
    };
    await (0, storePaths_1.settingsRef)(ctx.storeId, "madfu").set({ tokenCache: cache }, { merge: true });
}
/** الخطوة ١: رمز ابتدائي من apiKey + appCode + Basic. */
async function initToken(creds, ctx) {
    const response = await (0, gatewayHttp_1.gatewayRequest)(`${apiBase(ctx)}/merchants/token/init`, {
        gateway: "madfu",
        method: "POST",
        headers: baseHeaders(creds),
        body: { uuid: (0, crypto_1.randomUUID)(), systemInfo: "web" },
    });
    const token = response === null || response === void 0 ? void 0 : response.token;
    if (!token) {
        throw new gatewayTypes_1.GatewayAuthError("Madfu لم يُرجع الرمز الابتدائي. تحقّق من apiKey و appCode ورمز Basic.");
    }
    return token;
}
/** الخطوة ٢: تسجيل الدخول برمز ابتدائي + بريد وكلمة مرور التاجر. */
async function signIn(creds, ctx, initial) {
    const response = await (0, gatewayHttp_1.gatewayRequest)(`${apiBase(ctx)}/Merchants/sign-in`, {
        gateway: "madfu",
        method: "POST",
        // الوثائق: الرمز يُرسل في ترويسة Token بدون البادئة Bearer
        headers: { ...baseHeaders(creds), Token: initial },
        body: { userName: creds.userName, password: creds.password },
    });
    const token = response === null || response === void 0 ? void 0 : response.token;
    if (!token) {
        throw new gatewayTypes_1.GatewayAuthError("فشل تسجيل الدخول إلى Madfu. تحقّق من البريد وكلمة المرور.");
    }
    return { token, merchant: response.merchantData || {} };
}
/** رمز جلسة صالح: من المخزن إن أمكن، وإلا init + sign-in. */
async function getSessionToken(creds, ctx, forceRefresh = false) {
    if (!forceRefresh) {
        const cached = await readCachedSession(ctx, creds);
        if (cached)
            return cached;
    }
    const initial = await initToken(creds, ctx);
    const { token } = await signIn(creds, ctx, initial);
    await writeCachedSession(ctx, creds, token);
    return token;
}
/**
 * ينفّذ نداءً مُصادقاً، ويعيد المحاولة مرة واحدة برمز جديد على 401.
 * السبب: مدّة صلاحية الرمز غير موثّقة، فالفشل بسببها متوقّع.
 */
async function authedRequest(creds, ctx, url, options) {
    const call = async (token) => (0, gatewayHttp_1.gatewayRequest)(url, {
        gateway: "madfu",
        method: options.method || "GET",
        headers: { ...baseHeaders(creds), Token: token },
        body: options.body,
    });
    try {
        return await call(await getSessionToken(creds, ctx));
    }
    catch (error) {
        if (error instanceof gatewayHttp_1.GatewayHttpError && error.status === 401) {
            return call(await getSessionToken(creds, ctx, true));
        }
        throw error;
    }
}
/** يحوّل حالة Madfu إلى حالتنا الموحّدة. */
function mapOrderStatus(orderStatus, statusCode) {
    const byName = (orderStatus || "").toLowerCase();
    if (byName === "paid")
        return "paid";
    if (byName === "pending")
        return "pending";
    if (byName === "timedout" || byName === "timed out")
        return "failed";
    if (byName === "expired")
        return "failed";
    if (byName === "ordernotfound")
        return "failed";
    switch (statusCode) {
        case exports.MADFU_STATUS_CODES.PAID:
            return "paid";
        case exports.MADFU_STATUS_CODES.PENDING:
            return "pending";
        case exports.MADFU_STATUS_CODES.REFUNDED:
        case exports.MADFU_STATUS_CODES.PARTIAL_REFUND:
            return "refunded";
        case exports.MADFU_STATUS_CODES.TIMED_OUT:
        case exports.MADFU_STATUS_CODES.EXPIRED:
        case exports.MADFU_STATUS_CODES.NOT_FOUND:
            return "failed";
        default:
            return "pending";
    }
}
/** يترجم رمز حالة الـ webhook إلى حالتنا (للسجلّ فقط — المصالحة تستعلم). */
const madfuWebhookStateOf = (orderStatus) => mapOrderStatus(undefined, String(orderStatus !== null && orderStatus !== void 0 ? orderStatus : ""));
exports.madfuWebhookStateOf = madfuWebhookStateOf;
exports.madfuAdapter = {
    id: "madfu",
    requiredCredentials: [
        "apiKey",
        "appCode",
        "basicToken",
        "userName",
        "password",
    ],
    isAuthError(error) {
        if (error instanceof gatewayTypes_1.GatewayAuthError)
            return true;
        return (error instanceof gatewayHttp_1.GatewayHttpError && [401, 403].includes(error.status));
    },
    /**
     * اختبار اتصال حقيقي: init + sign-in. ينجح فقط إذا كانت كل بيانات
     * الاعتماد الست صحيحة، وهي نفس السلسلة التي يستخدمها الدفع.
     */
    async testConnection(creds, ctx) {
        var _a;
        try {
            const initial = await initToken(creds, ctx);
            const { token, merchant } = await signIn(creds, ctx, initial);
            await writeCachedSession(ctx, creds, token);
            const name = merchant.merchantName || merchant.merchantCode || "";
            return {
                success: true,
                message: name
                    ? `تم الاتصال بـ Madfu بنجاح — التاجر: ${name}`
                    : "تم الاتصال بـ Madfu بنجاح.",
                detail: `merchantId=${(_a = merchant.merchantid) !== null && _a !== void 0 ? _a : "?"}`,
            };
        }
        catch (error) {
            const status = error instanceof gatewayHttp_1.GatewayHttpError ? error.status : undefined;
            const arabic = status === 401
                ? "بيانات الدخول إلى Madfu غير صحيحة."
                : status === 403
                    ? "حساب التاجر غير متاح في Madfu."
                    : "فشل الاتصال بـ Madfu.";
            return {
                success: false,
                message: arabic,
                detail: (0, gatewayHttp_1.describeGatewayError)(error),
            };
        }
    },
    async createCheckout(input, creds, ctx) {
        // المخطّط يعلن Amount كـ int32 بينما الوصف يقول double. نرسل رقماً
        // بمنزلتين عشريتين؛ إن رفضه الـ sandbox فالحقل صحيح أنه عدد صحيح
        // وتحتاج هذه السطور تقريباً إلى أقرب ريال — أكّدها على البيئة التجريبية.
        const body = {
            Order: {
                Taxes: round2(input.vat),
                ActualValue: round2(input.subtotal),
                Amount: round2(input.amount),
                MerchantReference: input.orderRef,
            },
            OrderDetails: input.items.map((item) => ({
                productName: item.name,
                SKU: item.productId,
                productImage: item.image || "",
                count: item.quantity,
                totalAmount: round2(item.unitPrice * item.quantity),
            })),
            GuestOrderData: {
                CustomerMobile: input.customer.mobile,
                Lang: input.lang === "en" ? "En" : "Ar",
                CustomerName: input.customer.name,
                ShippingAddress: [
                    input.address.street,
                    input.address.building,
                    input.address.district,
                    input.address.city,
                ]
                    .filter(Boolean)
                    .join(", "),
            },
            MerchantUrls: {
                Success: input.returnUrl,
                Failure: input.failureUrl,
                Cancel: input.cancelUrl,
            },
        };
        const response = await authedRequest(creds, ctx, `${checkoutBase(ctx)}/Merchants/Checkout/CreateOrder`, { method: "POST", body });
        const invoiceCode = response === null || response === void 0 ? void 0 : response.invoiceCode;
        const link = response === null || response === void 0 ? void 0 : response.checkoutLink;
        if (!link || !invoiceCode) {
            throw new Error("Madfu لم يُرجع رابط الدفع أو invoiceCode");
        }
        // الرابط في الوثائق مكتوب بقالب {BaseUrl}Payment?token=...؛ إن عاد
        // نسبياً نبنيه على مضيف صفحة الدفع.
        const redirectUrl = /^https?:\/\//i.test(link)
            ? link
            : `${checkoutBase(ctx)}/${link.replace(/^\/+/, "")}`;
        return {
            redirectUrl,
            providerRef: invoiceCode,
            raw: { orderId: response.orderId },
        };
    },
    async getStatus(providerRef, creds, ctx) {
        const url = new URL(`${apiBase(ctx)}/Merchants/Order/OrderGet_OnlinePayment`);
        url.searchParams.set("invoiceCode", providerRef);
        const response = await authedRequest(creds, ctx, url.toString(), { method: "GET" });
        const statusCode = (response === null || response === void 0 ? void 0 : response.statusCode) === undefined ? undefined : String(response.statusCode);
        return {
            state: mapOrderStatus(response === null || response === void 0 ? void 0 : response.order_Status, statusCode),
            providerCode: statusCode || (response === null || response === void 0 ? void 0 : response.order_Status),
            // استعلام الحالة لا يُرجع المبلغ، فلا مطابقة ممكنة من هنا.
            amount: undefined,
            raw: { order_Status: response === null || response === void 0 ? void 0 : response.order_Status, statusCode },
        };
    },
    async refund(providerRef, amount, creds, ctx) {
        await authedRequest(creds, ctx, `${apiBase(ctx)}/api/Refund/Create`, {
            method: "POST",
            body: {
                refundAmount: round2(amount),
                merchantReference: providerRef,
                // رسوم الاسترداد تُحسب من endpoint الرسوم؛ صفر حتى يُحدّد التاجر سياسته.
                refundFees: 0,
                referenceNumber: (0, crypto_1.randomUUID)(),
            },
        });
    },
};
/** يمسح رمز الجلسة المخزّن (عند تغيير بيانات الاعتماد). */
async function clearMadfuTokenCache(storeId) {
    await (0, storePaths_1.settingsRef)(storeId, "madfu").set({ tokenCache: firestore_1.FieldValue.delete() }, { merge: true });
}
//# sourceMappingURL=madfuClient.js.map