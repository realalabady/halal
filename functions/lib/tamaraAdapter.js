"use strict";
/**
 * Tamara (تمارا) كمحوّل في سجل بوابات الدفع.
 *
 * لماذا ملف جديد بدل استعمال tamaraClient.ts:
 * ذلك العميل يحفظ المفتاح في متغيّر على مستوى الوحدة (setApiToken /
 * clearApiToken)، والدوال تُنشر مرة واحدة لكل المتاجر، فحاوية دافئة تنسى
 * إعادة التهيئة تستخدم مفتاح متجر مع متجر آخر. المسار الجديد يأخذ المفتاح
 * وسيطاً صريحاً في كل نداء. العميل القديم يبقى كما هو للدوال القديمة.
 *
 * خصوصية تمارا: الدفع لا يكتمل بمجرد موافقة العميل. الطلب يصبح approved ثم
 * يجب على التاجر استدعاء authorise وإلا انتهت صلاحيته. لذلك getStatus هنا
 * تُصرّح (authorise) عند رؤية approved ثم تُبلّغ "مدفوع" — وهي عملية
 * آمنة للتكرار: تمارا ترفض تصريحاً ثانياً ونتجاهل ذلك الرفض.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tamaraAdapter = void 0;
const gatewayHttp_1 = require("./gatewayHttp");
const gatewayTypes_1 = require("./gatewayTypes");
const HOSTS = {
    sandbox: "https://api-sandbox.tamara.co",
    production: "https://api.tamara.co",
};
const baseUrl = (ctx) => HOSTS[ctx.environment];
const round2 = (n) => Math.round(n * 100) / 100;
const money = (amount, currency) => ({
    amount: round2(amount),
    currency,
});
const authHeaders = (creds) => ({
    Authorization: `Bearer ${creds.apiToken}`,
});
/**
 * حالات تمارا:
 *  new / approved            → العميل وافق، ينقص التصريح
 *  authorised / captured /
 *  fully_captured            → مدفوع
 *  declined / expired        → فاشل
 *  canceled                  → ملغى
 */
function mapStatus(raw) {
    switch ((raw || "").toLowerCase()) {
        case "authorised":
        case "authorized":
        case "captured":
        case "fully_captured":
        case "partially_captured":
            return "paid";
        case "canceled":
        case "cancelled":
            return "cancelled";
        case "declined":
        case "expired":
            return "failed";
        case "refunded":
        case "fully_refunded":
            return "refunded";
        default:
            return "pending";
    }
}
exports.tamaraAdapter = {
    id: "tamara",
    requiredCredentials: ["apiToken"],
    // تمارا تضع حداً أدنى يختلف بالاتفاق التجاري؛ لا نفرض رقماً من عندنا.
    isAuthError(error) {
        if (error instanceof gatewayTypes_1.GatewayAuthError)
            return true;
        return (error instanceof gatewayHttp_1.GatewayHttpError && [401, 403].includes(error.status));
    },
    /**
     * اختبار حقيقي بلا أثر جانبي: استعلام أهلية عميل وهمي. ينجح فقط بمفتاح
     * صالح، ولا يُنشئ طلباً ولا جلسة دفع.
     */
    async testConnection(creds, ctx) {
        try {
            await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/checkout/customer-eligibility`, {
                gateway: "tamara",
                method: "POST",
                headers: authHeaders(creds),
                body: {
                    phone_number: "+966500000000",
                    total_amount: money(100, "SAR"),
                    country_code: "SA",
                },
            });
            return {
                success: true,
                message: `تم الاتصال بتمارا بنجاح (${ctx.environment === "production" ? "الإنتاج" : "التجربة"}).`,
            };
        }
        catch (error) {
            const status = error instanceof gatewayHttp_1.GatewayHttpError ? error.status : undefined;
            return {
                success: false,
                message: status === 401 || status === 403
                    ? "مفتاح تمارا غير صحيح أو غير مفعّل."
                    : "فشل الاتصال بتمارا.",
                detail: (0, gatewayHttp_1.describeGatewayError)(error),
            };
        }
    },
    async createCheckout(input, creds, ctx) {
        const currency = input.currency;
        const [firstName, ...restName] = input.customer.name.split(" ");
        const lastName = restName.join(" ") || firstName;
        const body = {
            order_reference_id: input.orderRef,
            total_amount: money(input.amount, currency),
            description: `طلب ${input.orderRef}`,
            country_code: "SA",
            payment_type: "PAY_BY_INSTALMENTS",
            instalments: 3,
            locale: input.lang === "en" ? "en_US" : "ar_SA",
            items: input.items.map((item) => ({
                reference_id: item.productId,
                type: "physical",
                name: item.name,
                sku: item.productId,
                quantity: item.quantity,
                unit_price: money(item.unitPrice, currency),
                total_amount: money(item.unitPrice * item.quantity, currency),
                image_url: item.image || undefined,
            })),
            consumer: {
                first_name: firstName || input.customer.name,
                last_name: lastName,
                email: input.customer.email,
                phone_number: input.customer.mobile,
            },
            // عنوان الشحن مطلوب حتى في الاستلام من الفرع، فيُملأ بعنوان المتجر.
            shipping_address: {
                first_name: firstName || input.customer.name,
                last_name: lastName,
                line1: input.address.street,
                line2: input.address.building || undefined,
                city: input.address.city,
                country_code: "SA",
                phone_number: input.customer.mobile,
            },
            shipping_amount: money(input.shippingAmount, currency),
            tax_amount: money(input.vat, currency),
            merchant_url: {
                success: input.returnUrl,
                failure: input.failureUrl,
                cancel: input.cancelUrl,
                notification: input.returnUrl,
            },
        };
        const response = await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/checkout`, {
            gateway: "tamara",
            method: "POST",
            headers: authHeaders(creds),
            body,
        });
        const url = response === null || response === void 0 ? void 0 : response.checkout_url;
        const checkoutId = response === null || response === void 0 ? void 0 : response.checkout_id;
        if (!url || !checkoutId) {
            throw new Error("تمارا لم تُرجع رابط الدفع أو checkout_id");
        }
        return { redirectUrl: url, providerRef: checkoutId };
    },
    async getStatus(providerRef, creds, ctx) {
        var _a;
        const details = await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/checkout/${encodeURIComponent(providerRef)}`, { gateway: "tamara", method: "GET", headers: authHeaders(creds) });
        const raw = (details === null || details === void 0 ? void 0 : details.status) || (details === null || details === void 0 ? void 0 : details.payment_status);
        const orderId = details === null || details === void 0 ? void 0 : details.order_id;
        const amountRaw = (_a = details === null || details === void 0 ? void 0 : details.total_amount) === null || _a === void 0 ? void 0 : _a.amount;
        const amount = amountRaw === undefined ? undefined : Number(amountRaw);
        let state = mapStatus(raw);
        // approved يعني أن العميل وافق ولم يُصرَّح بالطلب بعد. بدون التصريح
        // تنتهي صلاحية الطلب ولا يصل المال، فنُصرّح هنا ثم نعتبره مدفوعاً.
        if (state === "pending" && (raw || "").toLowerCase() === "approved") {
            if (!orderId) {
                return { state: "pending", providerCode: raw };
            }
            try {
                await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/orders/${encodeURIComponent(orderId)}/authorise`, {
                    gateway: "tamara",
                    method: "POST",
                    headers: authHeaders(creds),
                    body: {},
                });
                state = "paid";
            }
            catch (error) {
                // تصريح مكرّر: الطلب مُصرَّح أصلاً من نداء متزامن — نجاح لا فشل.
                if (error instanceof gatewayHttp_1.GatewayHttpError &&
                    [409, 400].includes(error.status)) {
                    state = "paid";
                }
                else {
                    console.error("[tamara] فشل التصريح بالطلب:", (0, gatewayHttp_1.describeGatewayError)(error));
                    return { state: "pending", providerCode: raw };
                }
            }
        }
        return {
            state,
            providerCode: raw,
            amount: Number.isFinite(amount) ? amount : undefined,
            raw: { order_id: orderId, status: raw },
        };
    },
    async refund(providerRef, amount, creds, ctx) {
        // providerRef هو checkout_id؛ نحتاج order_id للاسترداد.
        const details = await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/checkout/${encodeURIComponent(providerRef)}`, { gateway: "tamara", method: "GET", headers: authHeaders(creds) });
        const orderId = details === null || details === void 0 ? void 0 : details.order_id;
        if (!orderId)
            throw new Error("تعذّر إيجاد رقم طلب تمارا للاسترداد");
        await (0, gatewayHttp_1.gatewayRequest)(`${baseUrl(ctx)}/orders/${encodeURIComponent(orderId)}/refund`, {
            gateway: "tamara",
            method: "POST",
            headers: authHeaders(creds),
            body: {
                total_amount: money(amount, "SAR"),
                comment: "استرداد من لوحة التحكم",
            },
        });
    },
};
//# sourceMappingURL=tamaraAdapter.js.map