import React, { useState, useEffect } from "react";
import {
  Store,
  Bell,
  CreditCard,
  Truck,
  Shield,
  Save,
  Loader,
  Mail,
  AlertTriangle,
  FileText,
  Upload,
  Trash2,
} from "lucide-react";
import { useStore } from "../../store/useStore";
import {
  getSettings,
  updateSettings,
  getEmailSettings,
  updateEmailSettings,
} from "../../services/firestore";
import GatewaySettingsCard from "../../components/GatewaySettingsCard/GatewaySettingsCard";
import {
  MANUAL_METHOD_IDS,
  PAYMENT_GATEWAYS,
  paymentMethodDescription,
  paymentMethodLabel,
} from "../../constants/paymentGateways";
import {
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
} from "firebase/auth";
import { auth } from "../../config/firebase";
import { uploadImage } from "../../services/storage";
import { isValidSaudiVatNumber } from "../../utils/invoice";
import { DEFAULT_BUSINESS_INFO } from "../../store/useStore";
import type { BusinessInfo } from "../../store/useStore";
import type { StoreSettings } from "../../services/firestore";
import "./Settings.css";

const Settings: React.FC = () => {
  const { user } = useStore();
  const [loading, setLoading] = useState(false);
  const [savingStoreUrl, setSavingStoreUrl] = useState(false);
  const [activeTab, setActiveTab] = useState("store");

  const [storeSettings, setStoreSettings] = useState({
    storeName: "حلال",
    storeEmail: "",
    storePhone: "",
    storeAddress: "المملكة العربية السعودية",
    currency: "SAR",
    language: "ar",
    bankName: "",
    bankIban: "",
    storeUrl: "",
  });

  // الهوية النظامية التي تُطبع على الفاتورة
  const [businessSettings, setBusinessSettings] =
    useState<BusinessInfo>(DEFAULT_BUSINESS_INFO);
  const [logoUploading, setLogoUploading] = useState(false);

  const [shippingSettings, setShippingSettings] = useState({
    freeShippingThreshold: 200,
    defaultShippingCost: 25,
    enableFreeShipping: true,
    estimatedDays: "3-5",
  });

  const [notificationSettings, setNotificationSettings] = useState({
    orderNotifications: true,
    lowStockAlert: true,
    customerMessages: true,
    marketingEmails: false,
    lowStockThreshold: 5,
  });

  // هذا الجدول يتحكّم بالطرق اليدوية فقط، وهي الطرق الوحيدة التي تقرأ منه
  // واجهة العميل. كان يعرض أيضاً card/tamara/tabby رغم أن الـ checkout
  // يتجاهلها عمداً، فكان الأدمن يُبدّل مفاتيح بلا أثر بينما تبقى الطرق
  // العاملة مُطفأة. البوابات (MIS Pay / Madfu / neoleap) لها بطاقاتها أسفل،
  // ولا تظهر للعميل إلا بعد نجاح اختبار اتصال حقيقي.
  const [paymentMethods, setPaymentMethods] = useState<
    { id: string; name: string; enabled: boolean }[]
  >(() =>
    MANUAL_METHOD_IDS.map((id) => ({
      id,
      name: paymentMethodLabel(id),
      enabled: true,
    })),
  );

  // حالة تمارا/تابي اليدوية حُذفت مع كتلتيهما: بطاقة السجل
  // (GatewaySettingsCard) تدير الحقول وحالة الاتصال المحفوظة على الخادم.

  const [emailSettings, setEmailSettings] = useState({
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPassword: "",
    fromEmail: "",
    fromName: "حلال",
  });
  const [emailLoading, setEmailLoading] = useState(false);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current: "",
    newPass: "",
    confirm: "",
  });
  const [passwordLoading, setPasswordLoading] = useState(false);

  // جلب الإعدادات من Firestore
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await getSettings();
        if (settings) {
          // الدمج لا الاستبدال: مستندات المتاجر القديمة لا تحوي حقول البنك،
          // واستبدال الكائن كله يجعل قيم تلك الحقول undefined فتتحول الحقول
          // المتحكَّم بها إلى غير متحكَّم بها.
          if (settings.store)
            setStoreSettings((prev) => ({ ...prev, ...settings.store }));
          // الدمج لا الاستبدال، لنفس سبب كتلة المتجر أعلاه.
          if (settings.business)
            setBusinessSettings((prev) => ({ ...prev, ...settings.business }));
          // نسبة الضريبة محفوظة في payment.vatRate لأنها النسبة التي يحسب
          // بها الخادم أيضاً. كتلة business لا تملك نسختها الخاصة.
          if (settings.payment?.vatRate != null)
            setBusinessSettings((prev) => ({
              ...prev,
              vatRate: settings.payment!.vatRate as number,
              // نسبة محفوظة أكبر من صفر تعني أن الضريبة مُطبّقة فعلاً.
              vatEnabled: (settings.payment!.vatRate as number) > 0,
            }));
          if (settings.shipping) setShippingSettings(settings.shipping);
          if (settings.notifications)
            setNotificationSettings(settings.notifications);
          // تطبيع المحفوظ على الطرق اليدوية الثلاث: المستندات القديمة تحمل
          // card/tamara/tabby (مفاتيح ميّتة) ولا تحمل emkan أصلاً.
          if (settings.payment?.methods) {
            const saved = settings.payment.methods;
            setPaymentMethods((prev) =>
              prev.map((m) => {
                const match = saved.find((x) => x.id === m.id);
                return match ? { ...m, enabled: match.enabled !== false } : m;
              }),
            );
          }
        }
        // Email SMTP settings live in a separate admin-only doc.
        const email = await getEmailSettings();
        if (email) setEmailSettings(email);
      } catch (error) {
        console.error("Error fetching settings:", error);
      }
    };
    fetchSettings();
  }, []);

  /**
   * الضريبة مُطبّقة فقط مع رقم ضريبي صحيح.
   *
   * الحالة «ضريبة معروضة بلا تسجيل» مخالفة نظامية، فهي غير قابلة للحفظ من
   * هنا أصلاً: المفتاح لا يُفعّل بدون رقم صحيح، والنسبة المحفوظة تصير صفراً
   * عند تعطيله — فيتوقّف الخادم عن استخراج الضريبة أيضاً.
   */
  const vatIsLegallyActive =
    businessSettings.vatEnabled && isValidSaudiVatNumber(businessSettings.vatNumber);

  const buildSettingsPayload = (
    storeOverride?: typeof storeSettings,
  ): StoreSettings => ({
    store: storeOverride ?? storeSettings,
    business: {
      ...businessSettings,
      vatEnabled: vatIsLegallyActive,
      vatNumber: vatIsLegallyActive ? businessSettings.vatNumber.trim() : "",
    },
    shipping: shippingSettings,
    notifications: notificationSettings,
    payment: {
      methods: paymentMethods,
      // مصدر واحد للنسبة: هذه هي التي يقرأها orderPricing.ts على الخادم.
      vatRate: vatIsLegallyActive ? Number(businessSettings.vatRate) || 0 : 0,
    },
  });

  const handleSave = async () => {
    if (businessSettings.vatEnabled && !vatIsLegallyActive) {
      alert(
        "الرقم الضريبي غير صحيح: ١٥ رقماً يبدأ بـ ٣ وينتهي بـ ٣. " +
          "لن تُفعّل الضريبة بدونه.",
      );
      return;
    }
    setLoading(true);
    try {
      await updateSettings(buildSettingsPayload());
      alert("تم حفظ الإعدادات بنجاح");
    } catch (error) {
      console.error("Error saving settings:", error);
      alert("حدث خطأ أثناء حفظ الإعدادات");
    } finally {
      setLoading(false);
    }
  };

  // رابط المتجر حقل في تبويب «المتجر»، لكن أثره يظهر في تبويب «المدفوعات»:
  // بدونه يفشل كل دفع عبر بوابة. فالتنبيه والإصلاح يُعرضان هنا، حيث يقف
  // الأدمن فعلاً، لا في التبويب الذي يحتوي الحقل.
  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "";
  // لا نقترح localhost: حفظه يُرسل المشترين الحقيقيين إلى جهاز الأدمن.
  const originIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(
    currentOrigin,
  );
  const storeUrlMissing = !storeSettings.storeUrl?.trim();

  const handleUseCurrentOrigin = async () => {
    const next = { ...storeSettings, storeUrl: currentOrigin };
    setSavingStoreUrl(true);
    try {
      await updateSettings(buildSettingsPayload(next));
      setStoreSettings(next);
    } catch (error) {
      console.error("Error saving store url:", error);
      alert("تعذّر حفظ رابط المتجر");
    } finally {
      setSavingStoreUrl(false);
    }
  };

  /**
   * شعار الفاتورة. يُرفع تحت stores/{id}/branding/ ويُحفظ رابطه في الإعدادات.
   * الرفع فوري والحفظ مؤجّل لزرّ «حفظ التغييرات» مثل بقيّة الحقول.
   */
  const handleLogoUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("اختر ملف صورة (PNG أو SVG أو JPG).");
      return;
    }
    // الحدّ يطابق قاعدة التخزين لمسار branding؛ ملف أكبر يُرفض على الخادم
    // برسالة غامضة، فنمنعه هنا برسالة مفهومة.
    if (file.size > 2 * 1024 * 1024) {
      alert("حجم الشعار أكبر من ٢ ميجابايت. اضغط الصورة ثم أعد المحاولة.");
      return;
    }
    setLogoUploading(true);
    try {
      const url = await uploadImage(file, "branding");
      setBusinessSettings((prev) => ({ ...prev, logoUrl: url }));
    } catch (error) {
      console.error("Error uploading logo:", error);
      alert("تعذّر رفع الشعار. حاول مرة أخرى.");
    } finally {
      setLogoUploading(false);
    }
  };

  const togglePaymentMethod = (id: string) => {
    setPaymentMethods((prev) =>
      prev.map((method) =>
        method.id === id ? { ...method, enabled: !method.enabled } : method,
      ),
    );
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.newPass !== passwordForm.confirm) {
      alert("كلمتا المرور غير متطابقتين");
      return;
    }
    if (passwordForm.newPass.length < 6) {
      alert("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
      return;
    }
    setPasswordLoading(true);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser || !currentUser.email)
        throw new Error("لم يتم العثور على المستخدم");
      const credential = EmailAuthProvider.credential(
        currentUser.email,
        passwordForm.current,
      );
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, passwordForm.newPass);
      alert("تم تغيير كلمة المرور بنجاح");
      setShowPasswordModal(false);
      setPasswordForm({ current: "", newPass: "", confirm: "" });
    } catch (error: unknown) {
      console.error("Password change error:", error);
      const msg =
        (error as { code?: string })?.code === "auth/wrong-password"
          ? "كلمة المرور الحالية غير صحيحة"
          : "حدث خطأ أثناء تغيير كلمة المرور";
      alert(msg);
    } finally {
      setPasswordLoading(false);
    }
  };

  const lastLogin = auth.currentUser?.metadata?.lastSignInTime
    ? new Date(auth.currentUser.metadata.lastSignInTime).toLocaleString("ar-SA")
    : "غير متوفر";

  const tabs = [
    { id: "store", label: "المتجر", icon: Store },
    { id: "business", label: "الفاتورة والهوية النظامية", icon: FileText },
    { id: "shipping", label: "الشحن", icon: Truck },
    { id: "notifications", label: "الإشعارات", icon: Bell },
    { id: "payment", label: "الدفع", icon: CreditCard },
    { id: "email", label: "البريد الإلكتروني", icon: Mail },
    { id: "security", label: "الأمان", icon: Shield },
  ];

  return (
    <div className="settings-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>الإعدادات</h1>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? (
            <Loader className="spinner" size={18} />
          ) : (
            <Save size={18} />
          )}
          حفظ التغييرات
        </button>
      </div>

      <div className="settings-layout">
        {/* Tabs */}
        <div className="settings-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon size={20} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="settings-content">
          {/* Store Settings */}
          {activeTab === "store" && (
            <div className="settings-card">
              <div className="card-header">
                <Store size={22} />
                <h2>إعدادات المتجر</h2>
              </div>
              <div className="settings-form">
                <div className="form-row">
                  <div className="form-group">
                    <label>اسم المتجر</label>
                    <input
                      type="text"
                      value={storeSettings.storeName}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          storeName: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>البريد الإلكتروني</label>
                    <input
                      type="email"
                      value={storeSettings.storeEmail}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          storeEmail: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>رقم الهاتف</label>
                    <input
                      type="tel"
                      value={storeSettings.storePhone}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          storePhone: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>العنوان</label>
                    <input
                      type="text"
                      value={storeSettings.storeAddress}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          storeAddress: e.target.value,
                        })
                      }
                    />
                    <p className="field-hint">
                      يُستخدم أيضاً كعنوان التسليم المُرسل لبوابات الدفع في
                      طلبات الاستلام من الفرع. الأفضل كتابته هكذا:
                      المدينة، الحي، الشارع.
                    </p>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>رابط المتجر</label>
                    <input
                      type="url"
                      dir="ltr"
                      placeholder="https://example.com"
                      value={storeSettings.storeUrl}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          storeUrl: e.target.value.trim(),
                        })
                      }
                    />
                    <p className="field-hint">
                      مطلوب لبوابات الدفع: إليه يعود العميل بعد الدفع. بدونه
                      لا يمكن بدء أي عملية دفع عبر بوابة.
                    </p>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>اسم البنك</label>
                    <input
                      type="text"
                      value={storeSettings.bankName}
                      placeholder="مثال: البنك الأهلي"
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          bankName: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>رقم الآيبان</label>
                    <input
                      type="text"
                      dir="ltr"
                      value={storeSettings.bankIban}
                      placeholder="SA…"
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          bankIban: e.target.value.trim(),
                        })
                      }
                    />
                    <small className="field-hint">
                      بدون آيبان لن يظهر خيار التحويل البنكي للعملاء عند الدفع.
                    </small>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>العملة</label>
                    <select
                      value={storeSettings.currency}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          currency: e.target.value,
                        })
                      }
                    >
                      <option value="SAR">ريال سعودي (SAR)</option>
                      <option value="AED">درهم إماراتي (AED)</option>
                      <option value="KWD">دينار كويتي (KWD)</option>
                      <option value="USD">دولار أمريكي (USD)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>اللغة</label>
                    <select
                      value={storeSettings.language}
                      onChange={(e) =>
                        setStoreSettings({
                          ...storeSettings,
                          language: e.target.value,
                        })
                      }
                    >
                      <option value="ar">العربية</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Shipping Settings */}
          {/* Invoice & legal identity */}
          {activeTab === "business" && (
            <div className="settings-card">
              <div className="card-header">
                <FileText size={22} />
                <h2>الفاتورة والهوية النظامية</h2>
              </div>
              <div className="settings-form">
                <p className="settings-hint">
                  هذه البيانات تُطبع على كل فاتورة. الطلبات تحتفظ بنسختها
                  لحظة البيع، فتعديلها هنا لا يغيّر فواتير سابقة.
                </p>

                {/* ===== الشعار ===== */}
                <div className="form-group">
                  <label>شعار الفاتورة</label>
                  <div className="logo-uploader">
                    {businessSettings.logoUrl ? (
                      <img
                        src={businessSettings.logoUrl}
                        alt="شعار الفاتورة"
                        className="logo-preview"
                      />
                    ) : (
                      <div className="logo-placeholder">
                        {storeSettings.storeName || "حلال"}
                      </div>
                    )}
                    <div className="logo-actions">
                      <label className="btn btn-outline btn-sm">
                        {logoUploading ? (
                          <Loader className="spinner" size={16} />
                        ) : (
                          <Upload size={16} />
                        )}
                        {businessSettings.logoUrl ? "تغيير" : "رفع شعار"}
                        <input
                          type="file"
                          accept="image/*"
                          hidden
                          onChange={handleLogoUpload}
                          disabled={logoUploading}
                        />
                      </label>
                      {businessSettings.logoUrl && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() =>
                            setBusinessSettings((prev) => ({
                              ...prev,
                              logoUrl: "",
                            }))
                          }
                        >
                          <Trash2 size={16} />
                          إزالة
                        </button>
                      )}
                      <span className="field-hint">
                        PNG أو SVG، حتى ٢ ميجابايت. بدون شعار يُطبع اسم المتجر
                        نصّاً.
                      </span>
                    </div>
                  </div>
                </div>

                {/* ===== الاسم القانوني ===== */}
                <div className="form-row">
                  <div className="form-group">
                    <label>الاسم القانوني (عربي)</label>
                    <input
                      type="text"
                      placeholder="مؤسسة … للتجارة"
                      value={businessSettings.legalNameAr}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          legalNameAr: e.target.value,
                        })
                      }
                    />
                    <span className="field-hint">
                      اتركه فارغاً ليُستخدم اسم المتجر.
                    </span>
                  </div>
                  <div className="form-group">
                    <label>الاسم القانوني (إنجليزي)</label>
                    <input
                      type="text"
                      dir="ltr"
                      placeholder="Hally Trading Est."
                      value={businessSettings.legalNameEn}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          legalNameEn: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                {/* ===== السجل التجاري ===== */}
                <div className="form-row">
                  <div className="form-group">
                    <label>رقم السجل التجاري</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="1010101010"
                      value={businessSettings.crNumber}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          crNumber: e.target.value.replace(/\D/g, ""),
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>الرقم الموحّد للمنشأة</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="7001234567"
                      value={businessSettings.unifiedNumber}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          unifiedNumber: e.target.value.replace(/\D/g, ""),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>رابط التحقق من السجل التجاري</label>
                  <input
                    type="url"
                    dir="ltr"
                    placeholder="https://cr.sbc.gov.sa/cr/1010101010"
                    value={businessSettings.crVerifyUrl}
                    onChange={(e) =>
                      setBusinessSettings({
                        ...businessSettings,
                        crVerifyUrl: e.target.value,
                      })
                    }
                  />
                  <span className="field-hint">
                    يُرسم رمز QR على الفاتورة، فيتحقّق المستلم من المنشأة
                    بمسحه. اتركه فارغاً ليُحذف الرمز.
                  </span>
                </div>

                {/* ===== العنوان ===== */}
                <div className="form-row">
                  <div className="form-group">
                    <label>العنوان على الفاتورة (عربي)</label>
                    <input
                      type="text"
                      value={businessSettings.addressAr}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          addressAr: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label>العنوان على الفاتورة (إنجليزي)</label>
                    <input
                      type="text"
                      dir="ltr"
                      value={businessSettings.addressEn}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          addressEn: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                {/* ===== ترقيم ونص الفاتورة ===== */}
                <div className="form-row">
                  <div className="form-group">
                    <label>بادئة رقم الفاتورة</label>
                    <input
                      type="text"
                      dir="ltr"
                      maxLength={6}
                      placeholder="HLY"
                      value={businessSettings.invoicePrefix}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          invoicePrefix: e.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, ""),
                        })
                      }
                    />
                    <span className="field-hint">
                      مثال: {businessSettings.invoicePrefix || "HLY"}-20261127-51932
                    </span>
                  </div>
                  <div className="form-group">
                    <label>ملاحظات أسفل الفاتورة</label>
                    <input
                      type="text"
                      placeholder="الإرجاع خلال ٣ أيام من التسليم."
                      value={businessSettings.invoiceNotes}
                      onChange={(e) =>
                        setBusinessSettings({
                          ...businessSettings,
                          invoiceNotes: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>

                {/* ===== الضريبة ===== */}
                <div className="settings-subsection">
                  <h3>ضريبة القيمة المضافة</h3>
                  <div className="form-group checkbox-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={businessSettings.vatEnabled}
                        onChange={(e) =>
                          setBusinessSettings({
                            ...businessSettings,
                            vatEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>تطبيق الضريبة وإظهارها على الفاتورة</span>
                    </label>
                    <span className="field-hint">
                      لا تُفعّلها قبل التسجيل في هيئة الزكاة والضريبة. إظهار
                      ضريبة بلا تسجيل مخالفة، ولذلك لا يُقبل التفعيل بدون رقم
                      ضريبي صحيح.
                    </span>
                  </div>

                  {businessSettings.vatEnabled && (
                    <>
                      <div className="form-row sub-setting">
                        <div className="form-group">
                          <label>الرقم الضريبي</label>
                          <input
                            type="text"
                            inputMode="numeric"
                            dir="ltr"
                            maxLength={15}
                            placeholder="300000000000003"
                            value={businessSettings.vatNumber}
                            onChange={(e) =>
                              setBusinessSettings({
                                ...businessSettings,
                                vatNumber: e.target.value.replace(/\D/g, ""),
                              })
                            }
                          />
                          <span
                            className={`field-hint${
                              businessSettings.vatNumber && !vatIsLegallyActive
                                ? " field-hint-error"
                                : ""
                            }`}
                          >
                            {businessSettings.vatNumber && !vatIsLegallyActive
                              ? "رقم غير صحيح: ١٥ رقماً يبدأ بـ ٣ وينتهي بـ ٣."
                              : "١٥ رقماً يبدأ بـ ٣ وينتهي بـ ٣."}
                          </span>
                        </div>
                        <div className="form-group">
                          <label>النسبة (%)</label>
                          <input
                            type="number"
                            min={0}
                            max={99}
                            step={0.5}
                            dir="ltr"
                            value={businessSettings.vatRate}
                            onChange={(e) =>
                              setBusinessSettings({
                                ...businessSettings,
                                vatRate: Number(e.target.value),
                              })
                            }
                          />
                          <span className="field-hint">
                            أسعار المتجر شاملة الضريبة، فالنسبة تُستخرج من
                            الإجمالي ولا تُضاف إليه — أي سعر معروض لا يتغيّر.
                          </span>
                        </div>
                      </div>
                      {!vatIsLegallyActive && (
                        <p className="settings-warning">
                          <AlertTriangle size={16} />
                          بدون رقم ضريبي صحيح تُحفظ النسبة صفراً، وتبقى
                          الفواتير «فاتورة» لا «فاتورة ضريبية مبسطة».
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "shipping" && (
            <div className="settings-card">
              <div className="card-header">
                <Truck size={22} />
                <h2>إعدادات الشحن</h2>
              </div>
              <div className="settings-form">
                <div className="form-group checkbox-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={shippingSettings.enableFreeShipping}
                      onChange={(e) =>
                        setShippingSettings({
                          ...shippingSettings,
                          enableFreeShipping: e.target.checked,
                        })
                      }
                    />
                    <span>تفعيل الشحن المجاني</span>
                  </label>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>الحد الأدنى للشحن المجاني (ر.س)</label>
                    <input
                      type="number"
                      value={shippingSettings.freeShippingThreshold}
                      onChange={(e) =>
                        setShippingSettings({
                          ...shippingSettings,
                          freeShippingThreshold: Number(e.target.value),
                        })
                      }
                      disabled={!shippingSettings.enableFreeShipping}
                    />
                  </div>
                  <div className="form-group">
                    <label>تكلفة الشحن الافتراضية (ر.س)</label>
                    <input
                      type="number"
                      value={shippingSettings.defaultShippingCost}
                      onChange={(e) =>
                        setShippingSettings({
                          ...shippingSettings,
                          defaultShippingCost: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>مدة التوصيل المتوقعة</label>
                  <input
                    type="text"
                    value={shippingSettings.estimatedDays}
                    onChange={(e) =>
                      setShippingSettings({
                        ...shippingSettings,
                        estimatedDays: e.target.value,
                      })
                    }
                    placeholder="مثال: 3-5 أيام"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Notification Settings */}
          {activeTab === "notifications" && (
            <div className="settings-card">
              <div className="card-header">
                <Bell size={22} />
                <h2>إعدادات الإشعارات</h2>
              </div>
              <div className="settings-form">
                <div className="form-group checkbox-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={notificationSettings.orderNotifications}
                      onChange={(e) =>
                        setNotificationSettings({
                          ...notificationSettings,
                          orderNotifications: e.target.checked,
                        })
                      }
                    />
                    <span>إشعارات الطلبات الجديدة</span>
                  </label>
                </div>
                <div className="form-group checkbox-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={notificationSettings.lowStockAlert}
                      onChange={(e) =>
                        setNotificationSettings({
                          ...notificationSettings,
                          lowStockAlert: e.target.checked,
                        })
                      }
                    />
                    <span>تنبيه انخفاض المخزون</span>
                  </label>
                </div>
                {notificationSettings.lowStockAlert && (
                  <div className="form-group sub-setting">
                    <label>الحد الأدنى للتنبيه</label>
                    <input
                      type="number"
                      value={notificationSettings.lowStockThreshold}
                      onChange={(e) =>
                        setNotificationSettings({
                          ...notificationSettings,
                          lowStockThreshold: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                )}
                <div className="form-group checkbox-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={notificationSettings.customerMessages}
                      onChange={(e) =>
                        setNotificationSettings({
                          ...notificationSettings,
                          customerMessages: e.target.checked,
                        })
                      }
                    />
                    <span>رسائل العملاء</span>
                  </label>
                </div>
                <div className="form-group checkbox-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={notificationSettings.marketingEmails}
                      onChange={(e) =>
                        setNotificationSettings({
                          ...notificationSettings,
                          marketingEmails: e.target.checked,
                        })
                      }
                    />
                    <span>رسائل تسويقية</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Payment Settings */}
          {activeTab === "payment" && (
            <div className="settings-card">
              <div className="card-header">
                <CreditCard size={22} />
                <h2>إعدادات الدفع</h2>
              </div>
              <div className="settings-form">
                <p className="settings-description">
                  اختر طرق الدفع المتاحة للعملاء في المتجر
                </p>
                <div className="payment-methods">
                  {paymentMethods.map((method) => (
                    <div key={method.id} className="payment-method">
                      <div className="method-info">
                        <span className="method-name">{method.name}</span>
                        <span className="method-desc">
                          {paymentMethodDescription(method.id)}
                          {/* التحويل البنكي يُخفى من الـ checkout بلا آيبان:
                              العميل بلا حساب يحوّل إليه. */}
                          {method.id === "bank" &&
                            method.enabled &&
                            !storeSettings.bankIban &&
                            " — لن تظهر للعملاء حتى تضيف رقم الآيبان في تبويب المتجر"}
                        </span>
                      </div>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={method.enabled}
                          onChange={() => togglePaymentMethod(method.id)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  ))}
                </div>

                {/* كتلتا تمارا وتابي اليدويتان حُذفتا: البوابتان الآن في
                    السجل أدناه ببطاقتيهما، عبر نفس المسار المتحقَّق منه
                    (اختبار اتصال حقيقي ثم مصالحة خادم-إلى-خادم). الدوال
                    القديمة tamaraSaveSettings/tabbySaveSettings ما زالت
                    منشورة لكن لا شيء يناديها، والمفاتيح المحفوظة سابقاً
                    تُقرأ كما هي بفضل التوافق الخلفي في loadGatewayCredentials. */}

                {storeUrlMissing && (
                  <div className="gateway-url-alert">
                    <AlertTriangle size={20} />
                    <div className="gateway-url-alert-body">
                      <strong>رابط المتجر غير مضبوط</strong>
                      <p>
                        بوابات الدفع تحتاجه لإعادة العميل بعد الدفع. بدونه
                        يفشل زرّ «تأكيد الطلب» عند اختيار أي بوابة، ولو كانت
                        متّصلة.
                      </p>
                      {originIsLocal ? (
                        <p className="gateway-url-alert-note">
                          أنت على نسخة محلية، فلا يصحّ حفظ هذا العنوان.
                          اضبط الرابط العام من تبويب «المتجر» ← رابط المتجر.
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleUseCurrentOrigin}
                      disabled={originIsLocal || savingStoreUrl}
                    >
                      {savingStoreUrl ? (
                        <Loader size={16} className="spin" />
                      ) : (
                        <span dir="ltr">{currentOrigin}</span>
                      )}
                      <span>استخدم هذا الرابط</span>
                    </button>
                  </div>
                )}

                {PAYMENT_GATEWAYS.map((gateway) => (
                  <GatewaySettingsCard key={gateway.id} gateway={gateway} />
                ))}
              </div>
            </div>
          )}

          {/* Email Settings */}
          {activeTab === "email" && (
            <div className="settings-card">
              <div className="card-header">
                <Mail size={22} />
                <h2>إعدادات البريد الإلكتروني</h2>
              </div>
              <p className="section-desc" style={{ marginBottom: "20px", color: "#5e6a67" }}>
                إعداد SMTP لإرسال إشعارات الطلبات للعملاء تلقائياً
              </p>
              <div className="settings-form">
                <div className="form-row">
                  <div className="form-group">
                    <label>خادم SMTP</label>
                    <input
                      type="text"
                      value={emailSettings.smtpHost}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, smtpHost: e.target.value })
                      }
                      placeholder="smtp.gmail.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>منفذ SMTP</label>
                    <input
                      type="number"
                      value={emailSettings.smtpPort}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, smtpPort: parseInt(e.target.value) || 587 })
                      }
                      placeholder="587"
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>اسم المستخدم / البريد</label>
                    <input
                      type="email"
                      value={emailSettings.smtpUser}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, smtpUser: e.target.value })
                      }
                      placeholder="your@email.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>كلمة مرور التطبيق</label>
                    <input
                      type="password"
                      value={emailSettings.smtpPassword}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, smtpPassword: e.target.value })
                      }
                      placeholder="••••••••••••••••"
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>بريد المرسل</label>
                    <input
                      type="email"
                      value={emailSettings.fromEmail}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, fromEmail: e.target.value })
                      }
                      placeholder="noreply@example.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>اسم المرسل</label>
                    <input
                      type="text"
                      value={emailSettings.fromName}
                      onChange={(e) =>
                        setEmailSettings({ ...emailSettings, fromName: e.target.value })
                      }
                      placeholder="حلال"
                    />
                  </div>
                </div>
                <div className="info-box" style={{ marginTop: "20px", padding: "15px", background: "#f0ece3", borderRadius: "8px" }}>
                  <h4 style={{ marginBottom: "10px", fontSize: "14px" }}>💡 إعدادات Gmail</h4>
                  <ul style={{ fontSize: "13px", color: "#5e6a67", paddingRight: "20px" }}>
                    <li>خادم SMTP: <code>smtp.gmail.com</code></li>
                    <li>المنفذ: <code>587</code></li>
                    <li>يجب تفعيل المصادقة الثنائية وإنشاء "كلمة مرور التطبيق" من حسابك</li>
                  </ul>
                </div>
                <div className="form-actions" style={{ marginTop: "20px" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      setEmailLoading(true);
                      try {
                        await updateEmailSettings(emailSettings);
                        alert("تم حفظ إعدادات البريد بنجاح");
                      } catch (error) {
                        console.error("Error saving email settings:", error);
                        alert("حدث خطأ أثناء الحفظ");
                      } finally {
                        setEmailLoading(false);
                      }
                    }}
                    disabled={emailLoading}
                  >
                    {emailLoading ? <Loader className="spinner" size={18} /> : <Save size={18} />}
                    حفظ إعدادات البريد
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Security Settings */}
          {activeTab === "security" && (
            <div className="settings-card">
              <div className="card-header">
                <Shield size={22} />
                <h2>إعدادات الأمان</h2>
              </div>
              <div className="settings-form">
                <div className="security-info">
                  <p>
                    <strong>البريد الإلكتروني:</strong> {user?.email}
                  </p>
                  <p>
                    <strong>الدور:</strong>{" "}
                    {user?.role === "admin" ? "مدير النظام" : "عميل"}
                  </p>
                  <p>
                    <strong>آخر تسجيل دخول:</strong> {lastLogin}
                  </p>
                </div>
                <div className="form-group">
                  <button
                    className="btn btn-outline"
                    onClick={() => setShowPasswordModal(true)}
                  >
                    تغيير كلمة المرور
                  </button>
                </div>
                <div className="form-group">
                  <button
                    className="btn btn-outline"
                    disabled
                    onClick={() => alert("هذه الميزة ستكون متاحة قريباً")}
                  >
                    تفعيل المصادقة الثنائية (قريباً)
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Password Change Modal */}
      {showPasswordModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowPasswordModal(false)}
        >
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>تغيير كلمة المرور</h2>
              <button
                className="close-btn"
                onClick={() => setShowPasswordModal(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={handleChangePassword}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">كلمة المرور الحالية</label>
                  <input
                    type="password"
                    className="form-input"
                    value={passwordForm.current}
                    onChange={(e) =>
                      setPasswordForm({
                        ...passwordForm,
                        current: e.target.value,
                      })
                    }
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">كلمة المرور الجديدة</label>
                  <input
                    type="password"
                    className="form-input"
                    value={passwordForm.newPass}
                    onChange={(e) =>
                      setPasswordForm({
                        ...passwordForm,
                        newPass: e.target.value,
                      })
                    }
                    required
                    minLength={6}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">تأكيد كلمة المرور</label>
                  <input
                    type="password"
                    className="form-input"
                    value={passwordForm.confirm}
                    onChange={(e) =>
                      setPasswordForm({
                        ...passwordForm,
                        confirm: e.target.value,
                      })
                    }
                    required
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setShowPasswordModal(false)}
                  disabled={passwordLoading}
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={passwordLoading}
                >
                  {passwordLoading ? (
                    <Loader className="spinner" size={18} />
                  ) : (
                    "تغيير كلمة المرور"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
