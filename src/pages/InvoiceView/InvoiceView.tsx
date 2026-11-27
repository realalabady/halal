import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, FileWarning, Loader, Printer } from "lucide-react";
import { getDoc } from "firebase/firestore";
import { storeDoc } from "../../config/store";
import { useStore } from "../../store/useStore";
import Invoice from "../../components/Invoice/Invoice";
import { resolveInvoiceNumber } from "../../utils/invoice";
import type { FirestoreOrder } from "../../services/firestore";
import "./InvoiceView.css";

type LoadState = "loading" | "ready" | "denied" | "missing" | "error";

/**
 * صفحة الفاتورة — /invoice/:orderId
 *
 * الطباعة هي التنزيل: window.print() ثم «حفظ كـ PDF» في مربّع الطباعة. لا
 * مكتبة PDF، ولا توليد على الخادم، والنص العربي يبقى نصاً متجهاً قابلاً
 * للتحديد والبحث — وهو ما تفقده أي صورة أو لوحة canvas.
 *
 * الصلاحية لا تحتاج شيفرة جديدة: قاعدة orders/{id} في firestore.rules تسمح
 * بالقراءة لصاحب الطلب أو أدمن المتجر وحدهما، فطلب غريب يرتدّ
 * permission-denied وتُعرض حالة «غير مصرّح» بدل صفحة فارغة.
 */
const InvoiceView: React.FC = () => {
  const { orderId } = useParams<{ orderId: string }>();
  const { businessInfo, storeInfo } = useStore();
  const [order, setOrder] = useState<FirestoreOrder | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!orderId) {
        setState("missing");
        return;
      }
      try {
        const snap = await getDoc(storeDoc("orders", orderId));
        if (!active) return;
        if (!snap.exists()) {
          setState("missing");
          return;
        }
        setOrder({ id: snap.id, ...snap.data() } as FirestoreOrder);
        setState("ready");
      } catch (err) {
        if (!active) return;
        const code = (err as { code?: string }).code;
        console.error("[Invoice] تعذّر تحميل الطلب:", err);
        setState(code === "permission-denied" ? "denied" : "error");
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [orderId]);

  // عنوان المستند يصير اسم ملف PDF المقترح في مربّع الطباعة، فنجعله رقم
  // الفاتورة بدل "حلال - بيع الأغنام والمواشي".
  useEffect(() => {
    if (!order) return;
    const previous = document.title;
    document.title = `فاتورة ${resolveInvoiceNumber(order, businessInfo.invoicePrefix)}`;
    return () => {
      document.title = previous;
    };
  }, [order, businessInfo.invoicePrefix]);

  const messages: Record<Exclude<LoadState, "loading" | "ready">, string> = {
    denied: "غير مصرّح بالوصول لهذه الفاتورة. سجّل الدخول بالحساب الذي أنشأ الطلب.",
    missing: "لم نجد هذا الطلب. تأكّد من الرابط أو افتح الفاتورة من صفحة طلباتي.",
    error: "تعذّر تحميل الفاتورة. حدّث الصفحة أو حاول بعد قليل.",
  };

  return (
    <div className="invoice-view">
      <div className="invoice-toolbar">
        <Link to="/account" className="btn btn-outline">
          <ArrowRight size={18} aria-hidden="true" />
          طلباتي
        </Link>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.print()}
          disabled={state !== "ready"}
        >
          <Printer size={18} aria-hidden="true" />
          طباعة / تحميل PDF
        </button>
      </div>

      {state === "loading" && (
        <div className="invoice-state">
          <Loader className="spinner" size={34} aria-hidden="true" />
          <p>جاري تحميل الفاتورة…</p>
        </div>
      )}

      {state !== "loading" && state !== "ready" && (
        <div className="invoice-state">
          <FileWarning size={34} aria-hidden="true" />
          <p>{messages[state]}</p>
        </div>
      )}

      {state === "ready" && order && (
        <div className="invoice-sheet">
          <Invoice
            order={order}
            business={businessInfo}
            storeName={storeInfo.storeName || "حلال"}
            storePhone={storeInfo.storePhone}
            storeEmail={storeInfo.storeEmail}
          />
        </div>
      )}
    </div>
  );
};

export default InvoiceView;
