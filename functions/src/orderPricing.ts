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

import * as functions from "firebase-functions";

import { settingsRef, storeDoc } from "./storePaths";

export interface PricedItem {
  productId: string;
  name: string;
  quantity: number;
  /** سعر الوحدة كما قرأه الخادم من مستند المنتج */
  price: number;
  image?: string;
  /** المخزون المتاح وقت الحساب */
  stock: number;
}

export interface OrderPricing {
  items: PricedItem[];
  /** إجمالي الأصناف كما يُعرض (شاملاً الضريبة) */
  subtotal: number;
  shippingCost: number;
  /** حصّة الضريبة المضمّنة داخل subtotal */
  vat: number;
  /** الإجمالي المستحق = subtotal + shippingCost */
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PricingItemInput {
  productId?: string;
  reference_id?: string;
  quantity?: number;
}

/**
 * يحسب تسعير الطلب من مستندات المنتجات وإعدادات الشحن.
 * لا يثق بأي سعر أو اسم أو مبلغ قادم من العميل.
 */
export async function computeOrderPricing(
  storeId: string,
  items: PricingItemInput[] | undefined,
): Promise<OrderPricing> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "عناصر الطلب مطلوبة",
    );
  }

  const priced: PricedItem[] = [];
  let subtotal = 0;

  for (const item of items) {
    const productId = item?.productId || item?.reference_id;
    const quantity = Number(item?.quantity) || 0;
    if (!productId || quantity <= 0) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "عنصر طلب غير صالح",
      );
    }
    const productDoc = await storeDoc(storeId, "products", productId).get();
    if (!productDoc.exists) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `المنتج غير موجود: ${productId}`,
      );
    }
    const product = productDoc.data() || {};
    // Prefer the discounted/sale price if present, else the base price.
    const unitPrice = Number(
      product.discountPrice ?? product.salePrice ?? product.price ?? 0,
    );
    if (!(unitPrice > 0)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `سعر المنتج غير صالح: ${productId}`,
      );
    }
    subtotal += unitPrice * quantity;

    const images = product.images;
    priced.push({
      productId,
      name: String(product.name ?? productId),
      quantity,
      price: unitPrice,
      image: Array.isArray(images) && images.length > 0 ? String(images[0]) : "",
      stock: Number(product.stock ?? 0),
    });
  }

  // Shipping from settings/store (shipping sub-object). Free shipping if the
  // subtotal reaches the configured threshold.
  let shippingCost = 0;
  let vatRate = 0;
  try {
    const settingsDoc = await settingsRef(storeId, "store").get();
    const data = settingsDoc.data();
    const shipping = data?.shipping;
    if (shipping) {
      const threshold = Number(shipping.freeShippingThreshold ?? 0);
      const defaultCost = Number(shipping.defaultShippingCost ?? 0);
      const freeEnabled = shipping.enableFreeShipping !== false;
      if (freeEnabled && threshold > 0 && subtotal >= threshold) {
        shippingCost = 0;
      } else {
        shippingCost = defaultCost;
      }
    }
    const rate = Number(data?.payment?.vatRate ?? 0);
    if (Number.isFinite(rate) && rate > 0 && rate < 100) {
      vatRate = rate;
    }
  } catch (e) {
    console.error("computeOrderPricing: failed to read store settings", e);
  }

  const roundedSubtotal = round2(subtotal);
  const total = round2(roundedSubtotal + shippingCost);

  // استخراج الضريبة المضمّنة: total - total / (1 + rate)
  const vat =
    vatRate > 0 ? round2(total - total / (1 + vatRate / 100)) : 0;

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
export async function validateOrderAmountFromPricing(
  pricing: OrderPricing,
  clientAmount: number,
): Promise<number> {
  const submitted = Number(clientAmount);
  if (Math.abs(pricing.total - submitted) > 0.01) {
    console.error(
      `Order amount mismatch: client=${submitted} expected=${pricing.total}`,
    );
    throw new functions.https.HttpsError(
      "failed-precondition",
      "المبلغ المُرسل لا يطابق إجمالي الطلب المحسوب",
    );
  }
  return pricing.total;
}
