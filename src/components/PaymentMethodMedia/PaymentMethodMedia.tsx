/**
 * الرمز المعروض بجانب طريقة الدفع في الـ checkout.
 *
 * بوابة مسجّلة ⇒ شعار الشركة من public/payments/.
 * طريقة يدوية (نقد/تحويل/إمكان) ⇒ نفس أيقونة lucide المستخدمة اليوم.
 *
 * الشعار يسقط إلى الأيقونة البديلة عند فشل التحميل (onError)، وهذا ما يسمح
 * بتشغيل البوابة قبل وصول ملف الشعار الرسمي من المزوّد.
 */

import { createElement, useState } from "react";

import {
  GATEWAY_BY_ID,
  paymentMethodIcon,
} from "../../constants/paymentGateways";
import "./PaymentMethodMedia.css";

interface Props {
  methodId: string;
  size?: number;
}

const PaymentMethodMedia: React.FC<Props> = ({ methodId, size = 20 }) => {
  const [failed, setFailed] = useState(false);
  const descriptor = GATEWAY_BY_ID[methodId];

  if (descriptor && !failed) {
    return (
      <span className="payment-logo-wrap">
        <img
          className="payment-logo"
          src={descriptor.logo}
          alt={descriptor.logoAlt}
          /* أبعاد صريحة: تمنع ارتجاف التخطيط في خطوة الدفع */
          width={64}
          height={28}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  // الأيقونة تُبنى بـ createElement: إسنادها إلى متغيّر بحرف كبير داخل
  // الرسم يجعل ESLint يراها مكوّناً يُنشأ في كل رسم.
  return (
    <span className="payment-logo-wrap">
      {createElement(paymentMethodIcon(methodId), {
        size,
        "aria-hidden": true,
      })}
    </span>
  );
};

export default PaymentMethodMedia;
