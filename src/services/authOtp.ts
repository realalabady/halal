import { getFunctions, httpsCallable, type FunctionsError } from "firebase/functions";
import { auth } from "../config/firebase";
import { STORE_ID } from "../config/store";

// ============================================================================
// خطوة التحقق بالرمز (OTP) بعد كلمة المرور.
// الرمز يُولَّد ويُرسل من Cloud Functions؛ الواجهة لا ترى الرمز ولا تتحقق منه.
// ============================================================================

const functions = getFunctions();

export interface SendOtpResponse {
  /** false عندما يكون عدّاد إعادة الإرسال ما زال يعمل (لم يُرسل رمز جديد). */
  sent: boolean;
  maskedEmail: string;
  /** عدد الثواني قبل السماح بإعادة الإرسال. */
  resendAfterSeconds: number;
  /** عدد الثواني قبل انتهاء صلاحية الرمز الحالي. */
  expiresInSeconds: number;
}

/** رسالة الخطأ العربية التي ترسلها الدالة، أو رسالة عامة. */
export const otpErrorMessage = (err: unknown, fallback: string): string => {
  const message = (err as FunctionsError | undefined)?.message;
  return message && message !== "INTERNAL" ? message : fallback;
};

/** يطلب إرسال رمز جديد إلى بريد المستخدم المسجَّل دخوله بكلمة المرور. */
export const sendLoginOtp = async (): Promise<SendOtpResponse> => {
  const callable = httpsCallable<{ storeId: string }, SendOtpResponse>(
    functions,
    "authSendLoginOtp",
  );
  const { data } = await callable({ storeId: STORE_ID });
  return data;
};

/**
 * يتحقق من الرمز. عند النجاح نحدّث رمز الهوية (getIdToken(true)) حتى يحمل
 * claim الجديد otpVerified=true، وإلا أخرج التطبيق المستخدم بعد لحظات.
 */
export const verifyLoginOtp = async (code: string): Promise<void> => {
  const callable = httpsCallable<{ storeId: string; code: string }, { verified: boolean }>(
    functions,
    "authVerifyLoginOtp",
  );
  await callable({ storeId: STORE_ID, code });
  await auth.currentUser?.getIdToken(true);
};

/** يرفع حجز الرمز لتسجيل الدخول بـ Google (تتحقق الدالة من المزوّد). */
export const clearOtpGateForGoogle = async (): Promise<void> => {
  const callable = httpsCallable<{ storeId: string }, { verified: boolean }>(
    functions,
    "authClearOtpGate",
  );
  await callable({ storeId: STORE_ID });
  await auth.currentUser?.getIdToken(true);
};

// ==================== علامة "خطوة الرمز جارية" ====================
// بين إدخال كلمة المرور وتأكيد الرمز تكون جلسة Firebase قائمة فعلاً، لكن
// رمز الهوية المخزَّن قد يكون ما زال يحمل otpVerified=true من دخول سابق.
// هذه العلامة تُخبر App بألا يُدخل المستخدم إلى المتجر قبل تأكيد الرمز.
// تعيش في sessionStorage فقط، فتزول مع إغلاق التبويب.

const OTP_PENDING_KEY = "otpPending";

export const markOtpPending = (): void => {
  try {
    sessionStorage.setItem(OTP_PENDING_KEY, "1");
  } catch {
    /* تجاهل: التخزين غير متاح */
  }
};

export const clearOtpPending = (): void => {
  try {
    sessionStorage.removeItem(OTP_PENDING_KEY);
  } catch {
    /* تجاهل */
  }
};

export const isOtpStepInProgress = (): boolean => {
  try {
    return sessionStorage.getItem(OTP_PENDING_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * هل اجتاز المستخدم الحالي خطوة التحقق؟
 * القيمة false تعني أن رمزاً أُرسل ولم يُؤكَّد بعد. القيمة غير المعرَّفة تعني
 * حساباً لم يمر بهذه الخطوة أصلاً (تسجيل بـ Google أو حساب جديد)، فلا نمنعه.
 */
export const isOtpPending = async (): Promise<boolean> => {
  const user = auth.currentUser;
  if (!user) return false;
  try {
    // تحديث إجباري: الرمز المخزَّن قد يكون أقدم من تغيير الـ claim.
    const token = await user.getIdTokenResult(true);
    return token.claims.otpVerified === false;
  } catch {
    return false;
  }
};
