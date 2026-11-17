import * as nodemailer from "nodemailer";
import * as admin from "firebase-admin";
import { Resend } from "resend";

// ============================================================================
// إرسال رمز تحقق (OTP) لمرة واحدة إلى بريد المستخدم عند تسجيل الدخول.
//
// يُفضّل إعدادات SMTP الخاصة بالمتجر (stores/{storeId}/settings/email) لأن
// الرسالة تصل من بريد المتجر نفسه. إن لم تكن مضبوطة، نرجع إلى Resend
// (RESEND_API_KEY) كمسار احتياطي. إن لم يتوفر أي منهما فلا يمكن إتمام
// تسجيل الدخول، فنُعيد خطأً صريحاً بدل تخطّي الرمز بهدوء — تخطّيه يعني
// تعطيل خطوة التحقق بالكامل.
// ============================================================================

interface EmailSettings {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  fromEmail: string;
  fromName: string;
}

export interface SendOtpResult {
  success: boolean;
  via?: "smtp" | "resend";
  error?: string;
}

const storeSettingsDoc = (
  storeId: string,
  id: string,
): FirebaseFirestore.DocumentReference =>
  admin.firestore().doc(`stores/${storeId}/settings/${id}`);

const getStoreName = async (storeId: string): Promise<string> => {
  try {
    const snap = await storeSettingsDoc(storeId, "store").get();
    const data = snap.data() || {};
    const store = data.store || data;
    return store.storeName || "متجرنا";
  } catch {
    return "متجرنا";
  }
};

const getEmailSettings = async (
  storeId: string,
): Promise<EmailSettings | null> => {
  try {
    const snap = await storeSettingsDoc(storeId, "email").get();
    if (!snap.exists) return null;
    const data = snap.data() as EmailSettings;
    if (
      !data.smtpHost ||
      !data.smtpUser ||
      !data.smtpPassword ||
      !data.fromEmail
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

/** قالب الرسالة: الرمز كبير وواضح، مع مدة الصلاحية وتنبيه أمني مختصر. */
const buildOtpTemplate = (
  code: string,
  storeName: string,
  expiresInMinutes: number,
): string => `
  <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
    <div style="background:#1f7a4d;color:#fff;padding:22px;border-radius:12px 12px 0 0;text-align:center;">
      <h2 style="margin:0;font-size:20px;">رمز تسجيل الدخول</h2>
      <p style="margin:6px 0 0;font-size:14px;opacity:.9;">${storeName}</p>
    </div>
    <div style="border:1px solid #eee;border-top:none;padding:26px 22px;border-radius:0 0 12px 12px;text-align:center;">
      <p style="margin:0 0 18px;font-size:15px;">استخدم الرمز التالي لإكمال تسجيل الدخول:</p>
      <div style="display:inline-block;background:#f4f7f5;border:1px dashed #1f7a4d;border-radius:10px;padding:14px 26px;">
        <span style="font-size:32px;font-weight:bold;letter-spacing:10px;color:#1f7a4d;direction:ltr;display:inline-block;">${code}</span>
      </div>
      <p style="margin:18px 0 0;font-size:14px;color:#555;">
        الرمز صالح لمدة ${expiresInMinutes} دقائق، ولمرة واحدة فقط.
      </p>
      <p style="margin:14px 0 0;font-size:13px;color:#888;">
        إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة وغيّر كلمة المرور.
      </p>
    </div>
  </div>`;

export const sendLoginOtpEmail = async (
  storeId: string,
  to: string,
  code: string,
  expiresInMinutes: number,
): Promise<SendOtpResult> => {
  const storeName = await getStoreName(storeId);
  const subject = `رمز تسجيل الدخول: ${code}`;
  const html = buildOtpTemplate(code, storeName, expiresInMinutes);

  // سبب فشل SMTP يُحفظ ليظهر في الرسالة النهائية إن فشل المساران.
  let smtpError = "إعدادات SMTP للمتجر غير مكتملة";

  // 1) SMTP الخاص بالمتجر
  const settings = await getEmailSettings(storeId);
  if (settings) {
    try {
      const transporter = nodemailer.createTransport({
        host: settings.smtpHost,
        port: Number(settings.smtpPort) || 587,
        secure: Number(settings.smtpPort) === 465,
        auth: { user: settings.smtpUser, pass: settings.smtpPassword },
      });

      await transporter.sendMail({
        from: `"${settings.fromName || storeName}" <${settings.fromEmail}>`,
        to,
        subject,
        html,
      });

      return { success: true, via: "smtp" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      smtpError = `SMTP: ${message}`;
      console.error("OTP email via SMTP failed, trying Resend:", message);
    }
  }

  // 2) Resend كمسار احتياطي
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const resend = new Resend(apiKey);
      const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
      const { error } = await resend.emails.send({
        from: `${storeName} <${fromEmail}>`,
        to,
        subject,
        html,
      });
      if (error) {
        console.error("OTP email via Resend error:", error);
        return { success: false, error: String(error.message || error) };
      }
      return { success: true, via: "resend" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("OTP email via Resend failed:", message);
      return { success: false, error: message };
    }
  }

  return {
    success: false,
    error: `${smtpError}، و RESEND_API_KEY غير مضبوط في الدوال`,
  };
};
