/**
 * خدمة بوابات الدفع — الفرونت إند
 *
 * أغلفة رقيقة فوق الدوال السحابية، بنفس نمط services/tamara.ts. لا منطق
 * خاص ببوابة هنا: المعرّف حقل عادي في الحمولة، والخادم يختار المحوّل.
 */

import { getFunctions, httpsCallable } from "firebase/functions";

import { withStore } from "../config/store";
import type { GatewayEnvironment, GatewayId } from "../constants/paymentGateways";

const functions = getFunctions();

export type ConnectionStatus = "untested" | "connected" | "failed";

export interface GatewayAdminStatus {
  gateway: GatewayId;
  /** قيم الحقول: الأسرار مُقنّعة (••••1234)، لا تُرسل صريحة للمتصفّح أبداً */
  fields: Record<string, string>;
  environment: GatewayEnvironment;
  enabled: boolean;
  connection: {
    status: ConnectionStatus;
    message?: string;
    lastTestedAt?: string;
    lastVerifiedAt?: string;
  };
}

/** يقرأ الإعدادات المحفوظة وحالة الاتصال (للأدمن). */
export async function getGatewayStatus(
  gateway: GatewayId,
): Promise<GatewayAdminStatus> {
  const call = httpsCallable(functions, "paymentGatewayGetStatus");
  const result = await call(withStore({ gateway }));
  return result.data as GatewayAdminStatus;
}

/**
 * يحفظ بيانات الاعتماد (للأدمن).
 * حقل سرّي يُرسل كما عاد مُقنّعاً يُفهم على أنه "لم يتغيّر" ويُبقي المحفوظ.
 */
export async function saveGatewaySettings(
  gateway: GatewayId,
  credentials: Record<string, string>,
  environment: GatewayEnvironment,
): Promise<{ success: boolean; message: string }> {
  const call = httpsCallable(functions, "paymentGatewaySaveSettings");
  const result = await call(
    withStore({ gateway, credentials, environment }),
  );
  return result.data as { success: boolean; message: string };
}

/** يختبر الاتصال بالمفاتيح المحفوظة فعلاً (للأدمن). */
export async function testGatewayConnection(
  gateway: GatewayId,
): Promise<{ success: boolean; connected: boolean; message: string }> {
  const call = httpsCallable(functions, "paymentGatewayTestConnection");
  const result = await call(withStore({ gateway }));
  return result.data as {
    success: boolean;
    connected: boolean;
    message: string;
  };
}

/** يفعّل أو يعطّل عرض البوابة للعملاء (للأدمن). */
export async function setGatewayEnabled(
  gateway: GatewayId,
  enabled: boolean,
): Promise<{ success: boolean; enabled: boolean }> {
  const call = httpsCallable(functions, "paymentGatewaySetEnabled");
  const result = await call(withStore({ gateway, enabled }));
  return result.data as { success: boolean; enabled: boolean };
}

export interface CreateGatewayCheckoutRequest {
  gateway: GatewayId;
  /** للتحقق فقط: الخادم يعيد حساب الأسعار من مستندات المنتجات */
  items: { productId: string; quantity: number }[];
  total: number;
  customer: string;
  email: string;
  phone: string;
  fulfillment: "delivery" | "pickup";
  shippingAddress: string;
  address: {
    city: string;
    district: string;
    street: string;
    building?: string;
    nationalAddress?: string;
  };
  notes?: string;
}

/** ينشئ عملية دفع ويُرجع رابط التحويل ومرجع الطلب. */
export async function createGatewayCheckout(
  request: CreateGatewayCheckoutRequest,
): Promise<{ redirectUrl: string; orderRef: string }> {
  const call = httpsCallable(functions, "paymentGatewayCreateCheckout");
  const result = await call(withStore(request));
  return result.data as { redirectUrl: string; orderRef: string };
}

export interface ResolveReturnResult {
  state: "paid" | "pending" | "cancelled" | "failed" | "refunded" | "expired";
  orderId?: string;
  providerCode?: string;
  message: string;
}

/**
 * يسوّي حالة الدفع بعد عودة العميل.
 * الخادم يستعلم من المزوّد — لا يثق بما يحمله رابط العودة.
 */
export async function resolveGatewayReturn(
  gateway: GatewayId,
  orderRef: string,
): Promise<ResolveReturnResult> {
  const call = httpsCallable(functions, "paymentGatewayResolveReturn");
  const result = await call(withStore({ gateway, orderRef }));
  return result.data as ResolveReturnResult;
}
