/**
 * مساعد HTTP لبوابات الدفع.
 *
 * السبب في وجوده: العميلان القديمان (tamaraClient.ts:237 مثلاً) يطبعان جسم
 * الطلب كاملاً في السجلّ، فتنتهي بيانات العميل — وربما الرموز — في Cloud
 * Logging. هنا نطبع قائمة سماح فقط، ونُنقّي أي مفتاح يشبه السرّ.
 */

import fetch from "node-fetch";
import type { RequestInit } from "node-fetch";

/** أسماء الحقول التي لا تُطبع أبداً. */
const SECRET_KEY_PATTERN =
  /(secret|password|token|authorization|apikey|api_key|resourcekey|basic|jwt|iv)/i;

/** يُنقّي كائناً للسجلّ: الأسرار تُستبدل، والنصوص الطويلة تُقصّ. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => redact(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return value;
}

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export interface GatewayRequestOptions {
  /** اسم البوابة، للسجلّ فقط */
  gateway: string;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  /** يُرسل كـ JSON */
  body?: unknown;
  /** يُرسل كـ x-www-form-urlencoded */
  form?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * نداء واحد لبوابة. يُرجع الجسم مُحلّلاً (JSON إن أمكن، وإلا نصّاً).
 * يرفع GatewayHttpError على أي حالة غير ناجحة، حاملاً الحالة والجسم.
 */
export async function gatewayRequest<T = unknown>(
  url: string,
  options: GatewayRequestOptions,
): Promise<T> {
  const {
    gateway,
    method = "GET",
    headers = {},
    body,
    form,
    timeoutMs = 20000,
  } = options;

  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  const init: RequestInit = { method, headers: finalHeaders };

  if (form) {
    finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined && method !== "GET") {
    finalHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // node-fetch v2 يقبل signal لكن أنواعه لا تعلنه على RequestInit
  (init as RequestInit & { signal?: AbortSignal }).signal =
    controller.signal as AbortSignal;

  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  console.log(`[${gateway}] ${method} ${path}`);

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayHttpError(
      `فشل الاتصال بـ ${gateway}: ${message}`,
      0,
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // نترك النصّ كما هو
    }
  }

  if (!response.ok) {
    console.error(
      `[${gateway}] ${method} ${path} -> ${response.status}`,
      JSON.stringify(redact(parsed)),
    );
    throw new GatewayHttpError(
      `${gateway} أرجع الحالة ${response.status}`,
      response.status,
      parsed,
    );
  }

  return parsed as T;
}

/** يستخرج رسالة مفيدة من خطأ بوابة لعرضها للأدمن. */
export function describeGatewayError(error: unknown): string {
  if (error instanceof GatewayHttpError) {
    const body = error.body as Record<string, unknown> | string | null;
    if (typeof body === "string" && body.trim()) return body.slice(0, 300);
    if (body && typeof body === "object") {
      for (const key of ["message", "title", "error", "detail", "status"]) {
        const v = body[key];
        if (typeof v === "string" && v.trim()) return v.slice(0, 300);
      }
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
