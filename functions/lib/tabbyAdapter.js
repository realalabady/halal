"use strict";
/**
 * Tabby (تابي) كمحوّل في سجل بوابات الدفع.
 *
 * نفس سبب tamaraAdapter.ts: tabbyClient.ts يحفظ المفتاحين في متغيّرين على
 * مستوى الوحدة، وهو خطر تسرّب بين المتاجر في حاوية دافئة. هنا المفاتيح
 * وسيط صريح في كل نداء، والعميل القديم يبقى للدوال القديمة.
 *
 * خصوصية تابي: الدفع يمرّ بـ AUTHORIZED ثم يحتاج capture من التاجر ليصل
 * المال. getStatus هنا تُنفّذ الـ capture عند رؤية AUTHORIZED ثم تُبلّغ
 * "مدفوع"؛ نداء capture ثانٍ يرفضه تابي ونتجاهل الرفض.
 *
 * المفتاح العام يُستخدم لإنشاء الجلسة، والسرّي لكل ما بعدها.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tabbyAdapter = void 0;
const gatewayHttp_1 = require("./gatewayHttp");
const gatewayTypes_1 = require("./gatewayTypes");
// تابي تستخدم نفس المضيف للتجربة والإنتاج؛ البيئة تحدّدها المفاتيح نفسها
// (مفاتيح test مقابل مفاتيح live).
const TABBY_API_URL = "https://api.tabby.ai/api/v2";
const round2 = (n) => Math.round(n * 100) / 100;
const amountStr = (n) => round2(n).toFixed(2);
/** يستخرج رابط الدفع من أيٍّ من المواضع التي تضعه تابي فيها. */
function extractWebUrl(session) {
    var _a, _b, _c, _d, _e;
    const products = (_a = session.configuration) === null || _a === void 0 ? void 0 : _a.available_products;
    return (((_c = (_b = products === null || products === void 0 ? void 0 : products.installments) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.web_url) ||
        ((_e = (_d = products === null || products === void 0 ? void 0 : products.pay_later) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.web_url) ||
        session.web_url ||
        session.checkout_url ||
        "");
}
/**
 * حالات تابي: CREATED / AUTHORIZED / CLOSED / REJECTED / EXPIRED.
 * CLOSED تعني أن الدفع حُصّل بالكامل.
 */
function mapStatus(raw) {
    switch ((raw || "").toUpperCase()) {
        case "CLOSED":
            return "paid";
        case "AUTHORIZED":
            // مُصرَّح ولم يُحصَّل بعد — نتعامل معه في getStatus
            return "pending";
        case "REJECTED":
        case "EXPIRED":
            return "failed";
        case "CREATED":
        default:
            return "pending";
    }
}
/**
 * يتحقّق من الشقّ الذي يُستعمل عند الدفع فعلاً: المفتاح العام مع رمز التاجر.
 *
 * لماذا نداء حقيقي لا تحقّق شكلي: المفتاح السرّي والمفتاح العام يُصادَق
 * عليهما عند نقطتين مختلفتين، وتابي تربط رمز التاجر بالمفتاح العام. اختبار
 * يفحص السرّي وحده ينجح بينما كل عملية دفع ترجع
 * 401 "merchant_code not found for this api key" — وهو بالضبط ما حدث.
 *
 * الجلسة التي قد تُنشأ هنا جلسة تسعير مسبق، لا طلب ولا تحصيل، وتنتهي
 * صلاحيتها وحدها. و400 يعني أن المصادقة مرّت ورُفض محتوى الطلب فقط.
 */
async function probeCheckoutAuth(creds, ctx) {
    var _a;
    const envLabel = ctx.environment === "production" ? "الإنتاج" : "التجربة";
    const merchantCode = (creds.merchantCode || "").trim();
    if (!merchantCode) {
        return {
            success: false,
            message: "رمز التاجر (Merchant Code) ناقص، وتابي ترفض إنشاء جلسة الدفع " +
                "بدونه. تجده في لوحة تابي ضمن بيانات المتجر.",
        };
    }
    try {
        await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/checkout`, {
            gateway: "tabby",
            method: "POST",
            headers: { Authorization: `Bearer ${creds.publicKey}` },
            body: {
                payment: {
                    // مبلغ واقعي: اختبار بمبلغ رمزي يرتدّ بـ under_limit فيُضيف ضجيجاً
                    // لا علاقة له بصحّة المفاتيح.
                    amount: "500.00",
                    currency: "SAR",
                    description: "connection test",
                    buyer: {
                        phone: "0500000000",
                        email: "test@example.com",
                        name: "Connection Test",
                    },
                    order: {
                        reference_id: `conn-test-${Date.now()}`,
                        items: [
                            {
                                title: "connection test",
                                quantity: 1,
                                unit_price: "500.00",
                                reference_id: "conn-test",
                            },
                        ],
                    },
                },
                lang: "ar",
                merchant_code: merchantCode,
                merchant_urls: {
                    success: `${ctx.baseUrl || "https://example.com"}/payment/return/tabby`,
                    cancel: `${ctx.baseUrl || "https://example.com"}/payment/return/tabby`,
                    failure: `${ctx.baseUrl || "https://example.com"}/payment/return/tabby`,
                },
            },
        });
        return {
            success: true,
            message: `تم الاتصال بتابي بنجاح (${envLabel}).`,
            detail: "المفتاح السرّي والمفتاح العام ورمز التاجر كلّها مقبولة",
        };
    }
    catch (error) {
        if (error instanceof gatewayHttp_1.GatewayHttpError) {
            const body = JSON.stringify((_a = error.body) !== null && _a !== void 0 ? _a : "");
            if (error.status === 401 || error.status === 403) {
                if (body.includes("merchant_code")) {
                    return {
                        success: false,
                        message: `رمز التاجر «${merchantCode}» لا يطابق المفتاح العام لدى ` +
                            "تابي. تأكّد أنهما من نفس المتجر ونفس البيئة " +
                            `(${envLabel}).`,
                        detail: (0, gatewayHttp_1.describeGatewayError)(error),
                    };
                }
                return {
                    success: false,
                    message: "المفتاح العام لتابي غير صحيح.",
                    detail: (0, gatewayHttp_1.describeGatewayError)(error),
                };
            }
            // 400 = المصادقة مرّت ورُفض محتوى الطلب التجريبي فقط.
            if (error.status === 400) {
                return {
                    success: true,
                    message: `تم الاتصال بتابي بنجاح (${envLabel}).`,
                    detail: "المصادقة مقبولة؛ رُفض محتوى الطلب التجريبي وهو متوقّع",
                };
            }
        }
        return {
            success: false,
            message: "فشل الاتصال بتابي.",
            detail: (0, gatewayHttp_1.describeGatewayError)(error),
        };
    }
}
exports.tabbyAdapter = {
    id: "tabby",
    // merchantCode مطلوب وليس اختيارياً: تابي ترفض POST /checkout بـ 401
    // "merchant_code not found for this api key" حين يغيب. كان معلّماً
    // اختيارياً، فكان اختبار الاتصال ينجح بينما الدفع مستحيل.
    requiredCredentials: ["publicKey", "secretKey", "merchantCode"],
    isAuthError(error) {
        if (error instanceof gatewayTypes_1.GatewayAuthError)
            return true;
        return (error instanceof gatewayHttp_1.GatewayHttpError && [401, 403].includes(error.status));
    },
    /**
     * اختبار حقيقي بلا أثر جانبي: استعلام عن دفعة غير موجودة بالمفتاح السرّي.
     * مفتاح خاطئ ⇒ 401، ومفتاح صحيح ⇒ 404 (لا توجد هذه الدفعة) وهو نجاح
     * من ناحيتنا. لا يُنشئ جلسة ولا طلباً.
     *
     * هذا يستبدل tabbyTestConnection القديمة التي كانت تُرجع النجاح دائماً
     * دون أي نداء شبكي.
     */
    async testConnection(creds, ctx) {
        try {
            await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/payments/00000000-0000-0000-0000-000000000000`, {
                gateway: "tabby",
                method: "GET",
                headers: { Authorization: `Bearer ${creds.secretKey}` },
            });
            // ردّ ناجح غير متوقّع، لكنه يعني أن المصادقة تمّت
            return probeCheckoutAuth(creds, ctx);
        }
        catch (error) {
            if (error instanceof gatewayHttp_1.GatewayHttpError) {
                if (error.status === 404) {
                    // المفتاح السرّي سليم. يبقى الشقّ الآخر: المفتاح العام مع رمز
                    // التاجر، وهو ما يُستعمل فعلاً عند الدفع.
                    return probeCheckoutAuth(creds, ctx);
                }
                if ([401, 403].includes(error.status)) {
                    return {
                        success: false,
                        message: "المفتاح السرّي لتابي غير صحيح.",
                        detail: (0, gatewayHttp_1.describeGatewayError)(error),
                    };
                }
            }
            return {
                success: false,
                message: "فشل الاتصال بتابي.",
                detail: (0, gatewayHttp_1.describeGatewayError)(error),
            };
        }
    },
    async createCheckout(input, creds) {
        var _a;
        const [firstName, ...restName] = input.customer.name.split(" ");
        const lastName = restName.join(" ") || firstName;
        const body = {
            payment: {
                amount: amountStr(input.amount),
                currency: input.currency,
                description: `طلب ${input.orderRef}`,
                buyer: {
                    phone: input.customer.mobile,
                    email: input.customer.email,
                    name: input.customer.name,
                },
                // العنوان مطلوب حتى مع الاستلام من الفرع، فيُملأ بعنوان المتجر.
                shipping_address: {
                    city: input.address.city,
                    address: [input.address.street, input.address.building]
                        .filter(Boolean)
                        .join(" "),
                    zip: "",
                },
                order: {
                    tax_amount: amountStr(input.vat),
                    shipping_amount: amountStr(input.shippingAmount),
                    discount_amount: "0.00",
                    reference_id: input.orderRef,
                    items: input.items.map((item) => ({
                        title: item.name,
                        quantity: item.quantity,
                        unit_price: amountStr(item.unitPrice),
                        reference_id: item.productId,
                        image_url: item.image || undefined,
                    })),
                },
                buyer_history: {
                    registered_since: new Date().toISOString(),
                    loyalty_level: 0,
                },
            },
            lang: input.lang === "en" ? "en" : "ar",
            merchant_code: creds.merchantCode || undefined,
            merchant_urls: {
                success: input.returnUrl,
                cancel: input.cancelUrl,
                failure: input.failureUrl,
            },
        };
        const session = await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/checkout`, {
            gateway: "tabby",
            method: "POST",
            headers: { Authorization: `Bearer ${creds.publicKey}` },
            body,
        });
        // تابي ترفض بعض المشترين مسبقاً (scoring) وتعيد 200 مع status=rejected.
        if ((session.status || "").toLowerCase() === "rejected") {
            // سبب الرفض يأتي من تابي نفسها: under_limit يعني أن السلة
            // أقل من حدّ التاجر، وهو شيء يستطيع المشتري إصلاحه.
            const reason = (session.rejection_reason_code || "").toLowerCase();
            throw new gatewayTypes_1.GatewayDeclinedError(reason === "under_limit"
                ? "مبلغ السلة أقل من الحدّ الأدنى للدفع عبر تابي. أضف منتجات " +
                    "أو اختر طريقة دفع أخرى."
                : "تابي لم تعتمد هذه العملية لهذا المشتري. اختر طريقة دفع أخرى.");
        }
        const url = extractWebUrl(session);
        const paymentId = ((_a = session.payment) === null || _a === void 0 ? void 0 : _a.id) || session.id;
        if (!url || !paymentId) {
            throw new Error("تابي لم تُرجع رابط الدفع أو معرّف الدفعة");
        }
        return { redirectUrl: url, providerRef: paymentId };
    },
    async getStatus(providerRef, creds) {
        var _a, _b;
        const payment = await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/payments/${encodeURIComponent(providerRef)}`, {
            gateway: "tabby",
            method: "GET",
            headers: { Authorization: `Bearer ${creds.secretKey}` },
        });
        const raw = payment === null || payment === void 0 ? void 0 : payment.status;
        const amount = (payment === null || payment === void 0 ? void 0 : payment.amount) === undefined ? undefined : Number(payment.amount);
        let state = mapStatus(raw);
        // AUTHORIZED يعني أن تابي ضمنت المبلغ ولم يُحصَّل بعد. بدون capture
        // لا يصل المال إلى المتجر.
        if ((raw || "").toUpperCase() === "AUTHORIZED") {
            try {
                await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/payments/${encodeURIComponent(providerRef)}/captures`, {
                    gateway: "tabby",
                    method: "POST",
                    headers: { Authorization: `Bearer ${creds.secretKey}` },
                    body: { amount: (_a = payment === null || payment === void 0 ? void 0 : payment.amount) !== null && _a !== void 0 ? _a : amountStr(amount || 0) },
                });
                state = "paid";
            }
            catch (error) {
                // تحصيل مكرّر من نداء متزامن: الدفعة محصّلة أصلاً.
                if (error instanceof gatewayHttp_1.GatewayHttpError &&
                    [409, 400].includes(error.status)) {
                    state = "paid";
                }
                else {
                    console.error("[tabby] فشل تحصيل الدفعة:", (0, gatewayHttp_1.describeGatewayError)(error));
                    return { state: "pending", providerCode: raw };
                }
            }
        }
        return {
            state,
            providerCode: raw,
            amount: Number.isFinite(amount) ? amount : undefined,
            raw: { status: raw, reference_id: (_b = payment === null || payment === void 0 ? void 0 : payment.order) === null || _b === void 0 ? void 0 : _b.reference_id },
        };
    },
    async refund(providerRef, amount, creds) {
        await (0, gatewayHttp_1.gatewayRequest)(`${TABBY_API_URL}/payments/${encodeURIComponent(providerRef)}/refunds`, {
            gateway: "tabby",
            method: "POST",
            headers: { Authorization: `Bearer ${creds.secretKey}` },
            body: { amount: amountStr(amount) },
        });
    },
};
//# sourceMappingURL=tabbyAdapter.js.map