/**
 * سجل محوّلات بوابات الدفع — الجانب الخادم.
 *
 * خريطة مغلقة: الاسم النصّي القادم من العميل لا يُستخدم إلا للبحث فيها،
 * فلا يستطيع عميل متلاعِب توسيع ما يفعله الخادم. المحوّلات كائنات في خريطة
 * (لا import داخل المصالحة) حتى يمكن تسجيل محوّل وهمي في اختبارات المحاكي.
 */

import * as functions from "firebase-functions";

import type { GatewayAdapter } from "./gatewayTypes";
import { misPayAdapter } from "./mispayClient";
import { madfuAdapter } from "./madfuClient";
import { neoleapAdapter } from "./neoleapClient";
import { tabbyAdapter } from "./tabbyAdapter";
import { tamaraAdapter } from "./tamaraAdapter";
import { isEmulator, mockAdapter } from "./mockGateway";

export const GATEWAY_ADAPTERS: Record<string, GatewayAdapter> = {
  [misPayAdapter.id]: misPayAdapter,
  [madfuAdapter.id]: madfuAdapter,
  [neoleapAdapter.id]: neoleapAdapter,
  // تمارا وتابي انتقلتا إلى السجل ليظهرا للعميل عبر نفس المسار المتحقَّق
  // منه (اتصال مُختبَر + مصالحة خادم-إلى-خادم). ملفّاهما القديمان
  // tamaraClient.ts / tabbyClient.ts باقيان للدوال القديمة دون تغيير.
  [tamaraAdapter.id]: tamaraAdapter,
  [tabbyAdapter.id]: tabbyAdapter,
};

// بوابة وهمية للاختبار المحلي الكامل. الحارس هو FUNCTIONS_EMULATOR، وهو
// متغيّر لا وجود له في الدوال المنشورة، فلا تظهر هذه البوابة في الإنتاج.
if (isEmulator()) {
  GATEWAY_ADAPTERS[mockAdapter.id] = mockAdapter;
}

/** الحقول السرّية لكل بوابة: لا تُرجَع للوحة التحكم إلا مُقنّعة. */
export const GATEWAY_SECRET_FIELDS: Record<string, readonly string[]> = {
  mispay: ["appSecret"],
  madfu: ["basicToken", "password"],
  neoleap: ["tranportalPassword", "resourceKey", "iv"],
  tamara: ["apiToken"],
  tabby: ["secretKey"],
};

/** يُرجع المحوّل أو يرفع خطأ نداء واضحاً. */
export function requireAdapter(gatewayId: unknown): GatewayAdapter {
  const id = typeof gatewayId === "string" ? gatewayId.trim() : "";
  const adapter = GATEWAY_ADAPTERS[id];
  if (!adapter) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `بوابة دفع غير معروفة: ${id || "(فارغ)"}`,
    );
  }
  return adapter;
}

export const secretFieldsOf = (gatewayId: string): readonly string[] =>
  GATEWAY_SECRET_FIELDS[gatewayId] || [];

/** للاختبارات فقط: تسجيل/إزالة محوّل وهمي في المحاكي. */
export function registerTestAdapter(adapter: GatewayAdapter): void {
  if (!process.env.FUNCTIONS_EMULATOR) {
    throw new Error("registerTestAdapter متاح في المحاكي فقط");
  }
  GATEWAY_ADAPTERS[adapter.id] = adapter;
}
