import React, { useState, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  MapPin,
  CreditCard,
  Truck,
  ShoppingBag,
  ArrowRight,
  Check,
  Loader,
  AlertCircle,
  Store,
} from "lucide-react";
import { useStore } from "../../store/useStore";
import { addOrder, getSettings } from "../../services/firestore";
import Header from "../../components/Header/Header";
import Footer from "../../components/Footer/Footer";
import { useToast } from "../../components/Toast/Toast";
import PaymentMethodMedia from "../../components/PaymentMethodMedia/PaymentMethodMedia";
import {
  HIDDEN_METHOD_IDS,
  MANUAL_METHOD_IDS,
  PAYMENT_GATEWAYS,
  isGatewayId,
  paymentMethodDescription,
} from "../../constants/paymentGateways";
import type { PublicGatewayStatusMap } from "../../constants/paymentGateways";
import { createGatewayCheckout } from "../../services/paymentGateways";
import "./Checkout.css";

interface ShippingSettings {
  freeShippingThreshold: number;
  defaultShippingCost: number;
  enableFreeShipping: boolean;
  estimatedDays: string;
}

interface PaymentMethod {
  id: string;
  name: string;
  enabled: boolean;
}

// الطرق اليدوية التي ينفّذها المتجر بنفسه، وسلوكها لم يتغيّر.
// بوابات الدفع (MIS Pay / Madfu / neoleap) تأتي من السجل ولا تظهر إلا بعد
// أن يسجّل الخادم نجاح اختبار اتصال حقيقي — انظر gatewayFilter أدناه.
const ALLOWED_METHOD_IDS = MANUAL_METHOD_IDS;

const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = [
  { id: "cash", name: "الدفع عند الاستلام", enabled: true },
  { id: "bank", name: "التحويل البنكي", enabled: true },
  { id: "emkan", name: "إمكان - قسّمها على 5", enabled: true },
];

const Checkout: React.FC = () => {
  const navigate = useNavigate();
  const { cart, user, clearCart, getCartTotal, storeInfo } = useStore();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);
  const [orderPlaced, setOrderPlaced] = useState(false);
  const [shippingSettings, setShippingSettings] = useState<ShippingSettings>({
    freeShippingThreshold: 200,
    defaultShippingCost: 25,
    enableFreeShipping: true,
    estimatedDays: "3-5",
  });
  // الطرق اليدوية المحفوظة في الإعدادات
  const [manualMethods, setManualMethods] = useState<PaymentMethod[]>(
    DEFAULT_PAYMENT_METHODS
  );
  // الحالة العامة للبوابات، كما يكتبها الخادم في settings/store
  const [gatewayStatus, setGatewayStatus] = useState<PublicGatewayStatusMap>({});

  const [formData, setFormData] = useState({
    fullName: "",
    phone: "",
    city: "",
    district: "",
    street: "",
    building: "",
    nationalAddress: "",
    notes: "",
    paymentMethod: "cash",
    // طريقة الاستلام: توصيل للعنوان أو استلام من الفرع
    fulfillment: "delivery" as "delivery" | "pickup",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // يجب تسجيل الدخول قبل الوصول للدفع
  useEffect(() => {
    if (!user) {
      navigate("/login?redirect=/checkout", { replace: true });
    }
  }, [user, navigate]);

  // جلب الإعدادات من Firestore
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await getSettings();
        if (settings) {
          if (settings.shipping) {
            setShippingSettings(settings.shipping);
          }
          // قراءة طرق الدفع المفعّلة من الإعدادات، مع حصرها في المسموح بها
          // وإضافة إمكان إن لم تكن موجودة.
          if (settings.payment?.methods && settings.payment.methods.length > 0) {
            const allowed = settings.payment.methods.filter((m: PaymentMethod) =>
              (ALLOWED_METHOD_IDS as readonly string[]).includes(m.id)
            );
            if (!allowed.some((m: PaymentMethod) => m.id === "emkan")) {
              allowed.push({
                id: "emkan",
                name: "إمكان - قسّمها على 5",
                enabled: true,
              });
            }
            if (allowed.length > 0) {
              setManualMethods(allowed);
            }
          }
          // النسخة العامة الخالية من الأسرار. تُقرأ هنا في كل زيارة ولا
          // تمرّ عبر zustand: المخزن يستخدم persist، فبوابة أُلغي اتصالها
          // كانت ستبقى ظاهرة لزائر عائد من الـ localStorage.
          setGatewayStatus(
            (settings as { paymentGateways?: PublicGatewayStatusMap })
              .paymentGateways || {},
          );
        }
      } catch (error) {
        console.error("Error fetching settings:", error);
      }
    };
    fetchSettings();
  }, []);

  // تعبئة بيانات المستخدم
  useEffect(() => {
    if (user) {
      setFormData((prev) => ({
        ...prev,
        fullName: user.name || "",
        phone: user.phone || "",
        city: user.addresses?.[0]?.city || "",
        district: user.addresses?.[0]?.district || "",
        street: user.addresses?.[0]?.street || "",
        building: user.addresses?.[0]?.building || "",
        nationalAddress: user.addresses?.[0]?.nationalAddress || "",
      }));
    }
  }, [user]);

  // التحقق من السلة (فقط للمستخدم المسجّل؛ غير المسجّل يُوجَّه لتسجيل الدخول أولاً)
  useEffect(() => {
    if (user && cart.length === 0 && !orderPlaced) {
      navigate("/cart");
    }
  }, [user, cart, navigate, orderPlaced]);

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("ar-SA", {
      style: "currency",
      currency: "SAR",
    }).format(price);
  };

  const subtotal = getCartTotal();
  const isPickup = formData.fulfillment === "pickup";
  const shipping = isPickup
    ? 0
    : shippingSettings.enableFreeShipping &&
        subtotal >= shippingSettings.freeShippingThreshold
      ? 0
      : shippingSettings.defaultShippingCost;
  const total = subtotal + shipping;

  /**
   * طرق الدفع المعروضة للعميل.
   *
   * البوابة تظهر فقط إذا توفّرت كل هذه الشروط معاً:
   *   عضوية السجل ∧ ليست في قائمة المُخفاة ∧ connected من الخادم ∧ مفعّلة
   *   ∧ إجمالي السلة ≥ الحد الأدنى للمزوّد.
   *
   * تمارا/تابي/باي بال تبقى مخفيّة لسببين مستقلّين — وجودها في
   * HIDDEN_METHOD_IDS *وعدم* وجود وصف لها في السجل — فتعديل قائمة واحدة لا
   * يُعيدها بالخطأ. والاعتماد على settings.payment.methods وحدها كان سيُظهرها
   * لحظة أن يبدّل الأدمن مفتاحها في اللوحة.
   */
  const paymentMethods = useMemo<PaymentMethod[]>(() => {
    const manual = manualMethods.filter(
      (m) =>
        (ALLOWED_METHOD_IDS as readonly string[]).includes(m.id) &&
        m.enabled &&
        // التحويل البنكي بلا آيبان يترك العميل بلا حساب يحوّل إليه.
        // الشرط هنا لا في الـ JSX: لو بقي في الرسم فقط لاختار الأثر أدناه
        // "bank" كطريقة افتراضية ثم أخفاها الرسم، فلا يظهر شيء مُحدَّداً.
        (m.id !== "bank" || !!storeInfo.bankIban),
    );

    const gateways = PAYMENT_GATEWAYS.filter(
      (g) => !(HIDDEN_METHOD_IDS as readonly string[]).includes(g.id),
    )
      .map((g) => ({ gateway: g, status: gatewayStatus[g.id] }))
      // enabled المفقود يعني "مُفعّلة": هذا هو نفس العرف في لوحة التحكم
      // (data.enabled !== false)، وبدونه تختفي بوابة متّصلة لم يُلمس مفتاحها.
      .filter(({ status }) => status?.connected && status?.enabled !== false)
      // الحد الأدنى تجاري لا تجميلي: سلة بـ ٩٠ ر.س تُظهر شعار MIS Pay ثم
      // تفشل عند المزوّد هي طلب مفقود.
      .filter(
        ({ gateway }) =>
          !gateway.minAmountSAR || total >= gateway.minAmountSAR,
      )
      .map(({ gateway }) => ({
        id: gateway.id,
        name: gateway.name,
        enabled: true,
      }));

    return [...manual, ...gateways];
  }, [manualMethods, gatewayStatus, total, storeInfo.bankIban]);

  // إن اختفت الطريقة المختارة (نزل الإجمالي تحت الحد، أو عُطّلت البوابة)
  // نرجع إلى أول طريقة متاحة بدل إرسال طريقة لم تعد معروضة.
  useEffect(() => {
    if (paymentMethods.length === 0) return;
    if (!paymentMethods.some((m) => m.id === formData.paymentMethod)) {
      setFormData((prev) => ({
        ...prev,
        paymentMethod: paymentMethods[0].id,
      }));
    }
  }, [paymentMethods, formData.paymentMethod]);

  const validateStep1 = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.fullName.trim()) newErrors.fullName = "الاسم مطلوب";
    if (!formData.phone.trim()) newErrors.phone = "رقم الجوال مطلوب";
    else if (!/^05\d{8}$/.test(formData.phone))
      newErrors.phone = "رقم جوال غير صحيح";
    if (formData.fulfillment === "delivery") {
      if (!formData.city.trim()) newErrors.city = "المدينة مطلوبة";
      if (!formData.district.trim()) newErrors.district = "الحي مطلوب";
      if (!formData.street.trim()) newErrors.street = "الشارع مطلوب";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNextStep = () => {
    if (step === 1 && validateStep1()) {
      setStep(2);
    }
  };

  const handleSubmitOrder = async () => {
    if (!user) {
      navigate("/login?redirect=/checkout");
      return;
    }

    setLoading(true);

    try {
      // التحقق من توفر المخزون قبل إرسال الطلب
      const { products } = useStore.getState();
      const stockErrors: string[] = [];
      for (const item of cart) {
        const currentProduct = products.find((p) => p.id === item.product.id);
        if (currentProduct && currentProduct.stock < item.quantity) {
          stockErrors.push(
            `${item.product.name}: متوفر ${currentProduct.stock} فقط (طلبت ${item.quantity})`,
          );
        }
      }
      if (stockErrors.length > 0) {
        showToast(
          "بعض المنتجات غير متوفرة بالكمية المطلوبة:\n" +
            stockErrors.join("\n"),
          "error"
        );
        setLoading(false);
        return;
      }

      const shippingAddressText = isPickup
        ? `استلام من الفرع${storeInfo.storeAddress ? `: ${storeInfo.storeAddress}` : ""}`
        : `${formData.city}، ${formData.district}، ${formData.street}${formData.building ? `، مبنى ${formData.building}` : ""}${formData.nationalAddress ? `، العنوان الوطني: ${formData.nationalAddress}` : ""}`;

      // ===== مسار بوابة الدفع =====
      // لا يُنشأ مستند الطلب هنا: onOrderCreated يخصم المخزون ويُرسل
      // "تم استلام طلبك"، فطلب يُكتب قبل الدفع يعني رسالة تأكيد لسلّة قد لا
      // تُدفع ومخزوناً يُستهلك مع كل تحويل مهجور. الخادم يحفظ مسوّدة الطلب
      // في pending_payments، وينشئ الطلب بعد تأكيد الدفع فقط.
      if (isGatewayId(formData.paymentMethod)) {
        const { redirectUrl, orderRef } = await createGatewayCheckout({
          gateway: formData.paymentMethod,
          // للتحقق فقط: الخادم يعيد حساب الأسعار من مستندات المنتجات
          items: cart.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
          })),
          total,
          customer: formData.fullName,
          email: user.email,
          phone: formData.phone,
          fulfillment: formData.fulfillment,
          shippingAddress: shippingAddressText,
          address: {
            city: isPickup ? "" : formData.city,
            district: isPickup ? "" : formData.district,
            street: isPickup ? "" : formData.street,
            building: isPickup ? "" : formData.building,
            nationalAddress: isPickup ? "" : formData.nationalAddress,
          },
          notes: formData.notes,
        });

        // السلّة تبقى كما هي: من يُلغي عند المزوّد يعود ويجدها.
        // صفحة العودة هي التي تُفرغها بعد تأكيد الدفع.
        sessionStorage.setItem(
          "pendingGatewayPayment",
          JSON.stringify({ gateway: formData.paymentMethod, orderRef }),
        );
        window.location.assign(redirectUrl);
        return;
      }

      const isEmkan = formData.paymentMethod === "emkan";

      const orderData = {
        userId: user.id,
        customer: formData.fullName,
        email: user.email,
        phone: formData.phone,
        items: cart.map((item) => ({
          productId: item.product.id,
          name: item.product.name,
          quantity: item.quantity,
          price: item.product.price,
          image: item.product.images[0] || "",
        })),
        total: total,
        subtotal: subtotal,
        shippingCost: shipping,
        status: "pending" as const,
        paymentMethod: formData.paymentMethod,
        // إمكان: الطلب معلّق حتى يدفع العميل عبر الرابط الذي يرسله المتجر.
        ...(isEmkan ? { paymentStatus: "pending" as const } : {}),
        fulfillment: formData.fulfillment,
        shippingAddress: shippingAddressText,

        address: {
          fullName: formData.fullName,
          phone: formData.phone,
          city: isPickup ? "" : formData.city,
          district: isPickup ? "" : formData.district,
          street: isPickup ? "" : formData.street,
          building: isPickup ? "" : formData.building,
          nationalAddress: isPickup ? "" : formData.nationalAddress,
        },
        notes: formData.notes,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // المخزون يُخصم على الخادم داخل onOrderCreated (معاملة ذرية).
      // كما يُرسل onOrderCreated تنبيهاً لصاحب المتجر عبر Resend لطلبات إمكان.
      const newOrderId = await addOrder(orderData);

      setOrderPlaced(true);
      clearCart();
      setStep(3);
      navigate(`/order-confirmation/${newOrderId}`, { replace: true });
    } catch (error) {
      console.error("Error creating order:", error);
      showToast("حدث خطأ أثناء إنشاء الطلب. يرجى المحاولة مرة أخرى.", "error");
    } finally {
      setLoading(false);
    }
  };

  // صفحة تسجيل الدخول إذا لم يكن هناك مستخدم (احتياطي؛ يتم التوجيه تلقائياً)
  if (!user) {
    return (
      <>
        <Header />
        <div className="checkout-page">
          <div className="container">
            <div className="login-required">
              <AlertCircle size={60} />
              <h2>يجب تسجيل الدخول أولاً</h2>
              <p>قم بتسجيل الدخول لإتمام عملية الشراء</p>
              <Link
                to="/login?redirect=/checkout"
                className="btn btn-primary btn-lg"
              >
                تسجيل الدخول
              </Link>
            </div>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="checkout-page">
        <div className="container">
          {/* خطوات الطلب */}
          <div className="checkout-steps">
            <div
              className={`step ${step >= 1 ? "active" : ""} ${step > 1 ? "completed" : ""}`}
            >
              <span className="step-number">
                {step > 1 ? <Check size={16} /> : "1"}
              </span>
              <span className="step-label">الاستلام</span>
            </div>
            <div className="step-line"></div>
            <div
              className={`step ${step >= 2 ? "active" : ""} ${step > 2 ? "completed" : ""}`}
            >
              <span className="step-number">
                {step > 2 ? <Check size={16} /> : "2"}
              </span>
              <span className="step-label">الدفع</span>
            </div>
            <div className="step-line"></div>
            <div className={`step ${step >= 3 ? "active" : ""}`}>
              <span className="step-number">3</span>
              <span className="step-label">التأكيد</span>
            </div>
          </div>

          {step < 3 && (
            <div className="checkout-content">
              {/* الخطوة 1: العنوان */}
              {step === 1 && (
                <div className="checkout-form">
                  <div className="form-card">
                    <div className="card-header">
                      <MapPin size={22} />
                      <h2>{isPickup ? "بيانات المستلم" : "عنوان التوصيل"}</h2>
                    </div>
                    <div className="form-body">
                      {/* طريقة الاستلام: توصيل أو استلام من الفرع */}
                      <div className="payment-options fulfillment-options">
                        <label className="payment-option">
                          <input
                            type="radio"
                            name="fulfillment"
                            value="delivery"
                            checked={formData.fulfillment === "delivery"}
                            onChange={() =>
                              setFormData({
                                ...formData,
                                fulfillment: "delivery",
                              })
                            }
                          />
                          <div className="option-content">
                            <Truck size={24} />
                            <div>
                              <strong>توصيل إلى العنوان</strong>
                              <span>
                                التوصيل خلال {shippingSettings.estimatedDays}{" "}
                                أيام عمل
                              </span>
                            </div>
                          </div>
                        </label>
                        <label className="payment-option">
                          <input
                            type="radio"
                            name="fulfillment"
                            value="pickup"
                            checked={formData.fulfillment === "pickup"}
                            onChange={() =>
                              setFormData({
                                ...formData,
                                fulfillment: "pickup",
                              })
                            }
                          />
                          <div className="option-content">
                            <Store size={24} />
                            <div>
                              <strong>استلام من الفرع</strong>
                              <span>
                                بدون رسوم شحن
                                {storeInfo.storeAddress
                                  ? ` — ${storeInfo.storeAddress}`
                                  : ""}
                              </span>
                            </div>
                          </div>
                        </label>
                      </div>

                      <div className="form-row">
                        <div className="form-group">
                          <label>الاسم الكامل *</label>
                          <input
                            type="text"
                            value={formData.fullName}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                fullName: e.target.value,
                              })
                            }
                            placeholder="الاسم الكامل"
                            className={errors.fullName ? "error" : ""}
                          />
                          {errors.fullName && (
                            <span className="error-text">
                              {errors.fullName}
                            </span>
                          )}
                        </div>
                        <div className="form-group">
                          <label>رقم الجوال *</label>
                          <input
                            type="tel"
                            value={formData.phone}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                phone: e.target.value,
                              })
                            }
                            placeholder="05xxxxxxxx"
                            className={errors.phone ? "error" : ""}
                          />
                          {errors.phone && (
                            <span className="error-text">{errors.phone}</span>
                          )}
                        </div>
                      </div>
                      {!isPickup && (
                        <>
                      <div className="form-row">
                        <div className="form-group">
                          <label>المدينة *</label>
                          <input
                            type="text"
                            value={formData.city}
                            onChange={(e) =>
                              setFormData({ ...formData, city: e.target.value })
                            }
                            placeholder="مثال: الرياض"
                            className={errors.city ? "error" : ""}
                          />
                          {errors.city && (
                            <span className="error-text">{errors.city}</span>
                          )}
                        </div>
                        <div className="form-group">
                          <label>الحي *</label>
                          <input
                            type="text"
                            value={formData.district}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                district: e.target.value,
                              })
                            }
                            placeholder="مثال: حي النرجس"
                            className={errors.district ? "error" : ""}
                          />
                          {errors.district && (
                            <span className="error-text">
                              {errors.district}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="form-row">
                        <div className="form-group">
                          <label>الشارع *</label>
                          <input
                            type="text"
                            value={formData.street}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                street: e.target.value,
                              })
                            }
                            placeholder="اسم الشارع"
                            className={errors.street ? "error" : ""}
                          />
                          {errors.street && (
                            <span className="error-text">{errors.street}</span>
                          )}
                        </div>
                        <div className="form-group">
                          <label>رقم المبنى (اختياري)</label>
                          <input
                            type="text"
                            value={formData.building}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                building: e.target.value,
                              })
                            }
                            placeholder="رقم المبنى أو الشقة"
                          />
                        </div>
                      </div>
                      <div className="form-group">
                        <label>العنوان الوطني (اختياري)</label>
                        <input
                          type="text"
                          value={formData.nationalAddress}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              nationalAddress: e.target.value,
                            })
                          }
                          placeholder="مثال: RRRD2929"
                        />
                      </div>
                        </>
                      )}
                      <div className="form-group">
                        <label>ملاحظات إضافية (اختياري)</label>
                        <textarea
                          value={formData.notes}
                          onChange={(e) =>
                            setFormData({ ...formData, notes: e.target.value })
                          }
                          placeholder={
                            isPickup
                              ? "أي تعليمات خاصة للاستلام..."
                              : "أي تعليمات خاصة للتوصيل..."
                          }
                          rows={3}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="form-actions">
                    <Link to="/cart" className="btn btn-outline">
                      <ArrowRight size={18} />
                      العودة للسلة
                    </Link>
                    <button
                      className="btn btn-primary"
                      onClick={handleNextStep}
                    >
                      التالي: طريقة الدفع
                    </button>
                  </div>
                </div>
              )}

              {/* الخطوة 2: الدفع */}
              {step === 2 && (
                <div className="checkout-form">
                  <div className="form-card">
                    <div className="card-header">
                      <CreditCard size={22} />
                      <h2>طريقة الدفع</h2>
                    </div>
                    <div className="form-body">
                      <div className="fulfillment-summary">
                        {isPickup ? <Store size={18} /> : <Truck size={18} />}
                        <span>
                          {isPickup
                            ? `استلام من الفرع${storeInfo.storeAddress ? ` — ${storeInfo.storeAddress}` : ""}`
                            : "توصيل إلى العنوان الذي أدخلته"}
                        </span>
                        <button
                          type="button"
                          className="change-fulfillment"
                          onClick={() => setStep(1)}
                        >
                          تغيير
                        </button>
                      </div>

                      {paymentMethods.length === 0 && (
                        <div className="payment-empty">
                          <AlertCircle size={18} aria-hidden="true" />
                          <span>
                            لا توجد طريقة دفع مفعّلة حالياً. تواصل مع المتجر
                            لإتمام طلبك.
                          </span>
                        </div>
                      )}

                      <div className="payment-options">
                        {paymentMethods.map((method) => (
                            <label key={method.id} className="payment-option">
                              <input
                                type="radio"
                                name="paymentMethod"
                                value={method.id}
                                checked={formData.paymentMethod === method.id}
                                onChange={(e) =>
                                  setFormData({
                                    ...formData,
                                    paymentMethod: e.target.value,
                                  })
                                }
                              />
                              <div className="option-content">
                                {/* الدفع عند الاستلام وحده يغيّر أيقونته
                                    حسب التوصيل أو الاستلام من الفرع؛ بقية
                                    الطرق (والبوابات بشعاراتها) من السجل. */}
                                {method.id === "cash" ? (
                                  <span className="payment-logo-wrap">
                                    {isPickup ? (
                                      <Store size={24} aria-hidden="true" />
                                    ) : (
                                      <Truck size={24} aria-hidden="true" />
                                    )}
                                  </span>
                                ) : (
                                  <PaymentMethodMedia
                                    methodId={method.id}
                                    size={24}
                                  />
                                )}
                                <div>
                                  <strong>{method.name}</strong>
                                  <span>
                                    {method.id === "cash"
                                      ? isPickup
                                        ? "ادفع نقداً عند استلام طلبك من الفرع"
                                        : "ادفع نقداً عند استلام طلبك"
                                      : paymentMethodDescription(method.id)}
                                  </span>
                                </div>
                              </div>
                            </label>
                          ))}
                      </div>

                      {formData.paymentMethod === "bank" && (
                        <div className="bank-details">
                          <h4>بيانات الحساب البنكي</h4>
                          {storeInfo.bankName && (
                            <p>
                              <strong>البنك:</strong> {storeInfo.bankName}
                            </p>
                          )}
                          <p>
                            <strong>اسم الحساب:</strong>{" "}
                            {storeInfo.storeName || "حلال"}
                          </p>
                          <p>
                            <strong>رقم الآيبان:</strong>{" "}
                            {storeInfo.bankIban}
                          </p>
                          <p className="note">
                            يرجى إرسال إيصال التحويل عبر الواتساب
                          </p>
                        </div>
                      )}

                      {formData.paymentMethod === "emkan" && (
                        <div className="emkan-details">
                          <div className="emkan-info">
                            <h4>قسّمها على 5 دفعات مع إمكان</h4>
                            <div className="emkan-installments">
                              {[
                                "الدفعة 1",
                                "الدفعة 2",
                                "الدفعة 3",
                                "الدفعة 4",
                                "الدفعة 5",
                              ].map((label) => (
                                <div className="installment" key={label}>
                                  <span className="label">{label}</span>
                                  <span className="amount">
                                    {formatPrice(total / 5)}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="emkan-note">
                              عند تأكيد الطلب سيُسجَّل كطلب قيد الانتظار،
                              وسيتواصل معك المتجر عبر واتساب لإرسال رابط الدفع
                              حتى تكمل التقسيط على 5 دفعات عبر إمكان.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="form-actions">
                    <button
                      className="btn btn-outline"
                      onClick={() => setStep(1)}
                      disabled={loading}
                    >
                      <ArrowRight size={18} />
                      السابق
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleSubmitOrder}
                      disabled={loading}
                    >
                      {loading ? (
                        <>
                          <Loader className="spinner" size={18} />
                          {isGatewayId(formData.paymentMethod)
                            ? "جاري تحويلك لبوابة الدفع..."
                            : "جاري إرسال الطلب..."}
                        </>
                      ) : isGatewayId(formData.paymentMethod) ? (
                        `المتابعة للدفع - ${formatPrice(total)}`
                      ) : formData.paymentMethod === "emkan" ? (
                        `تأكيد الطلب (قيد الانتظار) - ${formatPrice(total)}`
                      ) : (
                        `تأكيد الطلب - ${formatPrice(total)}`
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* ملخص الطلب */}
              <div className="order-summary">
                <h3>ملخص الطلب</h3>
                <div className="summary-items">
                  {cart.map((item) => (
                    <div key={item.product.id} className="summary-item">
                      <img
                        src={
                          item.product.images?.[0] ||
                          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' fill='%23ece9e3'/%3E%3Cpath d='M28 82l22-28 15 17 11-13 16 24z' fill='%23c9c6bd'/%3E%3Ccircle cx='44' cy='42' r='9' fill='%23c9c6bd'/%3E%3C/svg%3E"
                        }
                        alt={item.product.name}
                      />
                      <div className="item-info">
                        <span className="item-name">{item.product.name}</span>
                        <span className="item-qty">
                          الكمية: {item.quantity}
                        </span>
                      </div>
                      <span className="item-price">
                        {formatPrice(item.product.price * item.quantity)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="summary-totals">
                  <div className="summary-row">
                    <span>المجموع الفرعي</span>
                    <span>{formatPrice(subtotal)}</span>
                  </div>
                  <div className="summary-row">
                    <span>الشحن</span>
                    <span className={shipping === 0 ? "free" : ""}>
                      {isPickup
                        ? "استلام من الفرع"
                        : shipping === 0
                          ? "مجاني"
                          : formatPrice(shipping)}
                    </span>
                  </div>
                  <div className="summary-row total">
                    <span>الإجمالي</span>
                    <span>{formatPrice(total)}</span>
                  </div>
                </div>
                <div className="shipping-info">
                  {isPickup ? <Store size={18} /> : <Truck size={18} />}
                  <span>
                    {isPickup
                      ? `الاستلام من الفرع${storeInfo.storeAddress ? `: ${storeInfo.storeAddress}` : ""} — سنتواصل معك عند جهوز الطلب`
                      : `التوصيل خلال ${shippingSettings.estimatedDays} أيام عمل`}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* الخطوة 3: التأكيد */}
          {step === 3 && (
            <div className="order-success">
              <div className="success-icon">
                <Check size={60} />
              </div>
              <h1>تم استلام طلبك بنجاح!</h1>
              <p>شكراً لك على طلبك. سنتواصل معك قريباً لتأكيد الطلب.</p>

              <div className="order-actions">
                <Link to="/account" className="btn btn-primary">
                  <ShoppingBag size={18} />
                  تتبع طلباتي
                </Link>
                <Link to="/products" className="btn btn-outline">
                  متابعة التسوق
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
};

export default Checkout;
