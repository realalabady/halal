import React from "react";
import type { FirestoreOrder } from "../../services/firestore";
import type { BusinessInfo } from "../../store/useStore";
import {
  computeInvoiceTotals,
  formatInvoiceDateTime,
  formatSAR,
  resolveInvoiceDate,
  resolveInvoiceNumber,
  resolvePaymentDetails,
} from "../../utils/invoice";
import { toArabicWords } from "../../utils/arabicNumberWords";
import { generateQrMatrix, qrMatrixToSvgPath } from "../../utils/qr";
import "./Invoice.css";

interface InvoiceProps {
  order: FirestoreOrder;
  business: BusinessInfo;
  /** اسم المتجر التجاري، يُستخدم عند غياب الاسم القانوني */
  storeName: string;
  storePhone?: string;
  storeEmail?: string;
}

/** صف في شبكة البيانات، يُخفى كاملاً إذا كانت القيمة فارغة. */
const MetaRow: React.FC<{
  label: string;
  labelEn: string;
  value?: React.ReactNode;
  mono?: boolean;
}> = ({ label, labelEn, value, mono }) => {
  if (value == null || value === "") return null;
  return (
    <div className="inv-meta-row">
      <span className="inv-meta-label">
        {label}
        <span className="inv-meta-label-en">{labelEn}</span>
      </span>
      <span className={`inv-meta-value${mono ? " inv-mono" : ""}`}>{value}</span>
    </div>
  );
};

/**
 * الفاتورة المطبوعة — مكوّن عرض خالص.
 *
 * كل أرقامه من لقطة الطلب، والهوية الحيّة (الشعار) للزينة فقط. لا جلب بيانات
 * ولا حالة: صفحة InvoiceView تُحمّل الطلب وتُمرّره، فيبقى هذا المكوّن قابلاً
 * للعرض في أي سياق (لوحة التحكم، صفحة العميل) دون تغيير.
 */
const Invoice: React.FC<InvoiceProps> = ({
  order,
  business,
  storeName,
  storePhone,
  storeEmail,
}) => {
  const totals = computeInvoiceTotals(order);
  const serial = resolveInvoiceNumber(order, business.invoicePrefix);
  const issuedAt = resolveInvoiceDate(order);
  const issued = formatInvoiceDateTime(issuedAt);
  const payment = resolvePaymentDetails(order);
  const paid = payment.paidAt ? formatInvoiceDateTime(payment.paidAt) : null;

  const legalNameAr = business.legalNameAr || storeName;
  const qrMatrix = business.crVerifyUrl
    ? generateQrMatrix(business.crVerifyUrl)
    : null;

  const titleAr = totals.isTaxInvoice ? "فاتورة ضريبية مبسطة" : "فاتورة";
  const titleEn = totals.isTaxInvoice ? "Simplified Tax Invoice" : "Invoice";

  const address = order.address;
  const addressLine = address
    ? [address.street, address.district, address.city]
        .filter(Boolean)
        .join("، ")
    : order.shippingAddress;

  return (
    <article className="invoice" dir="rtl" lang="ar">
      {/* ===== الرأس: هوية المتجر ===== */}
      <header className="inv-header">
        <div className="inv-brand">
          {business.logoUrl ? (
            <img className="inv-logo" src={business.logoUrl} alt={legalNameAr} />
          ) : (
            <div className="inv-wordmark" aria-hidden="true">
              {storeName}
            </div>
          )}
          <div className="inv-brand-text">
            <h1 className="inv-legal-name">{legalNameAr}</h1>
            {business.legalNameEn && (
              <p className="inv-legal-name-en">{business.legalNameEn}</p>
            )}
          </div>
        </div>

        <dl className="inv-identity">
          {business.crNumber && (
            <div>
              <dt>السجل التجاري · CR</dt>
              <dd className="inv-mono">{business.crNumber}</dd>
            </div>
          )}
          {business.unifiedNumber && (
            <div>
              <dt>الرقم الموحّد · Unified No.</dt>
              <dd className="inv-mono">{business.unifiedNumber}</dd>
            </div>
          )}
          {/* الرقم الضريبي يُطبع فقط إذا حملته لقطة الطلب. إظهاره بلا تسجيل
              ضريبي مخالفة، فالشرط قانوني لا تنسيقي. */}
          {totals.isTaxInvoice && order.invoiceVatNumber && (
            <div>
              <dt>الرقم الضريبي · VAT No.</dt>
              <dd className="inv-mono">{order.invoiceVatNumber}</dd>
            </div>
          )}
          {business.addressAr && (
            <div>
              <dt>العنوان · Address</dt>
              <dd>{business.addressAr}</dd>
            </div>
          )}
          {(storePhone || storeEmail) && (
            <div>
              <dt>التواصل · Contact</dt>
              <dd className="inv-mono">
                {[storePhone, storeEmail].filter(Boolean).join(" · ")}
              </dd>
            </div>
          )}
        </dl>
      </header>

      {/* ===== العنوان ===== */}
      <div className="inv-title-bar">
        <h2 className="inv-title">
          {titleAr}
          <span className="inv-title-en">{titleEn}</span>
        </h2>
        <div className="inv-serial">
          <span className="inv-serial-label">رقم الفاتورة · Invoice No.</span>
          <strong className="inv-mono">{serial}</strong>
        </div>
      </div>

      {/* ===== الطلب والعميل ===== */}
      <section className="inv-columns">
        <div className="inv-panel">
          <h3 className="inv-panel-title">
            بيانات الفاتورة<span>Invoice details</span>
          </h3>
          <div className="inv-meta">
            <MetaRow
              label="تاريخ الإصدار"
              labelEn="Issue date"
              value={
                <>
                  <span className="inv-mono">{issued.ar}</span>
                  <span className="inv-sub inv-mono">{issued.en}</span>
                </>
              }
            />
            <MetaRow
              label="رقم الطلب"
              labelEn="Order No."
              value={order.id?.slice(-8).toUpperCase()}
              mono
            />
            <MetaRow
              label="طريقة الاستلام"
              labelEn="Fulfilment"
              value={
                order.fulfillment === "pickup"
                  ? "استلام من الفرع · Pickup"
                  : "توصيل · Delivery"
              }
            />
            <MetaRow
              label="حالة الدفع"
              labelEn="Payment status"
              value={payment.statusLabel}
            />
          </div>
        </div>

        <div className="inv-panel">
          <h3 className="inv-panel-title">
            بيانات العميل<span>Customer</span>
          </h3>
          <div className="inv-meta">
            <MetaRow
              label="الاسم"
              labelEn="Name"
              value={order.customer || address?.fullName}
            />
            <MetaRow
              label="الجوال"
              labelEn="Mobile"
              value={order.phone || address?.phone}
              mono
            />
            <MetaRow label="البريد" labelEn="Email" value={order.email} mono />
            <MetaRow label="العنوان" labelEn="Address" value={addressLine} />
            <MetaRow
              label="العنوان الوطني"
              labelEn="National address"
              value={address?.nationalAddress}
              mono
            />
          </div>
        </div>
      </section>

      {/* ===== الأصناف ===== */}
      <section className="inv-items">
        <table className="inv-table">
          <thead>
            <tr>
              <th className="inv-col-idx">#</th>
              <th>
                الصنف<span className="inv-th-en">Item</span>
              </th>
              <th className="inv-col-num">
                الكمية<span className="inv-th-en">Qty</span>
              </th>
              <th className="inv-col-num">
                سعر الوحدة<span className="inv-th-en">Unit price</span>
              </th>
              <th className="inv-col-num">
                الإجمالي<span className="inv-th-en">Amount</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items?.map((item, idx) => (
              <tr key={`${item.productId}-${idx}`}>
                <td className="inv-col-idx inv-mono">{idx + 1}</td>
                <td>
                  <span className="inv-item-name">{item.name}</span>
                </td>
                <td className="inv-col-num inv-mono">{item.quantity}</td>
                <td className="inv-col-num inv-mono">
                  {formatSAR(item.price)}
                </td>
                <td className="inv-col-num inv-mono">
                  {formatSAR(item.price * item.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ===== الإجماليات ===== */}
      <section className="inv-summary">
        <div className="inv-words">
          <span className="inv-words-label">المبلغ كتابةً · Amount in words</span>
          <p className="inv-words-value">{toArabicWords(totals.total)}</p>
        </div>

        <div className="inv-totals">
          <div className="inv-total-row">
            <span>
              المجموع الفرعي<span className="inv-sub-en">Subtotal</span>
            </span>
            <span className="inv-mono">{formatSAR(totals.subtotal)}</span>
          </div>
          <div className="inv-total-row">
            <span>
              الشحن<span className="inv-sub-en">Shipping</span>
            </span>
            <span className="inv-mono">
              {totals.shipping === 0 ? "مجاني" : formatSAR(totals.shipping)}
            </span>
          </div>
          {totals.isTaxInvoice && (
            <>
              <div className="inv-total-row">
                <span>
                  الوعاء الخاضع للضريبة
                  <span className="inv-sub-en">Taxable amount</span>
                </span>
                <span className="inv-mono">{formatSAR(totals.taxableTotal)}</span>
              </div>
              <div className="inv-total-row">
                <span>
                  ضريبة القيمة المضافة {totals.vatRate}%
                  <span className="inv-sub-en">VAT {totals.vatRate}%</span>
                </span>
                <span className="inv-mono">{formatSAR(totals.vatAmount)}</span>
              </div>
            </>
          )}
          <div className="inv-total-row inv-total-grand">
            <span>
              الإجمالي المستحق<span className="inv-sub-en">Total due</span>
            </span>
            <span className="inv-mono">{formatSAR(totals.total)} ر.س</span>
          </div>
        </div>
      </section>

      {/* ===== تفاصيل الدفع، بما فيها بوابات التقسيط ===== */}
      <section className="inv-payment">
        <h3 className="inv-panel-title">
          تفاصيل الدفع<span>Payment details</span>
        </h3>
        <div className="inv-payment-body">
          <div className="inv-payment-method">
            {payment.logo && (
              <img
                className="inv-payment-logo"
                src={payment.logo}
                alt={payment.methodLabel}
              />
            )}
            <div>
              <strong>{payment.methodLabel}</strong>
              {payment.planNote && (
                <p className="inv-sub">{payment.planNote}</p>
              )}
            </div>
          </div>

          <div className="inv-meta">
            {payment.installments && (
              <MetaRow
                label="خطة الأقساط"
                labelEn="Instalment plan"
                value={
                  <>
                    <span className="inv-mono">
                      {payment.installments.count} ×{" "}
                      {formatSAR(payment.installments.amount)} ر.س
                    </span>
                    <span className="inv-sub">
                      الأقساط تُسدَّد إلى {payment.methodLabel} مباشرة، وقيمة
                      الطلب محصّلة بالكامل لصالح المتجر.
                    </span>
                  </>
                }
              />
            )}
            <MetaRow
              label={payment.providerRefLabel || "مرجع المزوّد"}
              labelEn="Provider reference"
              value={payment.providerRef}
              mono
            />
            <MetaRow
              label="مرجع العملية في المتجر"
              labelEn="Store reference"
              value={payment.storeRef}
              mono
            />
            <MetaRow
              label="رمز حالة المزوّد"
              labelEn="Provider status"
              value={payment.statusCode}
              mono
            />
            {paid && (
              <MetaRow
                label="تاريخ الدفع"
                labelEn="Paid at"
                value={
                  <>
                    <span className="inv-mono">{paid.ar}</span>
                    <span className="inv-sub inv-mono">{paid.en}</span>
                  </>
                }
              />
            )}
          </div>
        </div>
      </section>

      {/* ===== الذيل: التحقق من السجل + ملاحظات ===== */}
      <footer className="inv-footer">
        {qrMatrix && (
          <div className="inv-verify">
            <svg
              className="inv-qr"
              viewBox={`0 0 ${qrMatrix.length} ${qrMatrix.length}`}
              role="img"
              aria-label="رمز التحقق من السجل التجاري"
            >
              <rect
                width={qrMatrix.length}
                height={qrMatrix.length}
                fill="#ffffff"
              />
              <path d={qrMatrixToSvgPath(qrMatrix)} fill="#000000" />
            </svg>
            <p className="inv-verify-text">
              تحقّق من السجل التجاري
              <span className="inv-sub">Verify commercial registration</span>
            </p>
          </div>
        )}

        <div className="inv-footer-text">
          <p className="inv-footer-line">
            هذه فاتورة صادرة إلكترونياً ولا تحتاج إلى توقيع أو خاتم.
            <span className="inv-sub">
              This invoice is issued electronically; no signature or stamp is
              required.
            </span>
          </p>
          {business.invoiceNotes && (
            <p className="inv-footer-note">{business.invoiceNotes}</p>
          )}
          {order.notes && (
            <p className="inv-footer-note">
              ملاحظات الطلب · Order notes: {order.notes}
            </p>
          )}
        </div>
      </footer>
    </article>
  );
};

export default Invoice;
