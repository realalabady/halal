"use strict";
/**
 * تسعير الطلب على الخادم.
 *
 * استُخرج من validateOrderAmount في index.ts لأن بوابات الدفع تحتاج التفصيل
 * (الأصناف بأسمائها وأسعارها، الشحن، حصّة الضريبة) وليس الإجمالي فقط. مصدر
 * واحد للحساب: أي اختلاف بين ما يتحقّق منه الخادم وما يُرسل إلى البوابة يعني
 * دفعة بمبلغ خاطئ.
 *
 * الأسعار في المتجر معروضة شاملةً الضريبة (الممارسة المعتادة في السعودية)،
 * فحصّة الضريبة تُستخرج من الإجمالي ولا تُضاف إليه. يضبط التاجر النسبة في
 * settings/store.payment.vatRate (١٥ مثلاً)؛ غيابها يعني ألّا نُصرّح بضريبة.
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
exports.computeOrderPricing = computeOrderPricing;
exports.validateOrderAmountFromPricing = validateOrderAmountFromPricing;
const functions = __importStar(require("firebase-functions"));
const storePaths_1 = require("./storePaths");
const round2 = (n) => Math.round(n * 100) / 100;
/**
 * يحسب تسعير الطلب من مستندات المنتجات وإعدادات الشحن.
 * لا يثق بأي سعر أو اسم أو مبلغ قادم من العميل.
 */
async function computeOrderPricing(storeId, items) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    if (!Array.isArray(items) || items.length === 0) {
        throw new functions.https.HttpsError("invalid-argument", "عناصر الطلب مطلوبة");
    }
    const priced = [];
    let subtotal = 0;
    for (const item of items) {
        const productId = (item === null || item === void 0 ? void 0 : item.productId) || (item === null || item === void 0 ? void 0 : item.reference_id);
        const quantity = Number(item === null || item === void 0 ? void 0 : item.quantity) || 0;
        if (!productId || quantity <= 0) {
            throw new functions.https.HttpsError("invalid-argument", "عنصر طلب غير صالح");
        }
        const productDoc = await (0, storePaths_1.storeDoc)(storeId, "products", productId).get();
        if (!productDoc.exists) {
            throw new functions.https.HttpsError("invalid-argument", `المنتج غير موجود: ${productId}`);
        }
        const product = productDoc.data() || {};
        // Prefer the discounted/sale price if present, else the base price.
        const unitPrice = Number((_c = (_b = (_a = product.discountPrice) !== null && _a !== void 0 ? _a : product.salePrice) !== null && _b !== void 0 ? _b : product.price) !== null && _c !== void 0 ? _c : 0);
        if (!(unitPrice > 0)) {
            throw new functions.https.HttpsError("invalid-argument", `سعر المنتج غير صالح: ${productId}`);
        }
        subtotal += unitPrice * quantity;
        const images = product.images;
        priced.push({
            productId,
            name: String((_d = product.name) !== null && _d !== void 0 ? _d : productId),
            quantity,
            price: unitPrice,
            image: Array.isArray(images) && images.length > 0 ? String(images[0]) : "",
            stock: Number((_e = product.stock) !== null && _e !== void 0 ? _e : 0),
        });
    }
    // Shipping from settings/store (shipping sub-object). Free shipping if the
    // subtotal reaches the configured threshold.
    let shippingCost = 0;
    let vatRate = 0;
    try {
        const settingsDoc = await (0, storePaths_1.settingsRef)(storeId, "store").get();
        const data = settingsDoc.data();
        const shipping = data === null || data === void 0 ? void 0 : data.shipping;
        if (shipping) {
            const threshold = Number((_f = shipping.freeShippingThreshold) !== null && _f !== void 0 ? _f : 0);
            const defaultCost = Number((_g = shipping.defaultShippingCost) !== null && _g !== void 0 ? _g : 0);
            const freeEnabled = shipping.enableFreeShipping !== false;
            if (freeEnabled && threshold > 0 && subtotal >= threshold) {
                shippingCost = 0;
            }
            else {
                shippingCost = defaultCost;
            }
        }
        const rate = Number((_j = (_h = data === null || data === void 0 ? void 0 : data.payment) === null || _h === void 0 ? void 0 : _h.vatRate) !== null && _j !== void 0 ? _j : 0);
        if (Number.isFinite(rate) && rate > 0 && rate < 100) {
            vatRate = rate;
        }
    }
    catch (e) {
        console.error("computeOrderPricing: failed to read store settings", e);
    }
    const roundedSubtotal = round2(subtotal);
    const total = round2(roundedSubtotal + shippingCost);
    // استخراج الضريبة المضمّنة: total - total / (1 + rate)
    const vat = vatRate > 0 ? round2(total - total / (1 + vatRate / 100)) : 0;
    return {
        items: priced,
        subtotal: roundedSubtotal,
        shippingCost: round2(shippingCost),
        vat,
        total,
    };
}
/**
 * يتحقّق من أن المبلغ الذي أرسله العميل يطابق ما حسبه الخادم.
 * نفس السلوك والرسائل السابقة؛ يُرجع الإجمالي المحسوب.
 */
async function validateOrderAmountFromPricing(pricing, clientAmount) {
    const submitted = Number(clientAmount);
    if (Math.abs(pricing.total - submitted) > 0.01) {
        console.error(`Order amount mismatch: client=${submitted} expected=${pricing.total}`);
        throw new functions.https.HttpsError("failed-precondition", "المبلغ المُرسل لا يطابق إجمالي الطلب المحسوب");
    }
    return pricing.total;
}
//# sourceMappingURL=orderPricing.js.map