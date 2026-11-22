/**
 * نقاط النهاية العامة لبوابات الدفع — مجموعة واحدة لكل البوابات.
 *
 * لماذا مجموعة عامة بدل أربع دوال لكل بوابة (نمط Tabby/Tamara الحالي):
 * كل بوابة جديدة كانت ستضيف أربع دوال إلى النشر (بدء بارد، حصص، إدارة)
 * وأربع أغلفة في الواجهة. الاختيار يبقى على الخادم من خريطة مغلقة، وبيانات
 * الاعتماد تُقرأ لكل متجر في كل نداء، فالعزل لم يتغيّر.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
// FieldValue/Timestamp تُستورد مباشرة من firebase-admin/firestore بدل
// admin.firestore.* : الشكل الثاني يعتمد على خصائص ساكنة على دالة،
// وهي تختفي تحت غلاف محاكي الدوال فتفشل الكتابة محلياً. الاستيراد
// المباشر هو الشكل الموصى به ويعمل في البيئتين بلا فرق.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "crypto";

import { pendingPaymentRef, pendingPaymentsCol, settingsRef } from "./storePaths";
import { requireAdapter, secretFieldsOf } from "./gatewayRegistry";
import {
  GatewayConfigError,
  buildGatewayContext,
  isGatewayConfigError,
  loadGatewayCredentials,
  markGatewayUnhealthy,
  maskSecret,
  readGatewayAdminView,
  requireStorefrontBaseUrl,
  syncPublicStatus,
  recordConnectionResult,
  setGatewayEnabled,
  writeGatewayCredentials,
} from "./gatewayStore";
import type { GatewayEnvironment } from "./gatewayStore";
import { describeGatewayError } from "./gatewayHttp";
import { computeOrderPricing, validateOrderAmountFromPricing } from "./orderPricing";
import { expirePendingPayment, reconcileGatewayPayment } from "./paymentReconcile";
import type { GatewayContext, GatewayCredentials } from "./gatewayTypes";
import { isGatewayDeclinedError } from "./gatewayTypes";

/** ساعتان: بعدها تُعدّ محاولة الدفع منتهية. */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeEnvironment = (value: unknown): GatewayEnvironment =>
  value === "production" ? "production" : "sandbox";

/** يحوّل أخطاء الإعداد إلى HttpsError بالعربية. */
function toHttpsError(error: unknown, fallback: string): never {
  if (error instanceof functions.https.HttpsError) throw error;
  if (isGatewayConfigError(error)) {
    throw new functions.https.HttpsError("failed-precondition", error.message);
  }
  console.error(fallback, error);
  throw new functions.https.HttpsError("internal", fallback);
}

/**
 * يُحضر رابط المتجر أو يفشل برسالة يفهمها الأدمن.
 *
 * دالة منفصلة لا سطرين داخل النداء: الخطأ الذي أصلحته هنا كان تسرّب
 * GatewayConfigError خارج الدالة القابلة للنداء، فيصل العميل كـ INTERNAL
 * بلا نصّ — ولا شيء في الواجهة يدلّ على أن الناقص حقل واحد. كونها دالة
 * مُصدَّرة يجعل هذا السلوك قابلاً للاختبار في verify-gateways.
 */
export function resolveStorefrontUrlOrFail(ctx: GatewayContext): string {
  try {
    return requireStorefrontBaseUrl(ctx);
  } catch (error) {
    toHttpsError(error, "تعذّر بدء عملية الدفع. حاول مرة أخرى.");
  }
}

/**
 * يرقّم هاتفاً سعودياً إلى الشكل الذي تتوقّعه البوابات (05XXXXXXXX).
 * الاختلاف بين 05 و +9665 سبب شائع لرفض إنشاء الدفع.
 */
export function normalizeSaudiMobile(raw: string): string {
  const digits = (raw || "").replace(/[^\d]/g, "");
  if (digits.startsWith("966")) return `0${digits.slice(3)}`;
  if (digits.startsWith("00966")) return `0${digits.slice(5)}`;
  if (digits.startsWith("5") && digits.length === 9) return `0${digits}`;
  return digits;
}

/**
 * عنوان يُرسل إلى البوابة في طلبات "استلام من الفرع".
 *
 * المشكلة: الاستلام من الفرع يُفرغ حقول العنوان (لا يُسأل عنها العميل
 * أصلاً)، وكل البوابات تطلب مدينة وعنواناً غير فارغين وترفض الطلب بدونها.
 * فيكون العميل قادراً على اختيار تابي أو تمارا ثم يفشل الدفع بلا سبب ظاهر.
 *
 * الحل: نرسل عنوان *المتجر* — وهو العنوان الصحيح فعلاً، لأن البضاعة تُسلَّم
 * هناك. storeAddress نصّ حر، فنقرأه بالعرف الشائع "المدينة، الحي، الشارع".
 */
export function resolvePickupAddress(storeAddress: string, storeName: string): {
  city: string;
  district: string;
  street: string;
} {
  const parts = (storeAddress || "")
    .split(/[،,]/)
    .map((p) => p.trim())
    .filter(Boolean);

  const fallback = storeName || "استلام من الفرع";
  if (parts.length === 0) {
    return { city: fallback, district: "", street: fallback };
  }
  if (parts.length === 1) {
    return { city: parts[0], district: "", street: parts[0] };
  }
  return {
    city: parts[0],
    district: parts[1] || "",
    street: parts.slice(1).join("، ") || parts[0],
  };
}

export interface GatewayApiDeps {
  requireStoreId: (data: unknown) => Promise<string>;
  requireStoreAdmin: (
    data: unknown,
    context: functions.https.CallableContext,
  ) => Promise<string>;
  parseStoreIdParam: (value: unknown) => string | null;
}

/**
 * يبني مجموعة الدوال. تُمرَّر المساعدات من index.ts بدل تصديرها، حتى لا
 * تتغيّر أي نقطة تحقّق قائمة.
 */
export function buildPaymentGatewayFunctions(deps: GatewayApiDeps) {
  const { requireStoreId, requireStoreAdmin, parseStoreIdParam } = deps;

  // ==================== حفظ بيانات الاعتماد ====================
  const paymentGatewaySaveSettings = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreAdmin(data, context);
      const adapter = requireAdapter(data?.gateway);
      const environment = normalizeEnvironment(data?.environment);
      const incoming = (data?.credentials || {}) as Record<string, unknown>;

      // الحقول السرّية تُعاد مُقنّعة إلى الواجهة؛ إن أعادها الأدمن كما هي
      // فهو لم يُعدّلها، فنُبقي المحفوظ بدل كتابة "••••1234" مكان السرّ.
      const existing = await readGatewayAdminView(
        storeId,
        adapter,
        secretFieldsOf(adapter.id),
      );

      const credentials: GatewayCredentials = {};
      const missing: string[] = [];

      for (const field of adapter.requiredCredentials) {
        const value = asString(incoming[field]);
        const isMasked = value !== "" && value === existing.fields[field];
        if (isMasked) continue;
        if (!value) {
          missing.push(field);
          continue;
        }
        credentials[field] = value;
      }

      // الحقول الاختيارية (مثل iv و gatewayHost في neoleap)
      for (const [key, raw] of Object.entries(incoming)) {
        if (adapter.requiredCredentials.includes(key)) continue;
        const value = asString(raw);
        if (value && value !== maskSecret(value)) credentials[key] = value;
      }

      if (missing.length > 0) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          `الحقول التالية مطلوبة: ${missing.join(", ")}`,
        );
      }

      try {
        const { changed } = await writeGatewayCredentials({
          storeId,
          gatewayId: adapter.id,
          credentials,
          environment,
          uid: context.auth!.uid,
        });
        if (typeof data?.enabled === "boolean") {
          await setGatewayEnabled(storeId, adapter.id, data.enabled);
        }
        // الرسالة تتبع ما حدث فعلاً. كانت ثابتة تطلب إعادة الاختبار حتى حين
        // لا يتغيّر شيء، فيظنّ الأدمن أن اختباره الناجح أُلغي ويدور في حلقة.
        return {
          success: true,
          changed,
          message: changed
            ? "تم حفظ الإعدادات. اضغط \"اختبار الاتصال\" لتفعيل البوابة للعملاء."
            : "تم الحفظ. لم تتغيّر أي قيمة، وحالة الاتصال كما هي.",
        };
      } catch (error) {
        toHttpsError(error, "خطأ في حفظ إعدادات بوابة الدفع");
      }
    },
  );

  // ==================== اختبار الاتصال ====================
  const paymentGatewayTestConnection = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreAdmin(data, context);
      const adapter = requireAdapter(data?.gateway);

      try {
        // نختبر ما هو محفوظ فعلاً: اختبار يمرّ على مفاتيح في الحمولة قد ينجح
        // ثم يفشل الدفع لأن المحفوظ مختلف.
        const { creds, environment } = await loadGatewayCredentials(
          storeId,
          adapter,
        );
        const ctx = await buildGatewayContext(storeId, environment);
        const result = await adapter.testConnection(creds, ctx);

        await recordConnectionResult({
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
      } catch (error) {
        if (isGatewayConfigError(error)) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            error.message,
          );
        }
        const detail = describeGatewayError(error);
        await recordConnectionResult({
          storeId,
          gatewayId: adapter.id,
          environment: normalizeEnvironment(data?.environment),
          minAmountSAR: adapter.minAmountSAR,
          result: { success: false, message: "فشل اختبار الاتصال.", detail },
        }).catch(() => undefined);
        return {
          success: false,
          connected: false,
          message: `فشل اختبار الاتصال: ${detail}`,
        };
      }
    },
  );

  // ==================== حالة الإعدادات للوحة التحكم ====================
  const paymentGatewayGetStatus = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreAdmin(data, context);
      const adapter = requireAdapter(data?.gateway);
      try {
        const view = await readGatewayAdminView(
          storeId,
          adapter,
          secretFieldsOf(adapter.id),
        );

        // إصلاح ذاتي: النسخة العامة تُعاد اشتقاقها من المستند الخاص عند كل
        // فتح لتبويب الدفع. أي انحراف قديم (من إصدار سابق كان يكتبها من
        // أربعة مواضع) يُصحَّح من تلقائه دون تدخّل الأدمن.
        await syncPublicStatus({
          storeId,
          gatewayId: adapter.id,
          credentialFields: adapter.requiredCredentials,
          minAmountSAR: adapter.minAmountSAR,
        }).catch((error) => {
          console.error(`[${adapter.id}] تعذّر مزامنة الحالة العامة:`, error);
        });

        return { gateway: adapter.id, ...view };
      } catch (error) {
        toHttpsError(error, "خطأ في قراءة إعدادات بوابة الدفع");
      }
    },
  );

  // ==================== تفعيل/تعطيل العرض للعميل ====================
  const paymentGatewaySetEnabled = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreAdmin(data, context);
      const adapter = requireAdapter(data?.gateway);
      const enabled = data?.enabled === true;
      try {
        await setGatewayEnabled(storeId, adapter.id, enabled);
        return { success: true, enabled };
      } catch (error) {
        toHttpsError(error, "خطأ في تحديث حالة بوابة الدفع");
      }
    },
  );

  // ==================== إنشاء عملية دفع ====================
  const paymentGatewayCreateCheckout = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreId(data);
      if (!context.auth) {
        throw new functions.https.HttpsError(
          "unauthenticated",
          "يجب تسجيل الدخول لإتمام الدفع",
        );
      }
      const uid = context.auth.uid;
      const adapter = requireAdapter(data?.gateway);

      // ===== التسعير على الخادم =====
      // الأسعار والأسماء تُقرأ من مستندات المنتجات؛ ما يُرسله المتصفّح
      // يُستخدم للتحقق فقط، والمبلغ الذي تراه البوابة هو مبلغ الخادم.
      const fulfillmentMode =
        data?.fulfillment === "pickup" ? "pickup" : "delivery";
      const pricing = await computeOrderPricing(
        storeId,
        data?.items,
        fulfillmentMode,
      );
      await validateOrderAmountFromPricing(pricing, Number(data?.total));

      if (adapter.minAmountSAR && pricing.total < adapter.minAmountSAR) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `الحد الأدنى لهذه الطريقة ${adapter.minAmountSAR} ر.س`,
        );
      }

      const mobile = normalizeSaudiMobile(asString(data?.phone));
      if (!mobile) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "رقم الجوال مطلوب لإتمام الدفع",
        );
      }

      const fulfillment = fulfillmentMode;
      const address = (data?.address || {}) as Record<string, unknown>;
      const customerName = asString(data?.customer) || "عميل";

      // الاستلام من الفرع يُفرغ عنوان العميل، والبوابات ترفض عنواناً فارغاً.
      // نرسل عنوان المتجر لأنه موضع التسليم الحقيقي.
      const storeSettingsSnap = await settingsRef(storeId, "store").get();
      const storeBlock = (storeSettingsSnap.data()?.store || {}) as Record<
        string,
        unknown
      >;
      const pickupAddress = resolvePickupAddress(
        asString(storeBlock.storeAddress),
        asString(storeBlock.storeName),
      );

      const gatewayAddress =
        fulfillment === "pickup"
          ? pickupAddress
          : {
              city: asString(address.city),
              district: asString(address.district),
              street: asString(address.street),
            };

      // معرّف قصير: يصبح معرّف مستند الطلب وأيضاً orderId عند المزوّد،
      // وبعض المزوّدين يحدّون طوله ومحارفه.
      const orderRef = `${adapter.id}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;

      const draft = {
        userId: uid,
        customer: customerName,
        email: asString(data?.email) || context.auth.token?.email || "",
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
        shippingAddress: asString(data?.shippingAddress),
        address: {
          fullName: customerName,
          phone: mobile,
          city: asString(address.city),
          district: asString(address.district),
          street: asString(address.street),
          building: asString(address.building),
          nationalAddress: asString(address.nationalAddress),
        },
        notes: asString(data?.notes),
      };

      let creds: GatewayCredentials;
      let environment: GatewayEnvironment;
      try {
        const loaded = await loadGatewayCredentials(storeId, adapter);
        creds = loaded.creds;
        environment = loaded.environment;
      } catch (error) {
        if (isGatewayConfigError(error)) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "طريقة الدفع غير مُعدّة في هذا المتجر.",
          );
        }
        throw error;
      }

      const ctx = await buildGatewayContext(storeId, environment);
      // هنا فقط نُلزم بوجود رابط المتجر: اختبار الاتصال لا يحتاجه.
      //
      // المرور عبر toHttpsError مقصود وليس تزييناً: بدونه يتسرّب
      // GatewayConfigError خارج الدالة، فيغلّفه Firebase كـ INTERNAL بلا
      // نصّ — أسوأ شكل ممكن لخطأ يُصلحه الأدمن بحقل واحد في اللوحة.
      const storefrontUrl = resolveStorefrontUrlOrFail(ctx);
      const returnBase = `${storefrontUrl}/payment/return/${adapter.id}?ref=${encodeURIComponent(orderRef)}`;

      // يُكتب قبل النداء: إن نجح إنشاء الدفع عند المزوّد ثم انقطع الاتصال
      // قبل وصول الردّ، يبقى للمسح الدوري سجلّ يصالحه.
      await pendingPaymentRef(orderRef).set({
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
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(
          Date.now() + PENDING_TTL_MS,
        ),
      });

      try {
        const result = await adapter.createCheckout(
          {
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
              city: gatewayAddress.city,
              district: gatewayAddress.district,
              street: gatewayAddress.street,
              building:
                fulfillment === "pickup" ? "" : draft.address.building,
            },
            returnUrl: returnBase,
            cancelUrl: `${returnBase}&outcome=cancel`,
            failureUrl: `${returnBase}&outcome=failure`,
            lang: "ar",
          },
          creds,
          ctx,
        );

        await pendingPaymentRef(orderRef).set(
          { providerRef: result.providerRef, redirectUrl: result.redirectUrl },
          { merge: true },
        );

        return { redirectUrl: result.redirectUrl, orderRef };
      } catch (error) {
        const detail = describeGatewayError(error);
        await pendingPaymentRef(orderRef).set(
          {
            status: "FAILED",
            lastError: detail,
            resolvedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (isGatewayDeclinedError(error)) {
          // رفض تجاري: إعادة المحاولة لن تغيّر شيئاً، ورسالة المزوّد تقول
          // للمشتري ما يستطيع فعله. ولا نُعطّل البوابة — المفاتيح سليمة
          // والمشتري التالي قد يُقبل.
          throw new functions.https.HttpsError(
            "failed-precondition",
            (error as Error).message,
          );
        }

        if (isGatewayConfigError(error)) {
          // خطأ إعداد داخل المحوّل نفسه: نصُّه يقول للأدمن ما الناقص،
          // فإخفاؤه خلف "حاول مرة أخرى" يُضيّع الإصلاح الوحيد الممكن.
          throw new functions.https.HttpsError(
            "failed-precondition",
            (error as Error).message,
          );
        }

        if (adapter.isAuthError(error)) {
          // المفاتيح ميّتة: نُخفي البوابة فوراً عن بقية المشترين.
          await markGatewayUnhealthy(storeId, adapter.id, detail).catch(
            () => undefined,
          );
          throw new functions.https.HttpsError(
            "failed-precondition",
            "طريقة الدفع غير متاحة حالياً. اختر طريقة أخرى.",
          );
        }

        console.error(`[${adapter.id}] createCheckout فشل:`, detail);
        throw new functions.https.HttpsError(
          "internal",
          "تعذّر بدء عملية الدفع. حاول مرة أخرى.",
        );
      }
    },
  );

  // ==================== صفحة العودة: تسوية الحالة ====================
  const paymentGatewayResolveReturn = functions.https.onCall(
    async (data, context) => {
      const storeId = await requireStoreId(data);
      if (!context.auth) {
        throw new functions.https.HttpsError(
          "unauthenticated",
          "يجب تسجيل الدخول",
        );
      }
      const orderRef = asString(data?.orderRef);
      if (!orderRef) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "مرجع الدفع مطلوب",
        );
      }

      const snap = await pendingPaymentRef(orderRef).get();
      if (!snap.exists || snap.data()?.storeId !== storeId) {
        throw new functions.https.HttpsError("not-found", "سجل الدفع غير موجود");
      }
      if (snap.data()?.userId !== context.auth.uid) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "هذا الدفع لا يخص المستخدم الحالي",
        );
      }

      try {
        const result = await reconcileGatewayPayment(storeId, orderRef);
        return result;
      } catch (error) {
        toHttpsError(error, "خطأ في تأكيد الدفع");
      }
    },
  );

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
    const storeId = parseStoreIdParam(req.query.store);
    const blob = typeof req.query._ === "string" ? req.query._ : "";

    if (!storeId) {
      res.status(400).send("missing store");
      return;
    }

    let redirect = "/";
    try {
      const adapter = requireAdapter("mispay");
      const { creds, environment } = await loadGatewayCredentials(
        storeId,
        adapter,
      );
      const ctx = await buildGatewayContext(storeId, environment);
      redirect = `${ctx.baseUrl}/payment/return/mispay`;

      if (blob) {
        const { decryptMisPayCallback } = await import("./mispayClient");
        const payload = decryptMisPayCallback(blob, creds.appSecret);
        const snap = await pendingPaymentRef(payload.orderId).get();
        if (snap.exists && snap.data()?.storeId === storeId) {
          await reconcileGatewayPayment(storeId, payload.orderId);
        } else {
          console.warn(`[mispay] عودة بمرجع غير معروف: ${payload.orderId}`);
        }
        redirect = `${redirect}?ref=${encodeURIComponent(payload.orderId)}`;
      }
    } catch (error) {
      console.error("[mispay] فشل معالجة العودة:", describeGatewayError(error));
    }

    res.redirect(302, redirect);
  });

  // ==================== webhook الخاص بـ MIS Pay ====================
  //
  // الحمولة نصّية: { checkoutId, orderId, code, appId }. غير موقّعة — لا
  // توقيع ولا HMAC، فقط قائمة IP — وتُرسل *مرة واحدة بلا إعادة محاولة*.
  // لذلك: نتجاهل code ونستعلم من الخادم، والمسح الدوري هو الضمان الحقيقي.
  const mispayWebhook = functions.https.onRequest(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const orderRef = asString(body.orderId);

    if (!orderRef) {
      res.status(200).send("ignored");
      return;
    }

    try {
      const snap = await pendingPaymentRef(orderRef).get();
      if (!snap.exists) {
        // 200 دائماً: لا إعادة محاولة أصلاً، ولا نُفصح عمّا نعرف.
        console.warn(`[mispay] webhook بمرجع غير معروف: ${orderRef}`);
        res.status(200).send("ok");
        return;
      }

      const storeId = String(snap.data()?.storeId || "");
      const adapter = requireAdapter("mispay");
      const { creds } = await loadGatewayCredentials(storeId, adapter);
      const { appIdMatches } = await import("./mispayClient");

      // تحقّق ضعيف لكنه يمنع النكز الأعمى بين المتاجر.
      if (!appIdMatches(asString(body.appId), creds.appId)) {
        console.warn(`[mispay] webhook بـ appId غير مطابق للمرجع ${orderRef}`);
        res.status(200).send("ok");
        return;
      }

      await reconcileGatewayPayment(storeId, orderRef);
      res.status(200).send("ok");
    } catch (error) {
      console.error("[mispay] فشل webhook:", describeGatewayError(error));
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
    const body = (req.body || {}) as Record<string, unknown>;
    const orderRef =
      asString(body.merchantReference) || asString(body.MerchantReference);

    if (!orderRef) {
      console.warn("[madfu] webhook بلا merchantReference");
      res.status(200).send("ok");
      return;
    }

    try {
      const snap = await pendingPaymentRef(orderRef).get();
      if (!snap.exists || snap.data()?.gateway !== "madfu") {
        console.warn(`[madfu] webhook بمرجع غير معروف: ${orderRef}`);
        res.status(200).send("ok");
        return;
      }
      await reconcileGatewayPayment(String(snap.data()?.storeId || ""), orderRef);
      res.status(200).send("ok");
    } catch (error) {
      console.error("[madfu] فشل webhook:", describeGatewayError(error));
      res.status(200).send("ok");
    }
  });

  // ==================== عودة المتصفّح من neoleap ====================
  //
  // البوابة تُرسل POST إلى responseURL بحقل trandata مشفّر، وتتوقّع في
  // بعض الإصدارات أن يردّ التاجر بجسم  REDIRECT=<url>  بدل تحويل 302.
  // ندعم الشكلين: نكتب REDIRECT= لطلبات POST، ونحوّل 302 لطلبات GET.
  const neoleapReturn = functions.https.onRequest(async (req, res) => {
    const storeId = parseStoreIdParam(req.query.store);
    const source = (req.method === "POST" ? req.body : req.query) || {};
    const trandata = asString((source as Record<string, unknown>).trandata);

    if (!storeId) {
      res.status(400).send("missing store");
      return;
    }

    let target = "/";
    try {
      const adapter = requireAdapter("neoleap");
      const { creds, environment } = await loadGatewayCredentials(
        storeId,
        adapter,
      );
      const ctx = await buildGatewayContext(storeId, environment);
      target = `${ctx.baseUrl}/payment/return/neoleap`;

      if (trandata) {
        const { decodeNeoleapReturn } = await import("./neoleapClient");
        const payload = decodeNeoleapReturn(trandata, creds);
        const orderRef =
          asString(payload.trackId) ||
          asString(payload.trackid) ||
          asString(payload.udf1);

        if (orderRef) {
          const snap = await pendingPaymentRef(orderRef).get();
          if (snap.exists && snap.data()?.storeId === storeId) {
            await reconcileGatewayPayment(storeId, orderRef);
          }
          target = `${target}?ref=${encodeURIComponent(orderRef)}`;
        }
      }
    } catch (error) {
      console.error("[neoleap] فشل معالجة العودة:", describeGatewayError(error));
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
      const cutoff = Timestamp.fromMillis(
        Date.now() - 24 * 60 * 60 * 1000,
      );

      const snap = await pendingPaymentsCol()
        .where("status", "==", "CREATED")
        .where("createdAt", ">", cutoff)
        .limit(200)
        .get();

      let reconciled = 0;
      let expired = 0;

      for (const doc of snap.docs) {
        const data = doc.data();
        const storeId = String(data.storeId || "");
        if (!storeId) continue;

        const expiresAt = data.expiresAt as Timestamp | undefined;
        if (expiresAt && expiresAt.toMillis() < Date.now()) {
          // منتهية الصلاحية، لكن نستعلم مرة أخيرة: قد يكون الدفع تمّ فعلاً.
          try {
            const result = await reconcileGatewayPayment(storeId, doc.id);
            if (result.state === "paid") {
              reconciled += 1;
              continue;
            }
          } catch (error) {
            console.error(`[sweep] ${doc.id}:`, describeGatewayError(error));
          }
          await expirePendingPayment(doc.id);
          expired += 1;
          continue;
        }

        try {
          const result = await reconcileGatewayPayment(storeId, doc.id);
          if (result.state === "paid") reconciled += 1;
        } catch (error) {
          console.error(`[sweep] ${doc.id}:`, describeGatewayError(error));
        }
      }

      console.log(
        `[sweep] فُحصت ${snap.size} دفعة معلّقة: ${reconciled} مُصالَحة، ${expired} منتهية`,
      );
      return null;
    });

  // ==================== صفحة دفع وهمية (المحاكي فقط) ====================
  // تحاكي صفحة المزوّد: زر "ادفع" يُعلّم العملية مدفوعة ثم يعيد العميل
  // إلى رابط العودة، تماماً كما تفعل بوابة حقيقية.
  const mockPayPage = functions.https.onRequest(async (req, res) => {
    const ref = asString(req.query.ref);
    const ret = asString(req.query.ret);
    const amount = asString(req.query.amount);

    if (req.method === "POST" || req.query.pay === "1") {
      const { markMockPaid } = await import("./mockGateway");
      await markMockPaid(ref);
      res.redirect(302, ret);
      return;
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
       <title>بوابة دفع وهمية</title>
       <body style="font-family:system-ui;padding:3rem;text-align:center">
         <h1>بوابة دفع وهمية</h1>
         <p>المرجع: <code>${ref}</code></p>
         <p>المبلغ: <strong>${amount}</strong> ر.س</p>
         <p><a id="pay" href="?ref=${encodeURIComponent(ref)}&ret=${encodeURIComponent(ret)}&pay=1"
            style="display:inline-block;padding:1rem 2rem;background:#15803d;color:#fff;
            border-radius:8px;text-decoration:none">ادفع الآن</a></p>
         <p><a id="cancel" href="${ret}&outcome=cancel">إلغاء</a></p>
       </body></html>`,
    );
  });

  return {
    mockPayPage,
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

export { GatewayConfigError };
