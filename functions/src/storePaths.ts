/**
 * بناة مسارات Firestore للمتجر (multi-tenant).
 *
 * عدة متاجر تتشارك مشروع Firebase واحداً، والدوال تُنشر مرة واحدة للمشروع
 * كله، فلا تُعرف هوية المتجر من متغير بيئة. استُخرجت هذه البناة من index.ts
 * ليستعملها كود بوابات الدفع الجديد بنفس المصدر الواحد بدل نسخها.
 *
 * ملاحظة: لا تُنادِ admin.firestore() وقت تحميل الوحدة — كلها داخل دوال،
 * حتى تبقى بعد admin.initializeApp() في index.ts.
 */

import * as admin from "firebase-admin";

export const STORE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** مستند جذر المتجر: stores/{storeId} */
export function storeRef(storeId: string): FirebaseFirestore.DocumentReference {
  return admin.firestore().doc(`stores/${storeId}`);
}

/** مجموعة فرعية داخل المتجر: stores/{storeId}/{col} */
export function storeCol(
  storeId: string,
  col: string,
): FirebaseFirestore.CollectionReference {
  return admin.firestore().collection(`stores/${storeId}/${col}`);
}

/** مستند داخل مجموعة فرعية: stores/{storeId}/{col}/{id} */
export function storeDoc(
  storeId: string,
  col: string,
  id: string,
): FirebaseFirestore.DocumentReference {
  return admin.firestore().doc(`stores/${storeId}/${col}/${id}`);
}

/** مستند إعدادات داخل المتجر: stores/{storeId}/settings/{id} */
export function settingsRef(
  storeId: string,
  id: string,
): FirebaseFirestore.DocumentReference {
  return storeDoc(storeId, "settings", id);
}

/** مجموعة الدفعات المعلّقة — عليا (top-level)، يكتبها Admin SDK وحده. */
export function pendingPaymentRef(
  orderRef: string,
): FirebaseFirestore.DocumentReference {
  return admin.firestore().doc(`pending_payments/${orderRef}`);
}

export function pendingPaymentsCol(): FirebaseFirestore.CollectionReference {
  return admin.firestore().collection("pending_payments");
}
