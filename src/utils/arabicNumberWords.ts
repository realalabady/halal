/**
 * المبلغ كتابةً بالعربية — «ألف وثلاثمائة وعشرون ريالاً وخمسون هللة».
 *
 * سطر معتاد على الفواتير السعودية، وهو ما يجعل الوثيقة تُقرأ رسمية: الرقم
 * قابل للتحريف بحرف واحد، والكتابة تُثبّته. يغطّي ٠ إلى ٩٩٩٩٩٩٩٩٩.٩٩.
 */

const ONES = [
  "",
  "واحد",
  "اثنان",
  "ثلاثة",
  "أربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمانية",
  "تسعة",
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
];

const TENS = [
  "",
  "",
  "عشرون",
  "ثلاثون",
  "أربعون",
  "خمسون",
  "ستون",
  "سبعون",
  "ثمانون",
  "تسعون",
];

const HUNDREDS = [
  "",
  "مائة",
  "مائتان",
  "ثلاثمائة",
  "أربعمائة",
  "خمسمائة",
  "ستمائة",
  "سبعمائة",
  "ثمانمائة",
  "تسعمائة",
];

/** صيغ الآحاد/المثنى/الجمع لكل رتبة. العربية تُعرب العدد، فلا تكفي لاحقة واحدة. */
interface ScaleForms {
  singular: string;
  dual: string;
  /** ٣–١٠ من الرتبة */
  plural: string;
  /** ١١ وما فوق من الرتبة */
  many: string;
}

const SCALES: ScaleForms[] = [
  { singular: "", dual: "", plural: "", many: "" },
  { singular: "ألف", dual: "ألفان", plural: "آلاف", many: "ألفاً" },
  { singular: "مليون", dual: "مليونان", plural: "ملايين", many: "مليوناً" },
];

/** يكتب عدداً من ٠ إلى ٩٩٩. */
function belowThousand(n: number): string {
  if (n === 0) return "";
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds > 0) parts.push(HUNDREDS[hundreds]);

  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]);
    } else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      // العربية تقدّم الآحاد على العشرات: «خمسة وعشرون».
      parts.push(ones > 0 ? `${ONES[ones]} و${TENS[tens]}` : TENS[tens]);
    }
  }

  return parts.join(" و");
}

/** يختار صيغة الرتبة الصحيحة حسب عدد وحداتها. */
function scaleWord(count: number, scale: ScaleForms): string {
  if (count === 1) return scale.singular;
  if (count === 2) return scale.dual;
  if (count >= 3 && count <= 10) return `${belowThousand(count)} ${scale.plural}`;
  return `${belowThousand(count)} ${scale.many}`;
}

/** يكتب عدداً صحيحاً حتى ٩٩٩٩٩٩٩٩٩ كلماتٍ عربية. */
export function integerToArabicWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "صفر";

  // تقسيم إلى مجموعات ثلاثية من اليمين: آحاد، آلاف، ملايين.
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group === 0) continue;
    parts.push(i === 0 ? belowThousand(group) : scaleWord(group, SCALES[i]));
  }

  return parts.join(" و");
}

/**
 * المبلغ كاملاً بالريال والهللة.
 * مثال: 1320.5 ⇒ «ألف وثلاثمائة وعشرون ريالاً وخمسون هللة فقط»
 */
export function toArabicWords(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.abs(amount) : 0;
  const riyals = Math.floor(safe);
  // الضرب في ١٠٠ على أعداد عشرية يُخرج 49.999…، فالتقريب قبل الاقتطاع لازم.
  const halalas = Math.round((safe - riyals) * 100);

  const riyalWords = `${integerToArabicWords(riyals)} ${riyals === 1 ? "ريال" : riyals === 2 ? "ريالان" : "ريالاً"}`;

  if (halalas === 0) return `${riyalWords} فقط`;

  const halalaWords = `${integerToArabicWords(halalas)} ${halalas === 1 ? "هللة" : halalas === 2 ? "هللتان" : "هللة"}`;
  return `${riyalWords} و${halalaWords} فقط`;
}
