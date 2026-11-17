"use strict";
/**
 * مساعد HTTP لبوابات الدفع.
 *
 * السبب في وجوده: العميلان القديمان (tamaraClient.ts:237 مثلاً) يطبعان جسم
 * الطلب كاملاً في السجلّ، فتنتهي بيانات العميل — وربما الرموز — في Cloud
 * Logging. هنا نطبع قائمة سماح فقط، ونُنقّي أي مفتاح يشبه السرّ.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayHttpError = void 0;
exports.redact = redact;
exports.gatewayRequest = gatewayRequest;
exports.describeGatewayError = describeGatewayError;
const node_fetch_1 = __importDefault(require("node-fetch"));
/** أسماء الحقول التي لا تُطبع أبداً. */
const SECRET_KEY_PATTERN = /(secret|password|token|authorization|apikey|api_key|resourcekey|basic|jwt|iv)/i;
/** يُنقّي كائناً للسجلّ: الأسرار تُستبدل، والنصوص الطويلة تُقصّ. */
function redact(value, depth = 0) {
    if (depth > 4)
        return "[deep]";
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value)) {
        return value.slice(0, 10).map((v) => redact(v, depth + 1));
    }
    if (typeof value === "object") {
        const out = {};
        for (const [key, v] of Object.entries(value)) {
            out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(v, depth + 1);
        }
        return out;
    }
    if (typeof value === "string") {
        return value.length > 300 ? `${value.slice(0, 300)}…` : value;
    }
    return value;
}
class GatewayHttpError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "GatewayHttpError";
    }
}
exports.GatewayHttpError = GatewayHttpError;
/**
 * نداء واحد لبوابة. يُرجع الجسم مُحلّلاً (JSON إن أمكن، وإلا نصّاً).
 * يرفع GatewayHttpError على أي حالة غير ناجحة، حاملاً الحالة والجسم.
 */
async function gatewayRequest(url, options) {
    const { gateway, method = "GET", headers = {}, body, form, timeoutMs = 20000, } = options;
    const finalHeaders = { Accept: "application/json", ...headers };
    const init = { method, headers: finalHeaders };
    if (form) {
        finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
        init.body = new URLSearchParams(form).toString();
    }
    else if (body !== undefined && method !== "GET") {
        finalHeaders["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // node-fetch v2 يقبل signal لكن أنواعه لا تعلنه على RequestInit
    init.signal =
        controller.signal;
    const path = (() => {
        try {
            return new URL(url).pathname;
        }
        catch (_a) {
            return url;
        }
    })();
    console.log(`[${gateway}] ${method} ${path}`);
    let response;
    try {
        response = await (0, node_fetch_1.default)(url, init);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GatewayHttpError(`فشل الاتصال بـ ${gateway}: ${message}`, 0, null);
    }
    finally {
        clearTimeout(timer);
    }
    const text = await response.text();
    let parsed = text;
    if (text) {
        try {
            parsed = JSON.parse(text);
        }
        catch (_a) {
            // نترك النصّ كما هو
        }
    }
    if (!response.ok) {
        console.error(`[${gateway}] ${method} ${path} -> ${response.status}`, JSON.stringify(redact(parsed)));
        throw new GatewayHttpError(`${gateway} أرجع الحالة ${response.status}`, response.status, parsed);
    }
    return parsed;
}
/** يستخرج رسالة مفيدة من خطأ بوابة لعرضها للأدمن. */
function describeGatewayError(error) {
    if (error instanceof GatewayHttpError) {
        const body = error.body;
        if (typeof body === "string" && body.trim())
            return body.slice(0, 300);
        if (body && typeof body === "object") {
            for (const key of ["message", "title", "error", "detail", "status"]) {
                const v = body[key];
                if (typeof v === "string" && v.trim())
                    return v.slice(0, 300);
            }
        }
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=gatewayHttp.js.map