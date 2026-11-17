/**
 * صفحة العودة من بوابة الدفع: /payment/return/:gateway?ref=<orderRef>
 *
 * هذه الصفحة لا تقرّر شيئاً. تنادي الخادم، والخادم يستعلم من المزوّد
 * خادماً إلى خادم. رابط العودة قناة يتحكّم بها متصفّح العميل، فلا يصلح
 * دليلاً على السداد.
 *
 * تعمل حتى لو ضاع إشعار المزوّد وضاعت حمولة العودة معاً: المصالحة نفسها
 * يناديها الـ webhook والمسح الدوري أيضاً، وكلها متكافئة.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertCircle, Loader, XCircle } from "lucide-react";

import Header from "../../components/Header/Header";
import Footer from "../../components/Footer/Footer";
import { useStore } from "../../store/useStore";
import { GATEWAY_BY_ID, isGatewayId } from "../../constants/paymentGateways";
import { resolveGatewayReturn } from "../../services/paymentGateways";
import type { ResolveReturnResult } from "../../services/paymentGateways";
import "./PaymentReturn.css";

/** عدد محاولات الاستعلام عندما يكون الدفع "قيد المعالجة" عند المزوّد. */
const MAX_POLLS = 5;
const POLL_DELAY_MS = 2000;

type Phase = "checking" | "pending" | "failed" | "error";

const PaymentReturn: React.FC = () => {
  const { gateway: gatewayParam } = useParams<{ gateway: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { clearCart, user } = useStore();

  // المرجع من رابط العودة، أو من الجلسة إن جرّدته البوابة
  const orderRef =
    searchParams.get("ref") ||
    (() => {
      try {
        const raw = sessionStorage.getItem("pendingGatewayPayment");
        return raw ? (JSON.parse(raw).orderRef as string) : "";
      } catch {
        return "";
      }
    })();

  const gatewayId = isGatewayId(gatewayParam) ? gatewayParam : null;
  const descriptor = gatewayId ? GATEWAY_BY_ID[gatewayId] : undefined;
  const linkUsable = !!gatewayId && !!orderRef;

  // رابط ناقص حالة معروفة وقت الرسم، فلا تحتاج أثراً (effect) ليضبطها.
  const [phase, setPhase] = useState<Phase>(
    linkUsable ? "checking" : "error",
  );
  const [message, setMessage] = useState(
    linkUsable
      ? "جارٍ تأكيد الدفع…"
      : "رابط العودة غير مكتمل. راجع طلباتك في حسابك.",
  );
  const cancelled = useRef(false);

  const finishPaid = useCallback(
    (orderId: string) => {
      sessionStorage.removeItem("pendingGatewayPayment");
      // السلّة تُفرَغ هنا فقط: من ألغى الدفع يعود ويجد سلّته كما كانت.
      clearCart();
      navigate(`/order-confirmation/${orderId}`, { replace: true });
    },
    [clearCart, navigate],
  );

  const check = useCallback(async () => {
    if (!gatewayId || !orderRef) return;

    // حلقة صريحة بدل استدعاء ذاتي: بعض المزوّدين يُرجعون "قيد المعالجة"
    // لثوانٍ بعد نجاح الدفع فعلاً.
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      if (cancelled.current) return;

      try {
        const result: ResolveReturnResult = await resolveGatewayReturn(
          gatewayId,
          orderRef,
        );

        if (cancelled.current) return;

        if (result.state === "paid" && result.orderId) {
          finishPaid(result.orderId);
          return;
        }

        if (result.state !== "pending") {
          setPhase("failed");
          setMessage(result.message);
          sessionStorage.removeItem("pendingGatewayPayment");
          return;
        }

        if (attempt < MAX_POLLS - 1) {
          setMessage("جارٍ تأكيد الدفع مع المزوّد…");
          await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
        }
      } catch (error) {
        if (cancelled.current) return;
        console.error("PaymentReturn: فشل تأكيد الدفع", error);
        setPhase("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "تعذّر التحقق من حالة الدفع. راجع طلباتك في حسابك.",
        );
        return;
      }
    }

    if (cancelled.current) return;
    setPhase("pending");
    setMessage(
      "لم يصل تأكيد الدفع بعد. إن كان المبلغ قد خُصم فسيُسجّل طلبك " +
        "تلقائياً خلال دقائق، وستجده في طلباتك.",
    );
  }, [gatewayId, orderRef, finishPaid]);

  useEffect(() => {
    if (!linkUsable) return;
    cancelled.current = false;
    // هذا هو الاستثناء الذي تصفه القاعدة نفسها: الأثر يشترك مع نظام خارجي
    // (نداء الخادم الذي يستعلم من المزوّد) ويضبط الحالة في ردّه. لا setState
    // متزامن هنا — أول setState يقع بعد await — لكن القاعدة تتبع الدالة
    // ساكنياً فتراه. لا بديل: الحالة لا تُعرف إلا بالسؤال.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    return () => {
      cancelled.current = true;
    };
  }, [check, linkUsable]);

  // تأكيد الدفع يحتاج جلسة: الخادم يتحقّق أن الدفع يخصّ هذا المستخدم.
  // الوجهة تُرمّز بالكامل: بدون الترميز يُقرأ ?ref= كمعامل منفصل لصفحة
  // الدخول فيضيع المرجع. (والمرجع محفوظ في الجلسة أيضاً كشبكة أمان.)
  useEffect(() => {
    if (!user) {
      const target = `/payment/return/${gatewayParam || ""}${
        orderRef ? `?ref=${encodeURIComponent(orderRef)}` : ""
      }`;
      navigate(`/login?redirect=${encodeURIComponent(target)}`, {
        replace: true,
      });
    }
  }, [user, navigate, gatewayParam, orderRef]);

  const providerName = descriptor?.name || "بوابة الدفع";

  return (
    <>
      <Header />
      <main className="payment-return-page">
        <div className="container">
          <div className={`payment-return-card phase-${phase}`}>
            {phase === "checking" ? (
              <Loader className="spinner" size={44} aria-hidden="true" />
            ) : phase === "pending" ? (
              <AlertCircle size={44} aria-hidden="true" />
            ) : phase === "failed" ? (
              <XCircle size={44} aria-hidden="true" />
            ) : (
              <AlertCircle size={44} aria-hidden="true" />
            )}

            <h1>
              {phase === "checking"
                ? "جارٍ تأكيد الدفع"
                : phase === "pending"
                  ? "الدفع قيد التأكيد"
                  : phase === "failed"
                    ? "لم تكتمل عملية الدفع"
                    : "تعذّر التحقق من الدفع"}
            </h1>

            <p className="payment-return-message">{message}</p>
            <p className="payment-return-provider">المزوّد: {providerName}</p>

            {phase !== "checking" && (
              <div className="payment-return-actions">
                {phase === "failed" && (
                  <Link to="/checkout" className="btn btn-primary">
                    العودة لإتمام الطلب
                  </Link>
                )}
                <Link to="/account" className="btn btn-outline">
                  طلباتي
                </Link>
                {phase === "pending" && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setPhase("checking");
                      setMessage("جارٍ تأكيد الدفع…");
                      void check();
                    }}
                  >
                    تحقّق مرة أخرى
                  </button>
                )}
              </div>
            )}

            {phase === "failed" && (
              <p className="payment-return-hint">
                سلّتك ما زالت محفوظة كما هي.
              </p>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
};

export default PaymentReturn;
