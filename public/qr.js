(() => {
  const VERSION = 4;
  const SIZE = 21 + 4 * (VERSION - 1);
  const DATA_CODEWORDS = 80;
  const ECC_CODEWORDS = 20;
  const ECL_BITS = 0b01; // L

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);

  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < GF_EXP.length; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }

  function gfMul(a, b) {
    if (!a || !b) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function polyMul(a, b) {
    const out = new Uint8Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        out[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return out;
  }

  function buildGenerator(degree) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < degree; i += 1) {
      poly = polyMul(poly, new Uint8Array([1, GF_EXP[i]]));
    }
    return poly;
  }

  const GENERATOR = buildGenerator(ECC_CODEWORDS);

  function toUtf8Bytes(text) {
    return new TextEncoder().encode(text);
  }

  function pushBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  }

  function buildCodewords(text) {
    const bytes = toUtf8Bytes(text);
    if (bytes.length > 78) {
      throw new Error('QR payload is too long for the local generator.');
    }

    const bits = [];
    pushBits(bits, 0b0100, 4);
    pushBits(bits, bytes.length, 8);
    for (const byte of bytes) {
      pushBits(bits, byte, 8);
    }

    const capacityBits = DATA_CODEWORDS * 8;
    const terminator = Math.min(4, capacityBits - bits.length);
    pushBits(bits, 0, terminator);
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const data = [];
    let padToggle = true;
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j += 1) {
        value = (value << 1) | bits[i + j];
      }
      data.push(value);
    }
    while (data.length < DATA_CODEWORDS) {
      data.push(padToggle ? 0xec : 0x11);
      padToggle = !padToggle;
    }

    return new Uint8Array(data);
  }

  function rsEncode(data) {
    const remainder = new Uint8Array(ECC_CODEWORDS);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      remainder.copyWithin(0, 1);
      remainder[ECC_CODEWORDS - 1] = 0;
      if (factor) {
        for (let i = 0; i < ECC_CODEWORDS; i += 1) {
          remainder[i] ^= gfMul(GENERATOR[i + 1], factor);
        }
      }
    }
    return remainder;
  }

  function createMatrix() {
    const matrix = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    const reserved = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));

    function set(r, c, value, reserve = true) {
      if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
      matrix[r][c] = Boolean(value);
      if (reserve) reserved[r][c] = true;
    }

    function reserve(r, c) {
      if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
      reserved[r][c] = true;
    }

    function drawFinder(top, left) {
      for (let r = -1; r <= 7; r += 1) {
        for (let c = -1; c <= 7; c += 1) {
          const rr = top + r;
          const cc = left + c;
          if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
          const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
          const isCore = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const isDark = isCore && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(rr, cc, isBorder ? false : isDark, true);
        }
      }
    }

    function drawAlignment(centerRow, centerCol) {
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const rr = centerRow + r;
          const cc = centerCol + c;
          const ring = Math.max(Math.abs(r), Math.abs(c));
          const dark = ring === 2 || (ring === 0);
          set(rr, cc, dark, true);
        }
      }
    }

    function drawTiming() {
      for (let i = 8; i < SIZE - 8; i += 1) {
        set(6, i, i % 2 === 0, true);
        set(i, 6, i % 2 === 0, true);
      }
    }

    function reserveFormatAreas() {
      for (let i = 0; i < 9; i += 1) {
        if (i !== 6) {
          reserve(8, i);
          reserve(i, 8);
        }
      }
      for (let i = 0; i < 8; i += 1) {
        reserve(SIZE - 1 - i, 8);
        reserve(8, SIZE - 1 - i);
      }
      reserve(8, SIZE - 8);
    }

    drawFinder(0, 0);
    drawFinder(0, SIZE - 7);
    drawFinder(SIZE - 7, 0);
    drawAlignment(26, 26);
    drawTiming();
    reserveFormatAreas();
    set(SIZE - 8, 8, true, true);

    return { matrix, reserved };
  }

  function placeData(matrix, reserved, bits) {
    let bitIndex = 0;
    let upward = true;

    for (let col = SIZE - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;

      for (let rowOffset = 0; rowOffset < SIZE; rowOffset += 1) {
        const row = upward ? SIZE - 1 - rowOffset : rowOffset;
        for (let dx = 0; dx < 2; dx += 1) {
          const c = col - dx;
          if (reserved[row][c]) continue;
          const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
          matrix[row][c] = Boolean(bit);
          bitIndex += 1;
        }
      }

      upward = !upward;
    }
  }

  function maskApplies(mask, row, col) {
    switch (mask) {
      case 0:
        return (row + col) % 2 === 0;
      case 1:
        return row % 2 === 0;
      case 2:
        return col % 3 === 0;
      case 3:
        return (row + col) % 3 === 0;
      case 4:
        return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5:
        return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6:
        return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7:
        return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
      default:
        return false;
    }
  }

  function cloneMatrix(matrix) {
    return matrix.map((row) => row.slice());
  }

  function addFormatInfo(matrix, mask) {
    const data = (ECL_BITS << 3) | mask;
    let format = data << 10;
    const generator = 0x537;
    for (let i = 14; i >= 10; i -= 1) {
      if ((format >> i) & 1) {
        format ^= generator << (i - 10);
      }
    }
    const formatted = ((data << 10) | format) ^ 0x5412;

    const coordsA = [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
    ];
    const coordsB = [
      [SIZE - 1, 8],
      [SIZE - 2, 8],
      [SIZE - 3, 8],
      [SIZE - 4, 8],
      [SIZE - 5, 8],
      [SIZE - 6, 8],
      [SIZE - 7, 8],
      [8, SIZE - 8],
      [8, SIZE - 7],
      [8, SIZE - 6],
      [8, SIZE - 5],
      [8, SIZE - 4],
      [8, SIZE - 3],
      [8, SIZE - 2],
      [8, SIZE - 1],
    ];

    for (let i = 0; i < 15; i += 1) {
      const bit = (formatted >> (14 - i)) & 1;
      const [rA, cA] = coordsA[i];
      const [rB, cB] = coordsB[i];
      matrix[rA][cA] = Boolean(bit);
      matrix[rB][cB] = Boolean(bit);
    }
  }

  function penaltyScore(matrix) {
    let penalty = 0;

    for (let r = 0; r < SIZE; r += 1) {
      let runColor = matrix[r][0];
      let runLength = 1;
      for (let c = 1; c < SIZE; c += 1) {
        if (matrix[r][c] === runColor) {
          runLength += 1;
        } else {
          if (runLength >= 5) penalty += 3 + (runLength - 5);
          runColor = matrix[r][c];
          runLength = 1;
        }
      }
      if (runLength >= 5) penalty += 3 + (runLength - 5);
    }

    for (let c = 0; c < SIZE; c += 1) {
      let runColor = matrix[0][c];
      let runLength = 1;
      for (let r = 1; r < SIZE; r += 1) {
        if (matrix[r][c] === runColor) {
          runLength += 1;
        } else {
          if (runLength >= 5) penalty += 3 + (runLength - 5);
          runColor = matrix[r][c];
          runLength = 1;
        }
      }
      if (runLength >= 5) penalty += 3 + (runLength - 5);
    }

    for (let r = 0; r < SIZE - 1; r += 1) {
      for (let c = 0; c < SIZE - 1; c += 1) {
        const color = matrix[r][c];
        if (color === matrix[r][c + 1] && color === matrix[r + 1][c] && color === matrix[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }

    const pattern1 = [true, false, true, true, true, false, true];
    const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];

    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c <= SIZE - 7; c += 1) {
        let match1 = true;
        for (let i = 0; i < 7; i += 1) {
          if (matrix[r][c + i] !== pattern1[i]) {
            match1 = false;
            break;
          }
        }
        if (match1 && ((c >= 4 && matrix[r].slice(c - 4, c).every((v) => !v)) || (c + 11 <= SIZE && matrix[r].slice(c + 7, c + 11).every((v) => !v)))) {
          penalty += 40;
        }
      }
    }

    for (let c = 0; c < SIZE; c += 1) {
      for (let r = 0; r <= SIZE - 7; r += 1) {
        let match1 = true;
        for (let i = 0; i < 7; i += 1) {
          if (matrix[r + i][c] !== pattern1[i]) {
            match1 = false;
            break;
          }
        }
        if (match1 && ((r >= 4 && matrix.slice(r - 4, r).every((row) => !row[c])) || (r + 11 <= SIZE && matrix.slice(r + 7, r + 11).every((row) => !row[c])))) {
          penalty += 40;
        }
      }
    }

    let dark = 0;
    for (const row of matrix) {
      for (const cell of row) {
        if (cell) dark += 1;
      }
    }
    const percent = (dark * 100) / (SIZE * SIZE);
    penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return penalty;
  }

  function buildMatrix(text) {
    const data = buildCodewords(text);
    const ecc = rsEncode(data);

    const bits = [];
    for (const byte of data) {
      pushBits(bits, byte, 8);
    }
    for (const byte of ecc) {
      pushBits(bits, byte, 8);
    }

    let best = null;
    let bestMask = 0;
    let bestPenalty = Infinity;

    for (let mask = 0; mask < 8; mask += 1) {
      const { matrix, reserved } = createMatrix();
      placeData(matrix, reserved, bits);
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          if (!reserved[r][c] && maskApplies(mask, r, c)) {
            matrix[r][c] = !matrix[r][c];
          }
        }
      }
      addFormatInfo(matrix, mask);
      const score = penaltyScore(matrix);
      if (score < bestPenalty) {
        bestPenalty = score;
        bestMask = mask;
        best = matrix;
      }
    }

    return { matrix: best, mask: bestMask };
  }

  function renderSvg(matrix, size, margin) {
    const moduleCount = matrix.length;
    const totalModules = moduleCount + margin * 2;
    const viewBox = `0 0 ${totalModules} ${totalModules}`;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}" shape-rendering="crispEdges">`,
      `<rect width="100%" height="100%" fill="#fff"/>`,
    ];

    for (let r = 0; r < moduleCount; r += 1) {
      for (let c = 0; c < moduleCount; c += 1) {
        if (matrix[r][c]) {
          parts.push(`<rect x="${c + margin}" y="${r + margin}" width="1" height="1" fill="#111"/>`);
        }
      }
    }

    parts.push('</svg>');
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(parts.join(''))}`;
  }

  function createQrDataUrl(text, options = {}) {
    const size = options.size ?? 240;
    const margin = options.margin ?? 4;
    const { matrix } = buildMatrix(text);
    return renderSvg(matrix, size, margin);
  }

  window.createQrDataUrl = createQrDataUrl;
})();
