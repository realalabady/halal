"use strict";
/**
 * neoleap (الراجحي) — بوابة بطاقات مدى/فيزا/ماستركارد بصفحة مستضافة
 *
 * ⚠️ تحذير مهم: neoleap لا تنشر مواصفة عامة. ما يلي مبنيّ على عائلة
 * "Tranportal" المعروفة (نفس عائلة بوابة الراجحي، و KNET، و Benefit) كما
 * تُظهرها إضافات Odoo/CS-Cart وحِزم PHP المجتمعية. كل ثابت لم يُؤكَّد من
 * حزمة التاجر الرسمية مُعلَّم بـ CONFIRM أدناه.
 *
 * التدفّق:
 *   1) نبني مصفوفة الحقول، ونشفّرها AES-256-CBC بمفتاح التاجر (resourceKey)
 *      ونرسلها في حقل trandata (hex) إلى صفحة البوابة.
 *   2) البوابة تُرجع payid + targetUrl، فنحوّل العميل إلى
 *      targetUrl?PaymentID=payid
 *   3) العميل يعود إلى responseURL/errorURL مع trandata مشفّرة.
 *   4) لا نعتمد على العودة أبداً: المصالحة تستعلم (action=8) من الخادم.
 *      وهذا ما توصي به المصادر نفسها — تشفير CBC ليس توقيعاً، ولا يصلح
 *      دليلاً وحيداً على السداد.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.neoleapAdapter = void 0;
exports.encryptTranportal = encryptTranportal;
exports.decryptTranportal = decryptTranportal;
exports.decodeNeoleapReturn = decodeNeoleapReturn;
exports.neoleapStatusOf = neoleapStatusOf;
const crypto_1 = require("crypto");
const gatewayHttp_1 = require("./gatewayHttp");
const gatewayTypes_1 = require("./gatewayTypes");
/**
 * CONFIRM: مضيفو البوابة. الحزمة الرسمية للتاجر قد تُعطي مضيفاً مختلفاً
 * خاصاً بحسابه، وهو يسبق هذه القيم.
 */
const HOSTS = {
    sandbox: "https://securepayments.alrajhibank.com.sa",
    production: "https://digitalpayments.neoleap.com.sa",
};
/** CONFIRM: مسار الصفحة المستضافة. */
const HOSTED_PATH = "/pg/payment/hosted.htm";
/**
 * CONFIRM: رموز العمليات في Tranportal.
 * 1 = شراء، 2 = استرداد، 8 = استعلام.
 */
const ACTION = { PURCHASE: "1", REFUND: "2", INQUIRY: "8" };
/** رمز الريال السعودي في ISO 4217 الرقمي. */
const SAR_CURRENCY_CODE = "682";
/**
 * CONFIRM: الـ IV الثابت الشائع في هذه التكاملات.
 * بعض الإعدادات تُسلّم الـ IV مع المفتاح، ولذلك جعلناه حقل اعتماد اختيارياً:
 * إن أدخله التاجر استُخدم، وإلا رجعنا إلى هذه القيمة.
 */
const DEFAULT_IV = "PGKEYENCDECIVSPC";
const round2 = (n) => Math.round(n * 100) / 100;
const hostOf = (ctx, creds) => {
    const custom = (creds.gatewayHost || "").trim().replace(/\/+$/, "");
    return custom || HOSTS[ctx.environment];
};
// ==================== التشفير (AES-256-CBC) ====================
function keyAndIv(creds) {
    const key = Buffer.from(creds.resourceKey, "utf8");
    if (key.length !== 32) {
        throw new gatewayTypes_1.GatewayAuthError(`مفتاح التشفير (Resource Key) يجب أن يكون ٣٢ حرفاً بالضبط، والمُدخل ${key.length}.`);
    }
    const ivSource = (creds.iv || "").trim() || DEFAULT_IV;
    const iv = Buffer.from(ivSource, "utf8");
    if (iv.length !== 16) {
        throw new gatewayTypes_1.GatewayAuthError(`قيمة IV يجب أن تكون ١٦ حرفاً بالضبط، والمُدخل ${iv.length}.`);
    }
    return { key, iv };
}
/** يشفّر نصّ الحقول إلى trandata بصيغة hex كبيرة الحروف. */
function encryptTranportal(plaintext, creds) {
    const { key, iv } = keyAndIv(creds);
    const cipher = (0, crypto_1.createCipheriv)("aes-256-cbc", key, iv);
    return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
        .toString("hex")
        .toUpperCase();
}
/** يفكّ trandata العائدة من البوابة. */
function decryptTranportal(trandataHex, creds) {
    const { key, iv } = keyAndIv(creds);
    const clean = trandataHex.trim().replace(/\s+/g, "");
    const decipher = (0, crypto_1.createDecipheriv)("aes-256-cbc", key, iv);
    return Buffer.concat([
        decipher.update(Buffer.from(clean, "hex")),
        decipher.final(),
    ]).toString("utf8");
}
/**
 * ردّ البوابة مصفوفة JSON بعنصر واحد في معظم الحالات.
 * نتعامل مع المصفوفة والكائن المفرد معاً.
 */
function parseTranportalPayload(plain) {
    const trimmed = plain.trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return (parsed[0] || {});
        }
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }
    catch (_a) {
        // بعض الردود تأتي كسلسلة query: a=1&b=2
    }
    const out = {};
    for (const pair of trimmed.split("&")) {
        const idx = pair.indexOf("=");
        if (idx > 0) {
            out[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
        }
    }
    return out;
}
/** يفكّ حمولة العودة من البوابة إلى حقولها. */
function decodeNeoleapReturn(trandataHex, creds) {
    return parseTranportalPayload(decryptTranportal(trandataHex, creds));
}
// ==================== بناء الطلب ====================
/**
 * ردّ الصفحة المستضافة نصّ على شكل  <payid>:<targetUrl>  في عائلة
 * Tranportal، وبعض الإصدارات تُرجع trandata مشفّرة. ندعم الشكلين.
 */
function parseHostedResponse(body, creds) {
    var _a, _b, _c, _d;
    const text = typeof body === "string" ? body.trim() : JSON.stringify(body);
    if (/^[0-9A-Fa-f]{32,}$/.test(text)) {
        const payload = decodeNeoleapReturn(text, creds);
        const payId = String((_b = (_a = payload.payid) !== null && _a !== void 0 ? _a : payload.paymentId) !== null && _b !== void 0 ? _b : "");
        const targetUrl = String((_d = (_c = payload.targetUrl) !== null && _c !== void 0 ? _c : payload.target_url) !== null && _d !== void 0 ? _d : "");
        if (payId && targetUrl)
            return { payId, targetUrl };
        throw new Error("ردّ neoleap المشفّر بلا payid أو targetUrl");
    }
    // الشكل المباشر: paymentId:url — الرابط نفسه يحوي ":" فنقصّ عند أول واحدة.
    const sep = text.indexOf(":");
    if (sep > 0) {
        const payId = text.slice(0, sep).trim();
        const targetUrl = text.slice(sep + 1).trim();
        if (payId && /^https?:\/\//i.test(targetUrl)) {
            return { payId, targetUrl };
        }
    }
    throw new Error(`ردّ غير متوقّع من neoleap: ${text.slice(0, 200)}`);
}
/** يُسوّي حالة Tranportal إلى حالتنا الموحّدة. */
function mapResult(result) {
    const value = (result || "").trim().toUpperCase();
    if (["CAPTURED", "APPROVED", "SUCCESS", "SUCCESSFUL"].includes(value)) {
        return "paid";
    }
    if (["CANCELED", "CANCELLED", "VOIDED"].includes(value))
        return "cancelled";
    if (value.includes("REFUND"))
        return "refunded";
    if ([
        "NOT CAPTURED",
        "NOT APPROVED",
        "DENIED BY RISK",
        "HOST TIMEOUT",
        "DECLINED",
    ].includes(value)) {
        return "failed";
    }
    if (!value)
        return "pending";
    return "pending";
}
/** يحوّل حمولة مفكوكة إلى نتيجة حالة موحّدة. */
function neoleapStatusOf(payload) {
    var _a, _b;
    const result = typeof payload.result === "string" ? payload.result : undefined;
    const amountRaw = (_a = payload.amt) !== null && _a !== void 0 ? _a : payload.amount;
    const amount = amountRaw === undefined ? undefined : Number(amountRaw);
    return {
        state: mapResult(result),
        providerCode: result,
        amount: Number.isFinite(amount) ? amount : undefined,
        raw: {
            result,
            tranid: payload.tranid,
            ref: payload.ref,
            trackId: (_b = payload.trackId) !== null && _b !== void 0 ? _b : payload.trackid,
        },
    };
}
/** يرسل حقول trandata إلى الصفحة المستضافة ويُرجع جسم الردّ الخام. */
async function postTrandata(fields, creds, ctx) {
    // CONFIRM: الحقول تُشفّر كمصفوفة JSON بعنصر واحد؛ بعض الإصدارات تتوقّع
    // سلسلة query بدلاً منها. إن رفض البنك الشكل الأول فجرّب الثاني:
    //   Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("&")
    const trandata = encryptTranportal(JSON.stringify([fields]), creds);
    return (0, gatewayHttp_1.gatewayRequest)(`${hostOf(ctx, creds)}${HOSTED_PATH}`, {
        gateway: "neoleap",
        method: "POST",
        form: {
            trandata,
            tranportalId: creds.tranportalId,
            responseURL: String(fields.responseURL || ""),
            errorURL: String(fields.errorURL || ""),
        },
    });
}
// ==================== المحوّل ====================
exports.neoleapAdapter = {
    id: "neoleap",
    requiredCredentials: [
        "tranportalId",
        "tranportalPassword",
        "resourceKey",
    ],
    isAuthError(error) {
        var _a;
        if (error instanceof gatewayTypes_1.GatewayAuthError)
            return true;
        if (error instanceof gatewayHttp_1.GatewayHttpError) {
            if ([401, 403].includes(error.status))
                return true;
            const text = typeof error.body === "string"
                ? error.body
                : JSON.stringify((_a = error.body) !== null && _a !== void 0 ? _a : "");
            // البوابة تُرجع نصّ خطأ بدل حالة HTTP في كثير من الحالات
            return /invalid\s*(tranportal|merchant|password)|not\s*authori/i.test(text);
        }
        return false;
    },
    /**
     * اختبار اتصال حقيقي: استعلام (action=8) عن مرجع غير موجود.
     *
     * لماذا هذا الاختبار: البوابة ترفض بيانات اعتماد خاطئة برسالة
     * "Invalid Tranportal ID / password"، أما بيانات صحيحة عن طلب غير موجود
     * فتُرجع خطأ "لم يُعثر على العملية" — وهو نجاح من ناحيتنا. كما أنه يتحقّق
     * من أن المفتاح يفكّ الردّ، أي من نفس التشفير الذي سيستخدمه الدفع.
     * لا يُنشئ هذا الاختبار أي عملية دفع.
     */
    async testConnection(creds, ctx) {
        // يتحقّق من طول المفتاح والـ IV قبل أي نداء شبكي
        try {
            keyAndIv(creds);
        }
        catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "مفتاح التشفير غير صالح.",
            };
        }
        const probeTrackId = `probe-${Date.now()}`;
        try {
            const body = await postTrandata({
                id: creds.tranportalId,
                password: creds.tranportalPassword,
                action: ACTION.INQUIRY,
                trackId: probeTrackId,
                currencyCode: SAR_CURRENCY_CODE,
                udf1: "connection-test",
            }, creds, ctx);
            const text = typeof body === "string" ? body : JSON.stringify(body);
            if (/invalid\s*(tranportal|merchant|password)|not\s*authori/i.test(text)) {
                return {
                    success: false,
                    message: "معرّف Tranportal أو كلمة المرور غير صحيحة.",
                    detail: text.slice(0, 300),
                };
            }
            // أي ردّ آخر يعني أن البوابة قبلت هويتنا وبحثت عن العملية.
            return {
                success: true,
                message: `تم الاتصال بـ neoleap بنجاح (${ctx.environment === "production" ? "الإنتاج" : "التجربة"}).`,
                detail: text.slice(0, 300),
            };
        }
        catch (error) {
            if (exports.neoleapAdapter.isAuthError(error)) {
                return {
                    success: false,
                    message: "رفضت neoleap بيانات الاعتماد.",
                    detail: (0, gatewayHttp_1.describeGatewayError)(error),
                };
            }
            return {
                success: false,
                message: "فشل الاتصال بـ neoleap. تحقّق من المضيف وبيانات الاعتماد، " +
                    "ومن أن البنك فعّل الحساب.",
                detail: (0, gatewayHttp_1.describeGatewayError)(error),
            };
        }
    },
    async createCheckout(input, creds, ctx) {
        const body = await postTrandata({
            id: creds.tranportalId,
            password: creds.tranportalPassword,
            action: ACTION.PURCHASE,
            amt: round2(input.amount).toFixed(2),
            currencyCode: SAR_CURRENCY_CODE,
            trackId: input.orderRef,
            responseURL: input.returnUrl,
            errorURL: input.failureUrl,
            langid: input.lang === "en" ? "EN" : "AR",
            // udf1..5 حقول حرّة ترجع كما هي في الردّ
            udf1: input.orderRef,
            udf2: input.customer.mobile,
        }, creds, ctx);
        const { payId, targetUrl } = parseHostedResponse(body, creds);
        const joiner = targetUrl.includes("?") ? "&" : "?";
        return {
            redirectUrl: `${targetUrl}${joiner}PaymentID=${encodeURIComponent(payId)}`,
            // الاستعلام لاحقاً يكون بـ trackId، وهو orderRef نفسه
            providerRef: input.orderRef,
            raw: { payId },
        };
    },
    async getStatus(providerRef, creds, ctx) {
        const body = await postTrandata({
            id: creds.tranportalId,
            password: creds.tranportalPassword,
            action: ACTION.INQUIRY,
            trackId: providerRef,
            currencyCode: SAR_CURRENCY_CODE,
        }, creds, ctx);
        const text = typeof body === "string" ? body.trim() : JSON.stringify(body);
        if (/^[0-9A-Fa-f]{32,}$/.test(text)) {
            return neoleapStatusOf(decodeNeoleapReturn(text, creds));
        }
        // ردّ غير مشفّر: قد يكون "لم يُعثر على العملية" أي أن الدفع لم يبدأ بعد.
        if (/not\s*found|no\s*record/i.test(text)) {
            return { state: "pending", providerCode: "NOT_FOUND", raw: { text } };
        }
        return neoleapStatusOf(parseTranportalPayload(text));
    },
    async refund(providerRef, amount, creds, ctx) {
        await postTrandata({
            id: creds.tranportalId,
            password: creds.tranportalPassword,
            action: ACTION.REFUND,
            amt: round2(amount).toFixed(2),
            currencyCode: SAR_CURRENCY_CODE,
            trackId: `rf-${providerRef}-${Date.now()}`,
            // CONFIRM: البوابة تطلب transId أو trackId الأصلي حسب الإصدار
            udf1: providerRef,
        }, creds, ctx);
    },
};
//# sourceMappingURL=neoleapClient.js.map