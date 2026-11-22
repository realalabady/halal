/**
 * بطاقة إعدادات بوابة دفع واحدة في لوحة التحكم.
 *
 * مكوّن واحد لكل البوابات، مدفوع بوصف البوابة (GatewayDescriptor)، بدل نسخ
 * كتلة JSX و CSS لكل مزوّد كما في تمارا/تابي.
 *
 * فرقان جوهريان عن الكتلتين القديمتين:
 *  1) حالة الاتصال *محفوظة* على الخادم، فلا تضيع عند تحديث الصفحة، وهي
 *     نفسها ما يحكم ظهور البوابة للعميل.
 *  2) القيم المحفوظة تُقرأ وتُعرض (الأسرار مُقنّعة)، فيعرف الأدمن ما هو
 *     مضبوط فعلاً بدل حقول فارغة دائماً.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  HelpCircle,
  Loader,
  RefreshCw,
  Save,
} from "lucide-react";

import { useToast } from "../Toast/Toast";
import type {
  GatewayDescriptor,
  GatewayEnvironment,
} from "../../constants/paymentGateways";
import type { ConnectionStatus } from "../../services/paymentGateways";
import {
  getGatewayStatus,
  saveGatewaySettings,
  setGatewayEnabled,
  testGatewayConnection,
} from "../../services/paymentGateways";
import "./GatewaySettingsCard.css";

interface Props {
  gateway: GatewayDescriptor;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "متصل — ظاهر للعملاء",
  failed: "فشل الاتصال",
  untested: "لم يُختبر بعد",
};

const formatWhen = (iso?: string): string => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const GatewaySettingsCard: React.FC<Props> = ({ gateway }) => {
  const { showToast } = useToast();

  const [values, setValues] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<GatewayEnvironment>("sandbox");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<ConnectionStatus>("untested");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [lastTestedAt, setLastTestedAt] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  /**
   * فشل قراءة الإعدادات يُعرض داخل البطاقة لا كإشعار عائم: ثلاث بطاقات
   * تفشل معاً تعني ثلاثة إشعارات، وتضاعفها React في وضع التطوير
   * (StrictMode) إلى ستّة تغطّي الصفحة.
   */
  const [loadError, setLoadError] = useState("");
  /** حقول لمسها الأدمن: السرّ المُقنّع لا يُرسل إلا إن تغيّر فعلاً. */
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await getGatewayStatus(gateway.id);
      setValues(view.fields || {});
      setEnvironment(view.environment);
      setEnabled(view.enabled);
      setStatus(view.connection.status);
      setStatusMessage(view.connection.message || "");
      setLastTestedAt(view.connection.lastTestedAt || "");
      setTouched({});
      setLoadError("");
    } catch (error) {
      console.error(`${gateway.id}: فشل قراءة الإعدادات`, error);
      // "internal" من دالة سحابية غالباً يعني أنها غير منشورة: النداء يرجع
      // ٤٠٤ بلا ترويسات CORS فيظهر في المتصفّح كخطأ CORS مُضلِّل.
      const code = (error as { code?: string })?.code || "";
      setLoadError(
        code.includes("internal") || code.includes("not-found")
          ? "تعذّر الوصول إلى دوال بوابات الدفع. غالباً لم تُنشر بعد — " +
              "نفّذ: firebase deploy --only functions"
          : "تعذّر قراءة الإعدادات المحفوظة.",
      );
    } finally {
      setLoading(false);
    }
  }, [gateway.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => ({ ...prev, [key]: true }));
  };

  /**
   * يحفظ ما في النموذج. يُرجع رسالة الخادم، ويرمي عند نقص حقل مطلوب.
   * الأسرار التي لم يلمسها الأدمن تُرسل مُقنّعة، والخادم يفهمها
   * على أنها "لم تتغيّر" ويُبقي المحفوظ.
   */
  const persist = useCallback(async () => {
    const missing = gateway.credentialFields
      .filter((f) => f.required && f.key !== "environment")
      .filter((f) => !(values[f.key] || "").trim())
      .map((f) => f.label);

    if (missing.length > 0) {
      throw new Error(`أكمل الحقول المطلوبة: ${missing.join("، ")}`);
    }

    const credentials: Record<string, string> = {};
    for (const field of gateway.credentialFields) {
      if (field.key === "environment") continue;
      const value = (values[field.key] || "").trim();
      if (!value) continue;
      credentials[field.key] = value;
    }

    return saveGatewaySettings(gateway.id, credentials, environment);
  }, [gateway.id, gateway.credentialFields, values, environment]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await persist();
      showToast(result.message || "تم حفظ الإعدادات", "success");
      await load();
    } catch (error) {
      console.error(`${gateway.id}: فشل الحفظ`, error);
      const message =
        error instanceof Error ? error.message : "تعذّر حفظ الإعدادات";
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      // الحفظ أولاً: الاختبار يجري على الإعدادات *المحفوظة*، فلو بدّل
      // الأدمن البيئة إلى "تجربة" ثم ضغط اختبار، كان الخادم يختبر الإنتاج
      // المحفوظ ثم تُعيد القراءة القيمة القديمة إلى القائمة — فيبدو كأن
      // الاختيار "يرتدّ" من تلقاء نفسه.
      await persist();
      const result = await testGatewayConnection(gateway.id);
      showToast(result.message, result.success ? "success" : "error");
      await load();
    } catch (error) {
      console.error(`${gateway.id}: فشل الاختبار`, error);
      const message =
        error instanceof Error ? error.message : "تعذّر اختبار الاتصال";
      showToast(message, "error");
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await setGatewayEnabled(gateway.id, next);
    } catch (error) {
      console.error(`${gateway.id}: فشل التفعيل`, error);
      setEnabled(!next);
      showToast("تعذّر تحديث حالة البوابة", "error");
    }
  };

  const busy = saving || testing;
  const Icon = gateway.fallbackIcon;

  return (
    <div className="gateway-settings-card">
      <div className="gateway-card-head">
        <h3>
          <Icon size={18} aria-hidden="true" />
          إعدادات {gateway.name}
        </h3>

        <label className="toggle" title="إظهار هذه الطريقة للعملاء">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading}
            onChange={handleToggleEnabled}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>

      <p className={`gateway-status gateway-status-${status}`}>
        {status === "connected" ? (
          <CheckCircle size={15} aria-hidden="true" />
        ) : status === "failed" ? (
          <AlertCircle size={15} aria-hidden="true" />
        ) : (
          <HelpCircle size={15} aria-hidden="true" />
        )}
        <span>{STATUS_LABEL[status]}</span>
        {lastTestedAt && (
          <span className="gateway-status-when">
            آخر اختبار: {formatWhen(lastTestedAt)}
          </span>
        )}
      </p>

      {status === "failed" && statusMessage && (
        <p className="gateway-status-detail">{statusMessage}</p>
      )}

      {loadError && (
        <p className="gateway-status-detail">
          {loadError}{" "}
          <button
            type="button"
            className="gateway-retry"
            onClick={() => void load()}
          >
            إعادة المحاولة
          </button>
        </p>
      )}

      {loading ? (
        <p className="gateway-loading">
          <Loader className="spinner" size={16} aria-hidden="true" />
          جارٍ تحميل الإعدادات…
        </p>
      ) : (
        <>
          {gateway.credentialFields.map((field) => {
            if (field.key === "environment") {
              return (
                <div className="form-group" key={field.key}>
                  <label htmlFor={`${gateway.id}-environment`}>
                    {field.label}
                  </label>
                  <select
                    id={`${gateway.id}-environment`}
                    value={environment}
                    onChange={(e) =>
                      setEnvironment(e.target.value as GatewayEnvironment)
                    }
                  >
                    {(field.options || []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {field.help && <p className="field-hint">{field.help}</p>}
                </div>
              );
            }

            const inputId = `${gateway.id}-${field.key}`;
            return (
              <div className="form-group" key={field.key}>
                <label htmlFor={inputId}>
                  {field.label}
                  {!field.required && (
                    <span className="gateway-optional"> — اختياري</span>
                  )}
                </label>
                <input
                  id={inputId}
                  // القناع (••••1234) يُعرض نصاً لا نقاطاً: إخفاؤه خلف
                  // input[type=password] يحوّله إلى ثماني نقاط عمياء، فيظنّ
                  // الأدمن أن مفتاحه قُصّ. إظهار آخر أربع خانات يسمح
                  // بمطابقته بالعين. ما يُخفى هو السرّ نفسه، والخادم لا
                  // يُرسله أصلاً.
                  type={
                    field.kind === "password" &&
                    !(field.secret && !touched[field.key])
                      ? "password"
                      : "text"
                  }
                  value={values[field.key] || ""}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  onFocus={() => {
                    // لمس حقل سرّي يُفرغه حتى لا يُحرّر الأدمن القناع نفسه.
                    if (field.secret && !touched[field.key]) {
                      setValues((prev) => ({ ...prev, [field.key]: "" }));
                      setTouched((prev) => ({ ...prev, [field.key]: true }));
                    }
                  }}
                  onChange={(e) => onChange(field.key, e.target.value)}
                />
                {field.help && <p className="field-hint">{field.help}</p>}
              </div>
            );
          })}

          {gateway.minAmountSAR && (
            <p className="field-hint">
              لا تظهر هذه الطريقة للعميل إذا كان إجمالي السلة أقل من{" "}
              {gateway.minAmountSAR} ر.س — وهو حدّ المزوّد نفسه.
            </p>
          )}

          {gateway.requiresStaticEgressIp && (
            <p className="gateway-warning">
              يشترط هذا المزوّد تثبيت عنوان IP الصادر من الخادم. يجب إعداد
              عنوان ثابت قبل التشغيل الفعلي، وإلا فشلت الطلبات بشكل متقطّع
              في الإنتاج.
            </p>
          )}

          <div className="gateway-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleTest}
              disabled={busy}
            >
              {testing ? (
                <Loader className="spinner" size={16} aria-hidden="true" />
              ) : (
                <>
                  <RefreshCw size={16} aria-hidden="true" />
                  اختبار الاتصال
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={busy}
            >
              {saving ? (
                <Loader className="spinner" size={16} aria-hidden="true" />
              ) : (
                <>
                  <Save size={16} aria-hidden="true" />
                  حفظ الإعدادات
                </>
              )}
            </button>
          </div>

          <p className="field-hint">
            الحفظ وحده لا يُظهر الطريقة للعملاء. لا تظهر إلا بعد نجاح اختبار
            اتصال حقيقي مع المزوّد.
          </p>
        </>
      )}
    </div>
  );
};

export default GatewaySettingsCard;
