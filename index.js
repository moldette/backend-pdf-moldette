

import { PNG } from "pngjs";
import express from "express";
import multer from "multer";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const execFileAsync = promisify(execFile);
const app = express();

const allowedOrigins = new Set([
  "https://www.moldette.pt",
  "https://moldette.pt",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
]);

// ✅ CORS manual: garante headers mesmo quando dá erro/404
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin"); // importante para caches
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // ✅ Responde logo ao preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   CONFIG
========================= */

const PDFTOPPM = process.env.PDFTOPPM || (process.platform === "win32"
  ? "C:\\poppler\\poppler-25.12.0\\Library\\bin\\pdftoppm.exe"
  : "pdftoppm");

const RENDER_DPI = 120;
const CROP_MARGIN_PX = 25;
const FALLBACK_CROP_H = 900;

/* =========================
   HELPERS
========================= */

function bufferToUint8Array(buf) {
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* =========================
   TEXTO (pdfjs) + posição do "Tecido"
========================= */

async function extractTextAndTecidoY(pdfBuffer) {
  const data = bufferToUint8Array(pdfBuffer);

  const pdf = await pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const pageHeightPts = viewport.height;
  const pageWidthPts = viewport.width;

  const text = await page.getTextContent();

  let tecidoY = null;

  // agrupar items por linha (Y)
  const linesMap = new Map(); // yKey -> { y, items: [{x,str}] }

  for (const item of text.items) {
    const str = String(item.str || "").replace(/\u00A0/g, " ").trim();
    if (!str) continue;

    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;

    // detectar "Tecido" (posição Y) como tinhas
    if (tecidoY === null && str.toLowerCase().includes("tecido")) {
      tecidoY = y;
    }

    // chave de linha: arredondar y para reduzir “micro-variações”
    const yKey = Math.round(y * 2) / 2; // 0.5pt

    if (!linesMap.has(yKey)) linesMap.set(yKey, { y: yKey, items: [] });
    linesMap.get(yKey).items.push({ x, str });
  }

  // ordenar linhas de cima para baixo (y desc)
  const lines = Array.from(linesMap.values())
    .sort((a, b) => b.y - a.y)
    .map((ln) => {
      // ordenar itens da linha da esquerda para a direita
      ln.items.sort((a, b) => a.x - b.x);
      // juntar com espaço (não \n!)
      return ln.items.map((it) => it.str).join(" ").replace(/[ \t]+/g, " ").trim();
    })
    .filter(Boolean);

  return {
    text: lines.join("\n"),     // ✅ agora sim: texto com linhas reais
    tecidoY,
    pageHeightPts,
    pageWidthPts,
  };
}

function parseTabelaTamanhosModelos(rawText) {
  const linhas = String(rawText || "")
    .split(/\r?\n/)
    .map(l => l.replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  // 1) encontrar cabeçalho (mais tolerante)
  // Aceita "Completos" ou "Completo(s)" e não exige que tudo esteja na mesma linha.
  let inicio = -1;

  for (let i = 0; i < linhas.length; i++) {
    const L = linhas[i].toLowerCase();

    const hasTamanho = L.includes("tamanho");
    const hasModelo = L.includes("modelo");
    const hasCompletos = L.includes("completo"); // cobre completos / completo(s)

    // regra tolerante: se tem "tamanho" e "modelo", e (idealmente) "completo"
    if (hasTamanho && hasModelo) {
      // se não tiver "completo" nesta linha, tenta ver nas próximas 2 linhas (pdfjs às vezes parte o header)
      const next1 = (linhas[i + 1] || "").toLowerCase();
      const next2 = (linhas[i + 2] || "").toLowerCase();
      const hasCompletosNear = hasCompletos || next1.includes("completo") || next2.includes("completo");

      if (hasCompletosNear) {
        inicio = i;
        break;
      }
    }
  }

  // garante shape consistente
  if (inicio === -1) return { rows: [], modelos: [], tamanhos: [], qtyByModelo: {} };

  // 2) ler linhas da tabela
  // Em vez de regex rígido, faz split e interpreta:
  // tamanho = 1º token
  // completos = 2º token numérico
  // moldes = 3º token numérico
  // modelo = resto (pode ter hífens, barras, etc.)
  const rows = [];

  for (let j = inicio + 1; j < linhas.length; j++) {
    const linha = linhas[j].trim();
    if (!linha) break;

    const parts = linha.split(" ").filter(Boolean);

    // precisa pelo menos de: tamanho + completos + moldes + modelo(…)
    if (parts.length < 4) break;

    const tamanho = parts[0];
    const completos = Number(parts[1]);
    const moldes = Number(parts[2]);

    // se não forem números, provavelmente acabou a tabela
    if (!Number.isFinite(completos) || !Number.isFinite(moldes)) break;

    const modelo = parts.slice(3).join(" ").trim();
    if (!modelo) break;

    rows.push({ tamanho, completos, moldes, modelo });
  }

  const modelos = Array.from(new Set(rows.map(r => r.modelo))).sort((a, b) => a.localeCompare(b));
  const tamanhos = Array.from(new Set(rows.map(r => String(r.tamanho || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  const qtyByModelo = {};
  for (const r of rows) {
    if (!qtyByModelo[r.modelo]) qtyByModelo[r.modelo] = {};
    qtyByModelo[r.modelo][r.tamanho] = (qtyByModelo[r.modelo][r.tamanho] ?? 0) + (r.completos ?? 0);
  }

  return { rows, modelos, tamanhos, qtyByModelo };
}


function cleanMaterialValue(raw) {
  const s = String(raw ?? "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!s) return null;

  // caso venha "1 Tipo: PLANO Sentido único: Não"
  const idxTipo = s.toLowerCase().indexOf("tipo:");
  if (idxTipo >= 0) return s.slice(0, idxTipo).trim();

  return s;
}

function extractFieldsFromText(text) {
  const rawText = String(text || ""); // 👈 mantém linhas
  const t = rawText
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  function grab(re) {
    const m = t.match(re);
    return m ? String(m[1]).trim() : null;
  }

  const num = /([\d]+(?:[.,]\d+)?)/;

  function grabNumberAfterLabel(labelRe) {
    const m = t.match(labelRe);
    if (!m) return null;

    const idx = m.index ?? 0;
    const after = t.slice(idx + m[0].length, idx + m[0].length + 120);
    const n = after.match(num);
    return n ? String(n[1]).trim() : null;
  }

  const fatorEscalaX =
    grabNumberAfterLabel(/Fator[\s\S]{0,40}escala[\s\S]{0,20}X/i) ||
    grabNumberAfterLabel(/Fator[\s\S]{0,40}X/i);

  const fatorEscalaY =
    grabNumberAfterLabel(/Fator[\s\S]{0,40}escala[\s\S]{0,20}Y/i) ||
    grabNumberAfterLabel(/Fator[\s\S]{0,40}Y/i);

  // ✅ NOVO: Modelo
  const modelo = grab(/Modelo\s*[:\-]?\s*(.+?)(?:\n|$)/i);

// ✅ NOVO: Sentido único (Sim/Não)
// No mini-plano aparece em linha corrida: "Tipo: PLANO Sentido único: Sim ..."
// Portanto NÃO pode depender de "\n" ou "$" a seguir.
const sentidoUnico = (() => {
  const m = t.match(/Sentido\s*único\s*[:\-]?\s*(Sim|N[aã]o)\b/i);
  if (!m) return null;
  return m[1].toLowerCase().startsWith("sim") ? "Sim" : "Não";
})();


  // ✅ NOVO: tabela tamanhos/modelos
  const tabela = parseTabelaTamanhosModelos(rawText);

  // compat: se só houver 1 modelo, mantemos pecasPorTamanho como antes
  const pecasPorTamanho =
    tabela.modelos.length === 1 ? (tabela.qtyByModelo[tabela.modelos[0]] || {}) : {};


// ✅ Tecido/Material: só o texto entre "Tecido:" e "Tipo:" (ou fim da linha)
const tecidoRaw =
  grab(/Tecido\s*[:\-]?\s*(.+?)(?=\s*Tipo\s*:|\n|$)/i) ||
  grab(/Material\s*[:\-]?\s*(.+?)(?=\s*Tipo\s*:|\n|$)/i);

return {
  tecido: cleanMaterialValue(tecidoRaw),

    fatorEscalaX,
    fatorEscalaY,

    aproveitamento: grab(new RegExp(`Aproveitamento\\s*[:\\-]?\\s*${num.source}\\s*%?`, "i")),
    comprimento: grab(new RegExp(`Comprimento\\s*[:\\-]?\\s*${num.source}`, "i")),
    largura: grab(new RegExp(`Largura\\s*[:\\-]?\\s*${num.source}`, "i")),

    descricao: grab(/Descri[cç][aã]o\s*[:\-]?\s*(.+?)(?:\n|$)/i),
    observacoes: grab(/Observa[cç][oõ]es\s*[:\-]?\s*(.+?)(?:\n|$)/i),

    // ✅ NOVOS
    modelo,
    sentidoUnico, // "Sim" | "Não" | null

    tabela,           // ✅ devolve a estrutura completa
    pecasPorTamanho,  // ✅ compat com o teu Planning atual

  };
}

/* =========================
   IMAGEM (Poppler) + crop dinâmico por "Tecido"
========================= */

function tecidoYToCropHeightPx(tecidoY, pageHeightPts, dpi) {
  if (!Number.isFinite(tecidoY) || !Number.isFinite(pageHeightPts)) return null;

  const yFromTopPts = pageHeightPts - tecidoY;
  const pxPerPt = dpi / 72;
  const yFromTopPx = yFromTopPts * pxPerPt;

  const cropH = Math.floor(yFromTopPx - CROP_MARGIN_PX);
  return cropH;
}

async function renderPage1ToImage(pdfBuffer, cropHpx = null, footerLikely = false) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plano-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");

  await fs.writeFile(pdfPath, Buffer.from(pdfBuffer));

  // Mantém a renderização como estável
  await execFileAsync(PDFTOPPM, [
    "-f", "1",
    "-l", "1",
    "-png",
    "-r", "120",
    pdfPath,
    outPrefix
  ]);

  const imgPath = `${outPrefix}-1.png`;
  const imgBuf = await fs.readFile(imgPath);

  // -------- helpers (pure JS) --------
  function isWhite(r, g, b, a) {
    if (a === 0) return true;
    return r >= 245 && g >= 245 && b >= 245;
  }

  function rowInkRatio(png, y) {
    const { width, data } = png;
    let ink = 0;
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (!isWhite(r, g, b, a)) ink++;
    }
    return ink / width;
  }

function findCropTopBelowLogo(png) {
  const H = png.height;
  const startY = 0;

  // antes era 0.40; deixo 0.60 para ter margem e ainda assim ser seguro
  const endY = Math.min(H - 1, Math.floor(H * 0.60));

  // branco “mesmo branco”
  const WHITE_ROW_MAX_INK = 0.004;

  // precisamos de um branco comprido para ser um “separador”
  const NEED_CONSECUTIVE = 18;

  // considera que “há tinta” se passar este valor
  // (mais alto do que WHITE_ROW_MAX_INK para não confundir ruído)
  const INK_ROW_MIN = 0.012;

  let seenInk = false;
  let runStart = -1;
  let runCount = 0;

  // 👉 novo: devolve o PRIMEIRO bloco branco grande *depois* de vermos tinta
  for (let y = startY; y <= endY; y++) {
    const r = rowInkRatio(png, y);

    if (!seenInk && r >= INK_ROW_MIN) {
      seenInk = true;
    }

    const isWhiteRow = r <= WHITE_ROW_MAX_INK;

    if (seenInk && isWhiteRow) {
      if (runStart < 0) runStart = y;
      runCount++;

      if (runCount >= NEED_CONSECUTIVE) {
        const gapEnd = y;

        // posiciona o topo um pouco acima do fim do “gap”
        // (igual à tua lógica antiga)
        const topCandidate = Math.min(H - 1, gapEnd - 18);

        // ✅ salvaguarda: se por algum motivo isto ficar demasiado baixo,
        // volta para o fallback “clássico”.
        if (topCandidate > H * 0.55) return Math.min(H - 1, 140);

        return topCandidate;
      }
    } else {
      runStart = -1;
      runCount = 0;
    }
  }

  // fallback antigo
  return Math.min(H - 1, 140);
}


  function findRightContentEdge(png, top, bottom) {
    const { width, data } = png;

    let right = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = width - 1; x >= 0; x--) {
        const i = (width * y + x) << 2;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (!isWhite(r, g, b, a)) {
          if (x > right) right = x;
          break;
        }
      }
    }
    return Math.min(width - 1, right + 14);
  }

  function cropPng(png, left, top, cropW, cropH) {
    const out = new PNG({ width: cropW, height: cropH });
    const { width: W, data } = png;

    for (let y = 0; y < cropH; y++) {
      const srcY = top + y;
      for (let x = 0; x < cropW; x++) {
        const srcX = left + x;

        const si = (W * srcY + srcX) << 2;
        const di = (cropW * y + x) << 2;

        out.data[di] = data[si];
        out.data[di + 1] = data[si + 1];
        out.data[di + 2] = data[si + 2];
        out.data[di + 3] = data[si + 3];
      }
    }
    return PNG.sync.write(out);
  }

  // ✅ NOVO: tenta encontrar uma “linha separadora” horizontal perto do fundo
  // para evitar apanhar o bloco de texto quando o desenho vai até ao limite.
  // ✅ NOVO: encontra "riscos" horizontais do bloco de rodapé (linhas separadoras)
  // mais robusto: aceita linhas finas (1px), anti-aliased, e grupos de várias linhas.
  function findBottomSeparatorRuleY(png, top, bottom) {
    const H = png.height;

    const searchBottom = clamp(Math.floor(bottom) - 1, 0, H - 1);

    // procura essencialmente na metade inferior, mas não demasiado cedo
    const searchTop = clamp(
      Math.max(top + 220, Math.floor(H * 0.58)),
      0,
      H - 1
    );

    // thresholds: linha longa no papel tende a dar ratio bem alto.
    // baixamos para apanhar linhas finas / cinzentas.
    const HIT = 0.35;
    const NEAR = 0.22;

    for (let y = searchBottom; y >= searchTop; y--) {
      const r = rowInkRatio(png, y);

      if (r >= HIT) {
        // se for um "grupo" de linhas, sobe até ao topo do grupo
        let yTop = y;
        while (yTop > searchTop && rowInkRatio(png, yTop - 1) >= NEAR) {
          yTop--;
        }
        return yTop;
      }
    }
    return null;
  }


  // -------- pipeline --------
  const png = PNG.sync.read(imgBuf);

  // 1) Topo: cortar “por baixo do logotipo”
  const cropTop = findCropTopBelowLogo(png);
  const top = cropTop;

  // 2) Fundo: como tinhas -> cropHpx é “altura desde o topo da página”
  let cropBottom = Number.isFinite(cropHpx)
    ? clamp(Math.floor(cropHpx) - 15, 120, png.height)
    : FALLBACK_CROP_H;

  // garante que nunca fica acima do “top”
  cropBottom = clamp(cropBottom, top + 200, png.height);

  // ✅ NOVO (só atua em casos “perto do fundo”):
  // Se o crop está demasiado baixo, tenta cortar acima da linha separadora
  // (isto resolve o caso em que a imagem vai até ao limite da página).
  // ✅ NOVO (só atua em casos excecionais de rodapé):
  // Se o "Tecido" está no rodapé, usa os "riscos" como separador real e corta acima deles.
  if (footerLikely) {
    const ruleY = findBottomSeparatorRuleY(png, top, cropBottom);
    if (ruleY !== null) {
      cropBottom = clamp(ruleY - 10, top + 200, png.height);
    }
  } else {
    // comportamento antigo: só tenta salvar se estiver MUITO baixo
    if (cropBottom > png.height * 0.88) {
      const ruleY = findBottomSeparatorRuleY(png, top, cropBottom);
      if (ruleY !== null) {
        cropBottom = clamp(ruleY - 6, top + 200, png.height);
      }
    }
  }


  // 3) Direita: remover o branco do lado direito
  const rightEdge = findRightContentEdge(png, top, cropBottom);

  const left = 0;
  const width = Math.max(200, rightEdge - left + 1);
  const height = Math.max(200, cropBottom - top);

  const croppedBuf = cropPng(png, left, top, width, height);

  await fs.rm(tmpDir, { recursive: true, force: true });

  return `data:image/png;base64,${croppedBuf.toString("base64")}`;
}


/* =========================
   ROUTES
========================= */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/parse-plano", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Sem ficheiro" });
    }

    const pdfBufferText = Buffer.from(req.file.buffer);
    const pdfBufferImage = Buffer.from(req.file.buffer);

    const { text, tecidoY, pageHeightPts } = await extractTextAndTecidoY(pdfBufferText);
    const fields = extractFieldsFromText(text);

    const cropHpx = tecidoYToCropHeightPx(tecidoY, pageHeightPts, RENDER_DPI);
    const footerLikely = Number.isFinite(tecidoY) && Number.isFinite(pageHeightPts)
  ? (tecidoY < pageHeightPts * 0.28)  // "Tecido" muito perto do fundo -> provável rodapé
  : false;

const imageDataUrl = await renderPage1ToImage(pdfBufferImage, cropHpx, footerLikely);


    res.json({
      ok: true,
      fields,
      imageDataUrl,
    });
} catch (err) {
  console.error("parse-plano error:", err);
  res.status(500).json({
    ok: false,
    error: String(err?.message || err),
  });
}

});

/* =========================
   START
========================= */

const PORT = Number(process.env.PORT) || 5176;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend ativo em http://0.0.0.0:${PORT}`);
});
