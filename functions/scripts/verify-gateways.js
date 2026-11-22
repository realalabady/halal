/**
 * تحقّق من بوابات الدفع — بلا بيانات اعتماد حقيقية.
 *
 * قسمان:
 *   1) اختبارات نقية: دورة التشفير، واستنتاج تخطيط AES-GCM، ومُسوّيات الحالة.
 *   2) اختبارات المصالحة على محاكي Firestore، بمحوّل وهمي.
 *
 * التشغيل:
 *   cd functions && npm run build
 *   node scripts/verify-gateways.js                    # القسم الأول فقط
 *   firebase emulators:exec --only firestore "node functions/scripts/verify-gateways.js"
 *
 * ملاحظة: دورة التشفير تُثبت أن سباكتنا (GCM/CBC) صحيحة، لا أنها تطابق
 * تخطيط MIS Pay أو مواصفة البنك. ذلك يحتاج ردّاً حقيقياً من البيئة التجريبية.
 */

/* eslint-disable no-console */

const crypto = require("crypto");

process.env.FUNCTIONS_EMULATOR = process.env.FUNCTIONS_EMULATOR || "true";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error("استخدم checkAsync للاختبارات غير المتزامنة");
    }
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${error.message}`);
    failed += 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "فشل التحقق");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || "قيمة غير متوقّعة"}: المتوقّع ${JSON.stringify(expected)} والوارد ${JSON.stringify(actual)}`,
    );
  }
}

// ==================== ١) اختبارات نقية ====================

function pureTests() {
  console.log("\nالتشفير ومُسوّيات الحالة");

  const mispay = require("../lib/mispayClient");
  const neoleap = require("../lib/neoleapClient");
  const madfu = require("../lib/madfuClient");

  // --- MIS Pay: استنتاج تخطيط AES-GCM ---
  // نُشفّر بتخطيط معروف ونتأكّد أن المُفكِّك يجده بنفسه. هذا ما يجعل
  // التخطيط غير الموثّق مشكلة قابلة للحل: الوسم (tag) يؤكّد الصواب.
  const makeGcmBlob = (plaintext, secret, { ivLength, tagFirst, derive }) => {
    let key;
    if (derive === "utf8") key = Buffer.from(secret, "utf8");
    else if (derive === "sha256")
      key = crypto.createHash("sha256").update(secret, "utf8").digest();
    else throw new Error("derive غير مدعوم في المساعد");
    const iv = crypto.randomBytes(ivLength);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const rest = tagFirst
      ? Buffer.concat([tag, body])
      : Buffer.concat([body, tag]);
    return Buffer.concat([iv, rest]).toString("base64");
  };

  const secret32 = "0123456789abcdef0123456789abcdef"; // ٣٢ حرفاً
  const payload = JSON.stringify({
    token: "jwt.header.payload",
    expiration: "2026-12-31T00:00:00Z",
  });

  const layouts = [
    { ivLength: 12, tagFirst: false, derive: "utf8" },
    { ivLength: 16, tagFirst: false, derive: "utf8" },
    { ivLength: 12, tagFirst: true, derive: "utf8" },
    { ivLength: 12, tagFirst: false, derive: "sha256" },
  ];

  for (const layout of layouts) {
    check(
      `MIS Pay: فكّ تخطيط iv=${layout.ivLength} tagFirst=${layout.tagFirst} key=${layout.derive}`,
      () => {
        const secret =
          layout.derive === "sha256" ? "any-length-secret" : secret32;
        const blob = makeGcmBlob(payload, secret, layout);
        const plain = mispay.decryptMisPayBlob(blob, secret);
        assertEqual(plain, payload, "النصّ المفكوك");
      },
    );
  }

  check("MIS Pay: مغلّف العودة يُفكّ إلى حقوله", () => {
    const body = JSON.stringify({
      orderId: "mispay-abc123",
      code: "MP00",
      checkoutId: "chk_1",
    });
    const blob = makeGcmBlob(body, secret32, {
      ivLength: 12,
      tagFirst: false,
      derive: "utf8",
    });
    const parsed = mispay.decryptMisPayCallback(blob, secret32);
    assertEqual(parsed.orderId, "mispay-abc123", "orderId");
    assertEqual(parsed.code, "MP00", "code");
    assertEqual(parsed.checkoutId, "chk_1", "checkoutId");
  });

  check("MIS Pay: سرّ خاطئ يُرفض ولا يُفكّ صامتاً", () => {
    const blob = makeGcmBlob(payload, secret32, {
      ivLength: 12,
      tagFirst: false,
      derive: "utf8",
    });
    let threw = false;
    try {
      mispay.decryptMisPayBlob(blob, "fedcba9876543210fedcba9876543210");
    } catch {
      threw = true;
    }
    assert(threw, "كان يجب أن يفشل الفكّ بسرّ خاطئ");
  });

  check("MIS Pay: مقارنة appId ثابتة الزمن تعمل", () => {
    assert(mispay.appIdMatches("app-1", "app-1"), "المتطابقان");
    assert(!mispay.appIdMatches("app-1", "app-2"), "المختلفان");
    assert(!mispay.appIdMatches("", ""), "الفارغان يُرفضان");
    assert(!mispay.appIdMatches("app-1", "app-12"), "الطولان المختلفان");
  });

  check("MIS Pay: الحد الأدنى ١٤٥ ر.س مُعلن في المحوّل", () => {
    assertEqual(mispay.misPayAdapter.minAmountSAR, 145, "الحد الأدنى");
    assertEqual(mispay.misPayAdapter.id, "mispay", "المعرّف");
  });

  // --- neoleap: دورة AES-256-CBC ---
  const neoleapCreds = {
    tranportalId: "TP123",
    tranportalPassword: "pw",
    resourceKey: "abcdefghijklmnopqrstuvwxyz012345", // ٣٢ حرفاً
  };

  check("neoleap: دورة تشفير/فكّ AES-256-CBC كاملة", () => {
    const original = JSON.stringify([
      { id: "TP123", amt: "199.00", trackId: "neoleap-xyz" },
    ]);
    const hex = neoleap.encryptTranportal(original, neoleapCreds);
    assert(/^[0-9A-F]+$/.test(hex), "الناتج hex كبير الحروف");
    assertEqual(
      neoleap.decryptTranportal(hex, neoleapCreds),
      original,
      "النصّ بعد الدورة",
    );
  });

  check("neoleap: مفتاح بطول خاطئ يُرفض برسالة واضحة", () => {
    let message = "";
    try {
      neoleap.encryptTranportal("x", { ...neoleapCreds, resourceKey: "short" });
    } catch (error) {
      message = error.message;
    }
    assert(message.includes("٣٢"), `رسالة غير متوقّعة: ${message}`);
  });

  check("neoleap: حمولة العودة تُفكّ إلى حقولها", () => {
    const body = JSON.stringify([
      { result: "CAPTURED", trackId: "neoleap-xyz", amt: "199.00", ref: "R1" },
    ]);
    const hex = neoleap.encryptTranportal(body, neoleapCreds);
    const decoded = neoleap.decodeNeoleapReturn(hex, neoleapCreds);
    assertEqual(decoded.result, "CAPTURED", "result");
    assertEqual(decoded.trackId, "neoleap-xyz", "trackId");
  });

  check("neoleap: تسوية الحالات", () => {
    const cases = [
      ["CAPTURED", "paid"],
      ["APPROVED", "paid"],
      ["NOT CAPTURED", "failed"],
      ["HOST TIMEOUT", "failed"],
      ["CANCELED", "cancelled"],
      ["", "pending"],
    ];
    for (const [result, expected] of cases) {
      assertEqual(
        neoleap.neoleapStatusOf({ result }).state,
        expected,
        `الحالة "${result}"`,
      );
    }
  });

  check("neoleap: المبلغ يُنقل للمطابقة", () => {
    assertEqual(
      neoleap.neoleapStatusOf({ result: "CAPTURED", amt: "199.00" }).amount,
      199,
      "المبلغ",
    );
  });

  // --- Madfu: رموز الحالة ---
  check("Madfu: رموز الـ webhook تُسوّى صحيحاً", () => {
    assertEqual(madfu.madfuWebhookStateOf("125"), "paid", "١٢٥ مدفوع");
    assertEqual(madfu.madfuWebhookStateOf("124"), "pending", "١٢٤ معلّق");
    assertEqual(madfu.madfuWebhookStateOf("135"), "failed", "١٣٥ انتهت المدة");
    assertEqual(madfu.madfuWebhookStateOf("136"), "failed", "١٣٦ منتهي");
    assertEqual(madfu.madfuWebhookStateOf("140"), "refunded", "١٤٠ مُسترد");
  });

  check("Madfu: الحقول المطلوبة الستّة مُعلنة", () => {
    const required = madfu.madfuAdapter.requiredCredentials;
    for (const field of [
      "apiKey",
      "appCode",
      "basicToken",
      "userName",
      "password",
    ]) {
      assert(required.includes(field), `الحقل ${field} مفقود`);
    }
  });

  // --- السجل ---
  console.log("\nالسجل");
  const registry = require("../lib/gatewayRegistry");

  check("السجل يحمل البوابات الخمس", () => {
    for (const id of ["mispay", "madfu", "neoleap", "tamara", "tabby"]) {
      assert(registry.GATEWAY_ADAPTERS[id], `البوابة ${id} غير مسجّلة`);
    }
  });

  check("تمارا وتابي لم تعودا مخفيّتين عن العميل", () => {
    // الحجب في الواجهة، لكن غياب المحوّل كان الحاجز الثاني.
    assert(registry.GATEWAY_ADAPTERS.tamara, "محوّل تمارا مفقود");
    assert(registry.GATEWAY_ADAPTERS.tabby, "محوّل تابي مفقود");
    assert(
      registry.secretFieldsOf("tabby").includes("secretKey"),
      "المفتاح السرّي لتابي يجب أن يكون مُقنّعاً",
    );
    assert(
      !registry.secretFieldsOf("tabby").includes("publicKey"),
      "المفتاح العام لتابي ليس سرّاً",
    );
  });

  check("كل محوّل يستوفي العقد", () => {
    for (const [id, adapter] of Object.entries(registry.GATEWAY_ADAPTERS)) {
      for (const method of [
        "testConnection",
        "createCheckout",
        "getStatus",
        "isAuthError",
      ]) {
        assert(
          typeof adapter[method] === "function",
          `${id}: ${method} مفقودة`,
        );
      }
      assert(
        Array.isArray(adapter.requiredCredentials) &&
          adapter.requiredCredentials.length > 0,
        `${id}: requiredCredentials فارغة`,
      );
    }
  });

  check("بوابة غير معروفة تُرفض", () => {
    let threw = false;
    try {
      registry.requireAdapter("not-a-gateway");
    } catch {
      threw = true;
    }
    assert(threw, "كان يجب رفض معرّف غير معروف");
  });

  check("كل حقل سرّي مُعلن في GATEWAY_SECRET_FIELDS", () => {
    assert(
      registry.secretFieldsOf("mispay").includes("appSecret"),
      "سرّ MIS Pay",
    );
    assert(registry.secretFieldsOf("madfu").includes("password"), "كلمة Madfu");
    assert(
      registry.secretFieldsOf("neoleap").includes("resourceKey"),
      "مفتاح neoleap",
    );
  });

  // --- تقنيع الأسرار وترقيم الجوال ---
  console.log("\nالتقنيع والتطبيع");
  const store = require("../lib/gatewayStore");
  const api = require("../lib/paymentGatewayApi");

  check("التقنيع يُبقي آخر أربع خانات فقط", () => {
    assertEqual(store.maskSecret("sk_live_abcd1234"), "••••1234", "سرّ طويل");
    assertEqual(store.maskSecret("ab"), "••••", "سرّ قصير");
    assertEqual(store.maskSecret(""), "", "سرّ فارغ");
    assert(
      !store.maskSecret("sk_live_abcd1234").includes("live"),
      "لا يتسرّب جزء من السرّ",
    );
  });

  check("عنوان الاستلام من الفرع يُشتقّ من عنوان المتجر", () => {
    // البوابات ترفض مدينة أو عنواناً فارغاً، والاستلام من الفرع يُفرغهما.
    const full = api.resolvePickupAddress(
      "الرياض، حي النخيل، شارع الأمير",
      "حلالي",
    );
    assertEqual(full.city, "الرياض", "المدينة");
    assertEqual(full.district, "حي النخيل", "الحي");
    assert(full.street.includes("شارع الأمير"), "الشارع");

    const twoParts = api.resolvePickupAddress("جدة، الحمراء", "حلالي");
    assertEqual(twoParts.city, "جدة", "مدينة من جزأين");
    assertEqual(twoParts.district, "الحمراء", "حي من جزأين");

    const onePart = api.resolvePickupAddress("الدمام", "حلالي");
    assertEqual(onePart.city, "الدمام", "مدينة مفردة");
    assert(onePart.street, "الشارع لا يكون فارغاً");

    // لا عنوان متجر إطلاقاً: نرجع لاسم المتجر، ولا نُرسل فراغاً أبداً
    const empty = api.resolvePickupAddress("", "حلالي");
    assertEqual(empty.city, "حلالي", "بديل المدينة");
    assert(empty.street, "بديل الشارع");
    for (const value of Object.values(empty)) {
      assert(typeof value === "string", "كل الحقول نصوص");
    }
    assert(empty.city.length > 0, "المدينة لا تكون فارغة");
  });

  check("ترقيم الجوال السعودي يُوحّد الأشكال", () => {
    const cases = [
      ["0501234567", "0501234567"],
      ["+966501234567", "0501234567"],
      ["966501234567", "0501234567"],
      ["00966501234567", "0501234567"],
      ["501234567", "0501234567"],
      ["050 123 4567", "0501234567"],
    ];
    for (const [input, expected] of cases) {
      assertEqual(api.normalizeSaudiMobile(input), expected, `الرقم ${input}`);
    }
  });

  // --- تنقية السجلّ ---
  console.log("\nتنقية السجلّ");
  const http = require("../lib/gatewayHttp");

  check("الأسرار لا تظهر في السجلّ", () => {
    const redacted = http.redact({
      appId: "app-1",
      appSecret: "super-secret",
      password: "pw",
      authorization: "Bearer xyz",
      nested: { apiKey: "k", resourceKey: "r", name: "منتج" },
    });
    assertEqual(redacted.appSecret, "[redacted]", "appSecret");
    assertEqual(redacted.password, "[redacted]", "password");
    assertEqual(redacted.authorization, "[redacted]", "authorization");
    assertEqual(redacted.nested.apiKey, "[redacted]", "apiKey المتداخل");
    assertEqual(redacted.nested.resourceKey, "[redacted]", "resourceKey");
    assertEqual(redacted.appId, "app-1", "المعرّف غير السرّي يبقى");
    assertEqual(redacted.nested.name, "منتج", "الاسم يبقى");
  });

  // --- أخطاء الإعداد تصل العميل مقروءة ---
  // الانحدار المحمي: رابط متجر ناقص كان يتسرّب خارج الدالة
  // فيرى المشتري "FirebaseError: INTERNAL" بلا نصّ.
  console.log("\nأخطاء الإعداد");
  const ctxOf = (baseUrl) => ({
    storeId: "s1",
    environment: "sandbox",
    baseUrl,
    functionsBaseUrl: "https://fn.example.com",
  });

  check("رابط المتجر الموجود يُعاد كما هو", () => {
    assertEqual(
      api.resolveStorefrontUrlOrFail(ctxOf("https://shop.example.com")),
      "https://shop.example.com",
      "الرابط",
    );
  });

  check("رابط المتجر الناقص يُصبح failed-precondition بنصّ عربي", () => {
    let thrown;
    try {
      api.resolveStorefrontUrlOrFail(ctxOf(""));
    } catch (error) {
      thrown = error;
    }
    if (!thrown) throw new Error("كان يجب أن يرمي");
    assertEqual(thrown.code, "failed-precondition", "رمز الخطأ");
    if (!/رابط المتجر/.test(thrown.message)) {
      throw new Error(`الرسالة لا تذكر رابط المتجر: ${thrown.message}`);
    }
  });
}

// ==================== ٢) اختبارات المصالحة على المحاكي ====================

async function emulatorTests() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(
      "\n(تُخطّى اختبارات المصالحة: FIRESTORE_EMULATOR_HOST غير مضبوط)\n" +
        "شغّلها بـ: firebase emulators:exec --only firestore \\\n" +
        '  "node functions/scripts/verify-gateways.js"',
    );
    return;
  }

  console.log("\nالمصالحة (محاكي Firestore)");

  const admin = require("firebase-admin");
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: "demo-gateways" });
  }
  const db = admin.firestore();

  const registry = require("../lib/gatewayRegistry");
  const { reconcileGatewayPayment } = require("../lib/paymentReconcile");

  const STORE = "teststore";

  // محوّل وهمي: حالته قابلة للضبط، ونعدّ نداءات getStatus.
  const fake = {
    id: "faketest",
    requiredCredentials: ["apiKey"],
    state: "paid",
    amount: undefined,
    statusCalls: 0,
    isAuthError: () => false,
    async testConnection() {
      return { success: true, message: "ok" };
    },
    async createCheckout() {
      return { redirectUrl: "https://example.test/pay", providerRef: "p1" };
    },
    async getStatus() {
      fake.statusCalls += 1;
      return {
        state: fake.state,
        providerCode: "FAKE",
        amount: fake.amount,
      };
    },
  };
  registry.registerTestAdapter(fake);

  const seed = async (orderRef, overrides = {}) => {
    await db.doc(`stores/${STORE}`).set({
      name: "متجر اختبار",
      domain: "https://shop.test",
      active: true,
    });
    await db.doc(`stores/${STORE}/settings/faketest`).set({
      credentials: { apiKey: "k" },
      environment: "sandbox",
    });
    await db.doc(`stores/${STORE}/products/p-1`).set({
      name: "منتج اختبار",
      price: 100,
      stock: 10,
    });
    await db.doc(`pending_payments/${orderRef}`).set({
      storeId: STORE,
      userId: "user-1",
      gateway: "faketest",
      environment: "sandbox",
      status: "CREATED",
      amount: 199,
      subtotal: 174,
      shippingAmount: 25,
      vat: 0,
      currency: "SAR",
      providerRef: "p1",
      draft: {
        userId: "user-1",
        customer: "عميل اختبار",
        email: "a@b.test",
        phone: "0501234567",
        items: [
          {
            productId: "p-1",
            name: "منتج اختبار",
            quantity: 1,
            price: 174,
            image: "",
          },
        ],
        total: 199,
        subtotal: 174,
        shippingCost: 25,
        paymentMethod: "faketest",
        fulfillment: "delivery",
        shippingAddress: "الرياض",
        notes: "",
      },
      createdAt: admin.firestore.Timestamp.now(),
      ...overrides,
    });
  };

  // --- أهمّ اختبار: المصالحة آمنة للتكرار والتزامن ---
  await checkAsync(
    "نداءان متزامنان ⇒ مستند طلب واحد فقط",
    async () => {
      const ref = "faketest-concurrent";
      fake.state = "paid";
      fake.amount = undefined;
      await seed(ref);

      const [a, b] = await Promise.all([
        reconcileGatewayPayment(STORE, ref),
        reconcileGatewayPayment(STORE, ref),
      ]);

      assertEqual(a.state, "paid", "نتيجة النداء الأول");
      assertEqual(b.state, "paid", "نتيجة النداء الثاني");
      assertEqual(a.orderId, ref, "معرّف الطلب الأول");
      assertEqual(b.orderId, ref, "معرّف الطلب الثاني");

      const orders = await db
        .collection(`stores/${STORE}/orders`)
        .where("gatewayRef", "==", ref)
        .get();
      assertEqual(orders.size, 1, "عدد مستندات الطلب");

      const order = orders.docs[0].data();
      assertEqual(order.paymentStatus, "paid", "حالة الدفع");
      assertEqual(order.status, "pending", "حالة الطلب");
      assertEqual(order.gateway, "faketest", "البوابة");
      assertEqual(order.total, 199, "الإجمالي");
    },
  );

  await checkAsync("نداء ثالث لاحق لا يُنشئ طلباً ثانياً", async () => {
    const ref = "faketest-concurrent";
    const before = fake.statusCalls;
    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "paid", "الحالة");
    assertEqual(result.orderId, ref, "معرّف الطلب");
    // المسار السريع لا يسأل المزوّد مرة أخرى
    assertEqual(fake.statusCalls, before, "عدد نداءات getStatus");
    const orders = await db
      .collection(`stores/${STORE}/orders`)
      .where("gatewayRef", "==", ref)
      .get();
    assertEqual(orders.size, 1, "عدد مستندات الطلب");
  });

  await checkAsync("دفع ملغى ⇒ لا طلب، وحالة CANCELLED", async () => {
    const ref = "faketest-cancelled";
    fake.state = "cancelled";
    await seed(ref);

    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "cancelled", "الحالة");
    assert(!result.orderId, "لا يجب أن يُعاد معرّف طلب");

    const order = await db.doc(`stores/${STORE}/orders/${ref}`).get();
    assert(!order.exists, "لا يجب إنشاء مستند طلب");
    const pending = await db.doc(`pending_payments/${ref}`).get();
    assertEqual(pending.data().status, "CANCELLED", "حالة الدفعة");
  });

  await checkAsync("دفع فاشل ⇒ لا طلب، وحالة FAILED", async () => {
    const ref = "faketest-failed";
    fake.state = "failed";
    await seed(ref);

    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "failed", "الحالة");
    const order = await db.doc(`stores/${STORE}/orders/${ref}`).get();
    assert(!order.exists, "لا يجب إنشاء مستند طلب");
    const pending = await db.doc(`pending_payments/${ref}`).get();
    assertEqual(pending.data().status, "FAILED", "حالة الدفعة");
  });

  await checkAsync("دفع معلّق ⇒ لا طلب، والحالة تبقى CREATED", async () => {
    const ref = "faketest-pending";
    fake.state = "pending";
    await seed(ref);

    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "pending", "الحالة");
    const order = await db.doc(`stores/${STORE}/orders/${ref}`).get();
    assert(!order.exists, "لا يجب إنشاء مستند طلب");
    const pending = await db.doc(`pending_payments/${ref}`).get();
    assertEqual(pending.data().status, "CREATED", "تبقى قابلة لإعادة المحاولة");
  });

  // --- المبلغ: مزوّد يُبلّغ مبلغاً مختلفاً لا يُنتج طلباً ---
  await checkAsync("مبلغ المزوّد المختلف ⇒ يُرفض ولا يُنشأ طلب", async () => {
    const ref = "faketest-mismatch";
    fake.state = "paid";
    fake.amount = 49; // بدل ١٩٩
    await seed(ref);

    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "failed", "الحالة");
    const order = await db.doc(`stores/${STORE}/orders/${ref}`).get();
    assert(!order.exists, "لا يجب إنشاء مستند طلب بمبلغ غير مطابق");
    const pending = await db.doc(`pending_payments/${ref}`).get();
    assertEqual(pending.data().status, "FAILED", "حالة الدفعة");
    assertEqual(pending.data().amountMismatch.received, 49, "المبلغ الوارد");
    fake.amount = undefined;
  });

  await checkAsync("فرق ضمن قرش واحد يُقبل", async () => {
    const ref = "faketest-rounding";
    fake.state = "paid";
    fake.amount = 199.004;
    await seed(ref);
    const result = await reconcileGatewayPayment(STORE, ref);
    assertEqual(result.state, "paid", "الحالة");
    fake.amount = undefined;
  });

  // --- العزل بين المتاجر ---
  await checkAsync("مرجع دفع من متجر آخر لا يُصالح", async () => {
    const ref = "faketest-othertenant";
    fake.state = "paid";
    await seed(ref);

    const result = await reconcileGatewayPayment("someotherstore", ref);
    assertEqual(result.state, "failed", "الحالة");
    const order = await db.doc(`stores/someotherstore/orders/${ref}`).get();
    assert(!order.exists, "لا يجب إنشاء طلب في متجر آخر");
  });

  await checkAsync("مرجع غير موجود يُعالج بهدوء", async () => {
    const result = await reconcileGatewayPayment(STORE, "does-not-exist");
    assertEqual(result.state, "failed", "الحالة");
    assert(!result.orderId, "لا معرّف طلب");
  });

  // --- نفاد المخزون أثناء التحويل: الطلب المدفوع لا يُسقَط ---
  await checkAsync(
    "نفاد المخزون أثناء الدفع ⇒ الطلب يُنشأ ويُعلَّم stockShortfall",
    async () => {
      const ref = "faketest-shortfall";
      fake.state = "paid";
      await seed(ref);
      // نفد المخزون بينما كان العميل على صفحة المزوّد
      await db.doc(`stores/${STORE}/products/p-1`).set(
        { name: "منتج اختبار", price: 100, stock: 0 },
        { merge: true },
      );

      const result = await reconcileGatewayPayment(STORE, ref);
      assertEqual(result.state, "paid", "الطلب المدفوع لا يُسقَط");

      const order = await db.doc(`stores/${STORE}/orders/${ref}`).get();
      assert(order.exists, "يجب إنشاء الطلب");
      assertEqual(order.data().stockShortfall, true, "علامة نقص المخزون");

      await db.doc(`stores/${STORE}/products/p-1`).set(
        { name: "منتج اختبار", price: 100, stock: 10 },
        { merge: true },
      );
    },
  );

  // --- التسعير على الخادم ---
  console.log("\nالتسعير على الخادم");
  const { computeOrderPricing } = require("../lib/orderPricing");

  await checkAsync("التسعير يُقرأ من مستندات المنتجات لا من العميل", async () => {
    await db.doc(`stores/${STORE}/settings/store`).set(
      {
        shipping: {
          freeShippingThreshold: 500,
          defaultShippingCost: 25,
          enableFreeShipping: true,
          estimatedDays: "3-5",
        },
      },
      { merge: true },
    );
    await db
      .doc(`stores/${STORE}/products/p-2`)
      .set({ name: "منتج ب", price: 60, stock: 5 });

    const pricing = await computeOrderPricing(STORE, [
      { productId: "p-1", quantity: 2 },
      { productId: "p-2", quantity: 1 },
    ]);

    assertEqual(pricing.subtotal, 260, "المجموع من مستندات المنتجات");
    assertEqual(pricing.shippingCost, 25, "الشحن من الإعدادات");
    assertEqual(pricing.total, 285, "الإجمالي");
    assertEqual(pricing.items[0].price, 100, "سعر الوحدة من المستند");
    assertEqual(pricing.items[0].name, "منتج اختبار", "الاسم من المستند");
  });

  await checkAsync("الشحن المجاني يُطبَّق عند تجاوز الحد", async () => {
    const pricing = await computeOrderPricing(STORE, [
      { productId: "p-1", quantity: 6 },
    ]);
    assertEqual(pricing.subtotal, 600, "المجموع");
    assertEqual(pricing.shippingCost, 0, "شحن مجاني");
    assertEqual(pricing.total, 600, "الإجمالي");
  });

  await checkAsync("حصّة الضريبة تُستخرج ولا تُضاف", async () => {
    await db
      .doc(`stores/${STORE}/settings/store`)
      .set({ payment: { vatRate: 15 } }, { merge: true });

    const pricing = await computeOrderPricing(STORE, [
      { productId: "p-1", quantity: 1 },
    ]);
    // الأسعار شاملة الضريبة: الإجمالي لا يتغيّر
    assertEqual(pricing.total, 125, "الإجمالي لا يزيد بالضريبة");
    assertEqual(pricing.vat, 16.3, "حصّة الضريبة المضمّنة");
    // معادلة MIS Pay: totalPrice + shipping + vat = purchaseAmount
    const totalPrice = Math.round((pricing.subtotal - pricing.vat) * 100) / 100;
    assertEqual(
      Math.round((totalPrice + pricing.shippingCost + pricing.vat) * 100) / 100,
      pricing.total,
      "معادلة MIS Pay متحقّقة",
    );

    await db
      .doc(`stores/${STORE}/settings/store`)
      .set({ payment: { vatRate: 0 } }, { merge: true });
  });

  await checkAsync("منتج غير موجود يُرفض", async () => {
    let threw = false;
    try {
      await computeOrderPricing(STORE, [{ productId: "nope", quantity: 1 }]);
    } catch {
      threw = true;
    }
    assert(threw, "كان يجب رفض منتج غير موجود");
  });

  await checkAsync("كمية غير صالحة تُرفض", async () => {
    let threw = false;
    try {
      await computeOrderPricing(STORE, [{ productId: "p-1", quantity: 0 }]);
    } catch {
      threw = true;
    }
    assert(threw, "كان يجب رفض كمية صفرية");
  });

  // --- النسخة العامة الخالية من الأسرار ---
  console.log("\nالنسخة العامة لحالة البوابة");
  const store = require("../lib/gatewayStore");

  await checkAsync("نجاح الاختبار يكتب connected: true في المستند العام", async () => {
    await store.recordConnectionResult({
      storeId: STORE,
      gatewayId: "faketest",
      environment: "sandbox",
      minAmountSAR: 145,
      result: { success: true, message: "تم", detail: "سرّ لا يُنشر" },
    });

    const pub = await db.doc(`stores/${STORE}/settings/store`).get();
    const mirror = pub.data().paymentGateways.faketest;
    assertEqual(mirror.connected, true, "connected");
    assertEqual(mirror.environment, "sandbox", "البيئة");
    assertEqual(mirror.minAmountSAR, 145, "الحد الأدنى");
    // المستند العام يقرأه أي زائر: لا يجب أن يحمل أي تفصيل خاص
    assertEqual(mirror.detail, undefined, "لا تفصيل في العام");
    assertEqual(mirror.message, undefined, "لا رسالة في العام");

    const priv = await db.doc(`stores/${STORE}/settings/faketest`).get();
    assertEqual(priv.data().connection.status, "connected", "الحالة الخاصة");
    assertEqual(priv.data().connection.detail, "سرّ لا يُنشر", "التفصيل خاص");
  });

  await checkAsync(
    "بوابة اتصلت ولم يُلمس مفتاحها تصل العميل (enabled في النسخة العامة)",
    async () => {
      // الانحدار الحقيقي: enabled كان يُكتب فقط عند تبديل المفتاح يدوياً،
      // فتبقى بوابة متّصلة بلا الحقل ويُخفيها الـ checkout إلى الأبد.
      await db.doc(`stores/${STORE}/settings/freshgw`).set({
        credentials: { apiKey: "k" },
      });
      await store.recordConnectionResult({
        storeId: STORE,
        gatewayId: "freshgw",
        environment: "sandbox",
        result: { success: true, message: "تم" },
      });

      const pub = await db.doc(`stores/${STORE}/settings/store`).get();
      const mirror = pub.data().paymentGateways.freshgw;
      assertEqual(mirror.connected, true, "متّصلة");
      assertEqual(mirror.enabled, true, "مُفعّلة ضمناً");

      // وهذا بالضبط ما يفحصه الـ checkout
      assert(
        mirror.connected && mirror.enabled !== false,
        "يجب أن تمرّ شرط العرض في الـ checkout",
      );
    },
  );

  await checkAsync("تعطيل صريح يبقى معطّلاً بعد اختبار ناجح", async () => {
    await db
      .doc(`stores/${STORE}/settings/offgw`)
      .set({ credentials: { apiKey: "k" }, enabled: false });
    await store.recordConnectionResult({
      storeId: STORE,
      gatewayId: "offgw",
      environment: "sandbox",
      result: { success: true, message: "تم" },
    });

    const pub = await db.doc(`stores/${STORE}/settings/store`).get();
    const mirror = pub.data().paymentGateways.offgw;
    assertEqual(mirror.connected, true, "متّصلة");
    assertEqual(mirror.enabled, false, "لكن الأدمن عطّلها صراحةً");
    assert(
      !(mirror.connected && mirror.enabled !== false),
      "يجب ألّا تظهر للعميل",
    );
  });

  await checkAsync(
    "حفظ بعد اختبار ناجح لا يُخفي البوابة (الانحدار الذي رآه المستخدم)",
    async () => {
      const ref = db.doc(`stores/${STORE}/settings/savegw`);
      await ref.set({ credentials: { apiKey: "k" }, environment: "sandbox" });

      // ١) اختبار ناجح
      await store.recordConnectionResult({
        storeId: STORE,
        gatewayId: "savegw",
        environment: "sandbox",
        result: { success: true, message: "تم" },
      });
      let mirror = (
        await db.doc(`stores/${STORE}/settings/store`).get()
      ).data().paymentGateways.savegw;
      assertEqual(mirror.connected, true, "متّصلة بعد الاختبار");

      // ٢) الأدمن يضغط "حفظ الإعدادات" بنفس القيم — هذا ما كان يكسرها
      await store.writeGatewayCredentials({
        storeId: STORE,
        gatewayId: "savegw",
        credentials: { apiKey: "k" },
        environment: "sandbox",
        uid: "admin-1",
      });

      mirror = (
        await db.doc(`stores/${STORE}/settings/store`).get()
      ).data().paymentGateways.savegw;
      assertEqual(mirror.connected, true, "تبقى متّصلة بعد حفظ بلا تغيير");

      const priv = (await ref.get()).data();
      assertEqual(
        priv.connection.status,
        "connected",
        "والمستند الخاص يوافق النسخة العامة",
      );
    },
  );

  await checkAsync("تغيير مفتاح فعلي يُبطل الاتصال ويُخفي البوابة", async () => {
    await store.writeGatewayCredentials({
      storeId: STORE,
      gatewayId: "savegw",
      credentials: { apiKey: "DIFFERENT" },
      environment: "sandbox",
      uid: "admin-1",
    });
    const mirror = (
      await db.doc(`stores/${STORE}/settings/store`).get()
    ).data().paymentGateways.savegw;
    assertEqual(mirror.connected, false, "مفتاح جديد = اتصال غير مُثبت");
  });

  await checkAsync("تغيير البيئة وحدها يُبطل الاتصال", async () => {
    await db
      .doc(`stores/${STORE}/settings/envgw`)
      .set({ credentials: { apiKey: "k" }, environment: "sandbox" });
    await store.recordConnectionResult({
      storeId: STORE,
      gatewayId: "envgw",
      environment: "sandbox",
      result: { success: true, message: "تم" },
    });
    await store.writeGatewayCredentials({
      storeId: STORE,
      gatewayId: "envgw",
      credentials: { apiKey: "k" },
      environment: "production",
      uid: "admin-1",
    });
    const mirror = (
      await db.doc(`stores/${STORE}/settings/store`).get()
    ).data().paymentGateways.envgw;
    assertEqual(mirror.connected, false, "بيئة جديدة = إعادة اختبار");
    assertEqual(mirror.environment, "production", "البيئة تُحدّث");
  });

  await checkAsync("النسخة العامة تتبع المستند الخاص دائماً", async () => {
    // أياً كان ترتيب النداءات، الاثنان لا يفترقان.
    await db
      .doc(`stores/${STORE}/settings/syncgw`)
      .set({ credentials: { apiKey: "k" }, environment: "sandbox" });
    await store.recordConnectionResult({
      storeId: STORE,
      gatewayId: "syncgw",
      environment: "sandbox",
      result: { success: true, message: "تم" },
    });
    await store.setGatewayEnabled(STORE, "syncgw", false);
    await store.setGatewayEnabled(STORE, "syncgw", true);

    const priv = (
      await db.doc(`stores/${STORE}/settings/syncgw`).get()
    ).data();
    const mirror = (
      await db.doc(`stores/${STORE}/settings/store`).get()
    ).data().paymentGateways.syncgw;

    assertEqual(
      mirror.connected,
      priv.connection.status === "connected",
      "connected متطابق",
    );
    assertEqual(mirror.enabled, priv.enabled !== false, "enabled متطابق");
    assert(mirror.connected && mirror.enabled, "وتظهر للعميل");
  });

  await checkAsync("فشل الاعتماد يُنزّل البوابة فوراً", async () => {
    await store.markGatewayUnhealthy(STORE, "faketest", "401 من المزوّد");
    const pub = await db.doc(`stores/${STORE}/settings/store`).get();
    assertEqual(
      pub.data().paymentGateways.faketest.connected,
      false,
      "connected يصبح false",
    );
  });

  await checkAsync("حفظ مفاتيح جديدة يُخفي البوابة حتى تُختبر", async () => {
    await store.recordConnectionResult({
      storeId: STORE,
      gatewayId: "faketest",
      environment: "sandbox",
      result: { success: true, message: "تم" },
    });
    await store.writeGatewayCredentials({
      storeId: STORE,
      gatewayId: "faketest",
      credentials: { apiKey: "new-key" },
      environment: "production",
      uid: "admin-1",
    });

    const pub = await db.doc(`stores/${STORE}/settings/store`).get();
    const mirror = pub.data().paymentGateways.faketest;
    assertEqual(mirror.connected, false, "الحفظ وحده لا يُفعّل");
    assertEqual(mirror.environment, "production", "البيئة تُحدّث");

    const priv = await db.doc(`stores/${STORE}/settings/faketest`).get();
    assertEqual(priv.data().connection.status, "untested", "الحالة الخاصة");
    assertEqual(priv.data().tokenCache, undefined, "الرمز المخزّن يُبطَل");
  });

  await checkAsync("المستند العام لا يفقد بوابة أخرى عند التحديث", async () => {
    await store.mirrorPublicStatus(STORE, "othergw", { connected: true });
    await store.mirrorPublicStatus(STORE, "faketest", { connected: false });
    const pub = await db.doc(`stores/${STORE}/settings/store`).get();
    assertEqual(
      pub.data().paymentGateways.othergw.connected,
      true,
      "البوابة الأخرى باقية",
    );
    // وبقية إعدادات المتجر باقية أيضاً
    assert(pub.data().shipping, "إعدادات الشحن باقية");
  });

  await checkAsync("العرض الإداري يُقنّع الأسرار", async () => {
    await store.writeGatewayCredentials({
      storeId: STORE,
      gatewayId: "faketest",
      credentials: { apiKey: "sk_live_wxyz9876" },
      environment: "sandbox",
      uid: "admin-1",
    });
    const view = await store.readGatewayAdminView(STORE, fake, ["apiKey"]);
    assertEqual(view.fields.apiKey, "••••9876", "المفتاح مُقنّع");
    assert(
      !JSON.stringify(view).includes("sk_live"),
      "لا يتسرّب أي جزء من السرّ",
    );
  });

  await checkAsync(
    "مفاتيح تمارا/تابي القديمة في جذر المستند ما زالت تُقرأ",
    async () => {
      // tamaraSaveSettings القديمة تكتب apiToken في الجذر لا داخل credentials.
      // بدون التوافق الخلفي تفقد المتاجر المُعدّة مفاتيحها عند الترحيل.
      await db
        .doc(`stores/${STORE}/settings/tamara`)
        .set({ apiToken: "legacy-tamara-token" });
      const tamara = registry.GATEWAY_ADAPTERS.tamara;
      const loaded = await store.loadGatewayCredentials(STORE, tamara);
      assertEqual(loaded.creds.apiToken, "legacy-tamara-token", "مفتاح تمارا");

      await db
        .doc(`stores/${STORE}/settings/tabby`)
        .set({ publicKey: "pk_legacy", secretKey: "sk_legacy" });
      const tabby = registry.GATEWAY_ADAPTERS.tabby;
      const tabbyCreds = await store.loadGatewayCredentials(STORE, tabby);
      assertEqual(tabbyCreds.creds.publicKey, "pk_legacy", "المفتاح العام");
      assertEqual(tabbyCreds.creds.secretKey, "sk_legacy", "المفتاح السرّي");

      // والعرض الإداري يقنّع السرّي منهما فقط
      const view = await store.readGatewayAdminView(
        STORE,
        tabby,
        registry.secretFieldsOf("tabby"),
      );
      assertEqual(view.fields.publicKey, "pk_legacy", "العام يظهر كما هو");
      assertEqual(view.fields.secretKey, "••••gacy", "السرّي مُقنّع");
    },
  );

  await checkAsync(
    "مستند قديم بلا حقل بيئة يُعامل كإنتاج لا كتجربة",
    async () => {
      // العميل القديم كان يستخدم مضيف الإنتاج دائماً. افتراض "تجربة" هنا
      // يُرسل مفتاح إنتاج إلى مضيف التجربة فيفشل برسالة مُضلِّلة.
      await db
        .doc(`stores/${STORE}/settings/tamara`)
        .set({ apiToken: "legacy-token" });
      const legacy = await store.loadGatewayCredentials(
        STORE,
        registry.GATEWAY_ADAPTERS.tamara,
      );
      assertEqual(legacy.environment, "production", "بيئة المستند القديم");

      // بوابة غير مُعدّة إطلاقاً يجب أن تكون تجربة، لا إنتاجاً:
      // مستند فارغ ليس "مستنداً قديماً".
      await db.doc(`stores/${STORE}/settings/tamara`).set({});
      const empty = await store.loadGatewayCredentials(
        STORE,
        registry.GATEWAY_ADAPTERS.tamara,
      ).catch((error) => error);
      // بلا مفاتيح يرمي خطأ إعداد، فنقرأ البيئة من العرض الإداري بدلاً منه
      const emptyView = await store.readGatewayAdminView(
        STORE,
        registry.GATEWAY_ADAPTERS.tamara,
        [],
      );
      assertEqual(emptyView.environment, "sandbox", "بوابة فارغة = تجربة");
      assert(empty instanceof Error, "بلا مفاتيح يرمي خطأ إعداد");

      // أما المستند بالشكل الجديد فبيئته الافتراضية تجربة
      await db
        .doc(`stores/${STORE}/settings/tamara`)
        .set({ credentials: { apiToken: "new-token" } });
      const modern = await store.loadGatewayCredentials(
        STORE,
        registry.GATEWAY_ADAPTERS.tamara,
      );
      assertEqual(modern.environment, "sandbox", "بيئة الشكل الجديد");

      // والحقل الصريح يفوز دائماً
      await db
        .doc(`stores/${STORE}/settings/tamara`)
        .set({ apiToken: "t", environment: "sandbox" });
      const explicit = await store.loadGatewayCredentials(
        STORE,
        registry.GATEWAY_ADAPTERS.tamara,
      );
      assertEqual(explicit.environment, "sandbox", "الحقل الصريح");
    },
  );

  await checkAsync("الشكل الجديد يسبق الجذر عند وجود الاثنين", async () => {
    await db
      .doc(`stores/${STORE}/settings/tamara`)
      .set({ apiToken: "root-old", credentials: { apiToken: "nested-new" } });
    const loaded = await store.loadGatewayCredentials(
      STORE,
      registry.GATEWAY_ADAPTERS.tamara,
    );
    assertEqual(loaded.creds.apiToken, "nested-new", "الأحدث يفوز");
  });

  await checkAsync("سياق النداء يُشتقّ من نطاق المتجر لا من العميل", async () => {
    const ctx = await store.buildGatewayContext(STORE, "sandbox");
    assertEqual(ctx.baseUrl, "https://shop.test", "النطاق من مستند المتجر");
    assertEqual(ctx.storeId, STORE, "المتجر");
  });

  await checkAsync(
    "متجر بلا رابط: الاختبار ممكن، وإنشاء الدفع وحده يُمنع",
    async () => {
      // اختبار الاتصال لا يحتاج رابط عودة. رمي الخطأ عند بناء السياق كان
      // يمنع الأدمن من اختبار مفاتيحه أصلاً، فالخطأ انتقل إلى نقطة
      // الاستعمال الحقيقية.
      await db.doc("stores/nodomain").set({ name: "x", active: true });

      const ctx = await store.buildGatewayContext("nodomain", "sandbox");
      assertEqual(ctx.baseUrl, "", "الرابط فارغ بلا رمي خطأ");
      assertEqual(ctx.storeId, "nodomain", "المتجر");

      let message = "";
      try {
        store.requireStorefrontBaseUrl(ctx);
      } catch (error) {
        message = error.message;
      }
      assert(
        message.includes("رابط المتجر"),
        `رسالة غير متوقّعة: ${message}`,
      );
    },
  );

  await checkAsync("رابط المتجر يُقرأ من إعدادات اللوحة أيضاً", async () => {
    // جذر المتجر يملؤه سكربت الإنشاء، أما حقل اللوحة فيملؤه الأدمن بنفسه.
    await db.doc("stores/urlfromsettings").set({ name: "y", active: true });
    await db
      .doc("stores/urlfromsettings/settings/store")
      .set({ store: { storeUrl: "https://from-settings.test/" } });

    const ctx = await store.buildGatewayContext("urlfromsettings", "sandbox");
    assertEqual(
      ctx.baseUrl,
      "https://from-settings.test",
      "الرابط من الإعدادات بلا شرطة أخيرة",
    );
    assertEqual(
      store.requireStorefrontBaseUrl(ctx),
      "https://from-settings.test",
      "يمرّ التحقّق",
    );
  });

  await checkAsync("جذر المتجر يسبق حقل الإعدادات", async () => {
    await db
      .doc("stores/urlfromsettings")
      .set({ name: "y", active: true, domain: "https://root.test" });
    const ctx = await store.buildGatewayContext("urlfromsettings", "sandbox");
    assertEqual(ctx.baseUrl, "https://root.test", "الجذر يفوز");
  });
}

// ==================== التشغيل ====================

(async () => {
  console.log("تحقّق بوابات الدفع — MIS Pay / Madfu / neoleap");
  try {
    pureTests();
    await emulatorTests();
  } catch (error) {
    console.error("\nتوقّف التحقّق بخطأ غير متوقّع:", error);
    failed += 1;
  }

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed > 0 ? 1 : 0);
})();
