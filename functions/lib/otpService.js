"use strict";
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
exports.sendLoginOtpEmail = void 0;
const nodemailer = __importStar(require("nodemailer"));
const admin = __importStar(require("firebase-admin"));
const resend_1 = require("resend");
const storeSettingsDoc = (storeId, id) => admin.firestore().doc(`stores/${storeId}/settings/${id}`);
const getStoreName = async (storeId) => {
    try {
        const snap = await storeSettingsDoc(storeId, "store").get();
        const data = snap.data() || {};
        const store = data.store || data;
        return store.storeName || "متجرنا";
    }
    catch (_a) {
        return "متجرنا";
    }
};
const getEmailSettings = async (storeId) => {
    try {
        const snap = await storeSettingsDoc(storeId, "email").get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        if (!data.smtpHost ||
            !data.smtpUser ||
            !data.smtpPassword ||
            !data.fromEmail) {
            return null;
        }
        return data;
    }
    catch (_a) {
        return null;
    }
};
/** قالب الرسالة: الرمز كبير وواضح، مع مدة الصلاحية وتنبيه أمني مختصر. */
const buildOtpTemplate = (code, storeName, expiresInMinutes) => `
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
const sendLoginOtpEmail = async (storeId, to, code, expiresInMinutes) => {
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            smtpError = `SMTP: ${message}`;
            console.error("OTP email via SMTP failed, trying Resend:", message);
        }
    }
    // 2) Resend كمسار احتياطي
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
        try {
            const resend = new resend_1.Resend(apiKey);
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
        }
        catch (err) {
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
exports.sendLoginOtpEmail = sendLoginOtpEmail;
//# sourceMappingURL=otpService.js.map