/**
 * مُولّد رمز QR — نمط البايت، تصحيح أخطاء من المستوى M، الإصدارات ١–١٠.
 *
 * لماذا بلا مكتبة: الفاتورة تُطبع ويُفترض أن يُمسح رمزها بعد سنوات، فلا نريد
 * اعتماداً خارجياً لرسم مصفوفة. المخرَج مصفوفة منطقية يرسمها المكوّن SVG
 * متجهاً — فيبقى حادّاً عند أي دقّة طباعة، بخلاف أي صورة نقطية.
 *
 * المرجع: ISO/IEC 18004. الجداول أدناه للمستوى M وحده، وهو ما يكفي رابطاً
 * قصيراً (٢١٣ بايتاً عند الإصدار ١٠).
 */

/** سعة البايتات لكل إصدار عند المستوى M. الفهرس = الإصدار − ١. */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** إجمالي كلمات الرمز (بيانات + تصحيح) لكل إصدار. */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** كلمات التصحيح لكل كتلة، المستوى M. */
const EC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/**
 * بنية الكتل: [عدد كتل المجموعة ١، بياناتها]، [عدد كتل المجموعة ٢، بياناتها].
 * المجموعة الثانية بصفر عدد تعني أن كل الكتل متساوية.
 */
const BLOCKS_M: [number, number, number, number][] = [
  [1, 16, 0, 0], // v1
  [1, 28, 0, 0], // v2
  [1, 44, 0, 0], // v3
  [2, 32, 0, 0], // v4
  [2, 43, 0, 0], // v5
  [4, 27, 0, 0], // v6
  [4, 31, 0, 0], // v7
  [2, 38, 2, 39], // v8
  [3, 36, 2, 37], // v9
  [4, 43, 1, 44], // v10
];

/** مراكز أنماط المحاذاة لكل إصدار. */
const ALIGNMENT_CENTERS: number[][] = [
  [], // v1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// ==================== حساب GF(256) ====================
// الحقل المحدود الذي يقوم عليه Reed-Solomon، بالمولّد 2 والكثيرة 0x11D.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

/** كثيرة المولّد لعدد معيّن من كلمات التصحيح. */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** كلمات التصحيح لكتلة بيانات واحدة. */
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = rsGeneratorPoly(ecCount);
  const remainder = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;
    if (factor !== 0) {
      // generator[0] دائماً 1، فنبدأ من 1 ونُسقط آخر حدّ.
      for (let i = 0; i < ecCount; i++) {
        remainder[i] ^= gfMul(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

// ==================== معلومات النسق والإصدار ====================

/** BCH(15,5) لمعلومات النسق، مع قناع ISO الثابت. */
function formatInfoBits(maskPattern: number): number {
  // المستوى M = 0b00، فالبتات الخمس هي 0b00 ثم القناع.
  const data = maskPattern & 0b111;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (value & (1 << (i + 10))) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** BCH(18,6) لمعلومات الإصدار (الإصدار ٧ وما فوق فقط). */
function versionInfoBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (value & (1 << (i + 12))) value ^= 0b1111100100101 << i;
  }
  return (version << 12) | value;
}

// ==================== الأقنعة ====================

const MASK_FNS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

// ==================== بناء المصفوفة ====================

type Grid = (boolean | null)[][];

function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= grid.length || x < 0 || x >= grid.length) continue;
      const inOuter = r >= 0 && r <= 6 && (c === 0 || c === 6);
      const inOuter2 = c >= 0 && c <= 6 && (r === 0 || r === 6);
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[y][x] = inOuter || inOuter2 || inCore;
    }
  }
}

function placeAlignment(grid: Grid, version: number): void {
  const centers = ALIGNMENT_CENTERS[version - 1];
  if (centers.length === 0) return;
  const first = centers[0];
  const last = centers[centers.length - 1];
  for (const row of centers) {
    for (const col of centers) {
      // الزوايا الثلاث تحملها أنماط التحديد، فتُستثنى بموضعها لا بالفحص.
      //
      // الفحص «هل الخانة مشغولة؟» يبدو كافياً وليس كذلك: مركز (6, المتوسط)
      // يقع على صف التوقيت فيُقرأ مشغولاً، فيُحذف نمط محاذاة واجب — وهو
      // ما يُبطل كل رمز من الإصدار ٧ وما فوق، حيث يظهر هذا المركز أول مرة.
      const isFinderCorner =
        (row === first && col === first) ||
        (row === first && col === last) ||
        (row === last && col === first);
      if (isFinderCorner) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          grid[row + r][col + c] = ring !== 1;
        }
      }
    }
  }
}

/** المواضع المحجوزة للنسق والإصدار، تُعلَّم قبل وضع البيانات. */
function reserveFormatAreas(grid: Grid, version: number): void {
  const size = grid.length;
  for (let i = 0; i < 9; i++) {
    if (grid[8][i] === null) grid[8][i] = false;
    if (grid[i][8] === null) grid[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = false;
    if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = false;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        grid[size - 11 + j][i] = false;
        grid[i][size - 11 + j] = false;
      }
    }
  }
}

function writeFormatInfo(grid: Grid, maskPattern: number): void {
  const size = grid.length;
  const bits = formatInfoBits(maskPattern);
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> i) & 1) === 1;
    // النسخة حول الزاوية العليا اليسرى.
    if (i < 6) grid[i][8] = bit;
    else if (i === 6) grid[7][8] = bit;
    else if (i === 7) grid[8][8] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;
    // النسخة المكرّرة على الحافتين.
    if (i < 8) grid[8][size - 1 - i] = bit;
    else grid[size - 15 + i][8] = bit;
  }
  // وحدة داكنة ثابتة.
  grid[size - 8][8] = true;
}

function writeVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    grid[b][a] = bit;
    grid[a][b] = bit;
  }
}

/** درجة عقوبة القناع — أربع قواعد ISO. الأدنى يفوز. */
function maskPenalty(grid: boolean[][]): number {
  const size = grid.length;
  let penalty = 0;

  // قاعدة ١: سلاسل متجانسة بطول ٥ أو أكثر.
  const scanRuns = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) penalty += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) penalty += 3 + (run - 5);
    }
  };
  scanRuns((a, b) => grid[a][b]);
  scanRuns((a, b) => grid[b][a]);

  // قاعدة ٢: مربّعات ٢×٢ متجانسة.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // قاعدة ٣: النمط 1:1:3:1:1 المشابه لنمط التحديد، مع أربع وحدات فاتحة.
  const pattern = [true, false, true, true, true, false, true];
  const matchesAt = (
    get: (k: number) => boolean,
    start: number,
    limit: number,
  ): boolean => {
    for (let k = 0; k < 7; k++) if (get(start + k) !== pattern[k]) return false;
    const leftClear = (() => {
      for (let k = 1; k <= 4; k++) {
        if (start - k < 0) return true;
        if (get(start - k)) return false;
      }
      return true;
    })();
    const rightClear = (() => {
      for (let k = 7; k <= 10; k++) {
        if (start + k >= limit) return true;
        if (get(start + k)) return false;
      }
      return true;
    })();
    return leftClear || rightClear;
  };
  for (let a = 0; a < size; a++) {
    for (let b = 0; b <= size - 7; b++) {
      if (matchesAt((k) => grid[a][k], b, size)) penalty += 40;
      if (matchesAt((k) => grid[k][a], b, size)) penalty += 40;
    }
  }

  // قاعدة ٤: انحراف نسبة الوحدات الداكنة عن ٥٠٪.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

/**
 * يُولّد مصفوفة QR من نص. true = وحدة داكنة.
 * يُرجع null إذا تجاوز النص سعة الإصدار ١٠ (٢١٣ بايتاً) — المتصل يُخفي الرمز
 * بدل أن يرسم مصفوفة مقطوعة لا تُمسح.
 */
export function generateQrMatrix(text: string): boolean[][] | null {
  const data = new TextEncoder().encode(text);
  const version = BYTE_CAPACITY_M.findIndex((cap) => data.length <= cap) + 1;
  if (version === 0) return null;

  const vIdx = version - 1;
  const totalCodewords = TOTAL_CODEWORDS[vIdx];
  const ecPerBlock = EC_PER_BLOCK_M[vIdx];
  const [count1, dataPerBlock1, count2, dataPerBlock2] = BLOCKS_M[vIdx];
  const totalDataCodewords = count1 * dataPerBlock1 + count2 * dataPerBlock2;

  // ----- بتات البيانات: نمط البايت (0100) + عدد المحارف + البايتات -----
  const bits: number[] = [];
  const pushBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(data.length, version >= 10 ? 16 : 8);
  for (const byte of data) pushBits(byte, 8);

  // مُحدِّد النهاية ثم الحشو إلى حدّ البايت.
  const capacityBits = totalDataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    dataCodewords[i] = byte;
  }
  // بايتات الحشو المعيارية، بالتبادل.
  const PADS = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalDataCodewords; i++, p++) {
    dataCodewords[i] = PADS[p % 2];
  }

  // ----- تقسيم الكتل وتصحيح الأخطاء -----
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  const blockSpec: number[] = [
    ...Array(count1).fill(dataPerBlock1),
    ...Array(count2).fill(dataPerBlock2),
  ];
  for (const size of blockSpec) {
    const block = dataCodewords.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // ----- التشذير: كلمة من كل كتلة بالدور، ثم كلمات التصحيح كذلك -----
  const final = new Uint8Array(totalCodewords);
  let pos = 0;
  const maxData = Math.max(...blockSpec);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) final[pos++] = block[i];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) final[pos++] = block[i];
  }

  // ----- بناء الشبكة -----
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );

  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);

  // أنماط التوقيت.
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0;
    if (grid[6][i] === null) grid[6][i] = on;
    if (grid[i][6] === null) grid[i][6] = on;
  }

  placeAlignment(grid, version);
  reserveFormatAreas(grid, version);

  // ----- وضع البيانات: أعمدة مزدوجة من اليمين، صعوداً ثم هبوطاً -----
  const dataBits: number[] = [];
  for (const byte of final) for (let b = 7; b >= 0; b--) dataBits.push((byte >> b) & 1);

  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    // العمود ٦ عمود توقيت كامل، فيُتخطّى ولا يُحسب ضمن الأزواج.
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (grid[row][c] !== null) continue;
        grid[row][c] = bitIndex < dataBits.length && dataBits[bitIndex] === 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }

  // المواضع المحجوزة التي لا تحمل بيانات تُثبَّت قبل التقنيع.
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  // نُعيد بناء خريطة المواضع الوظيفية بنفس الخطوات على شبكة فارغة.
  const probe: Grid = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );
  placeFinder(probe, 0, 0);
  placeFinder(probe, 0, size - 7);
  placeFinder(probe, size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    if (probe[6][i] === null) probe[6][i] = i % 2 === 0;
    if (probe[i][6] === null) probe[i][6] = i % 2 === 0;
  }
  placeAlignment(probe, version);
  reserveFormatAreas(probe, version);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) isFunction[r][c] = probe[r][c] !== null;
  }

  // ----- اختيار القناع بأقل عقوبة -----
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate: Grid = grid.map((row) => [...row]);
    const fn = MASK_FNS[mask];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (isFunction[r][c]) continue;
        if (fn(r, c)) candidate[r][c] = !candidate[r][c];
      }
    }
    writeFormatInfo(candidate, mask);
    writeVersionInfo(candidate, version);
    const solid = candidate.map((row) => row.map((cell) => cell === true));
    const penalty = maskPenalty(solid);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = solid;
    }
  }

  return best;
}

/**
 * مسار SVG واحد يرسم كل الوحدات الداكنة.
 * مسار واحد بدل مئات المستطيلات: أصغر في DOM وأسرع في الطباعة.
 */
export function qrMatrixToSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return parts.join("");
}
