import { createWorker } from "tesseract.js";

// ---------- Image preprocessing: sharpen contrast & upscale so handwriting reads cleaner ----------
async function preprocessImage(file) {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file);
  const scale = bitmap.width < 1200 ? 1600 / bitmap.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  // grayscale + contrast stretch — flattens ink-bleed/shadows that confuse OCR on handwriting
  const contrast = 1.4;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const adjusted = Math.min(255, Math.max(0, (gray - 128) * contrast + 128));
    d[i] = d[i + 1] = d[i + 2] = adjusted;
  }
  ctx.putImageData(imgData, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: "image/png" })), "image/png");
  });
}

// ---------- OCR.space (free, handwriting-tuned "OCR Engine 2") ----------
// Get a free key in seconds at https://ocr.space/ocrapi (no card required) and paste it in the app.
// Without a key we fall back to the shared demo key, which has a very low shared rate limit.
const OCR_SPACE_DEMO_KEY = "helloworld";

async function runOCRSpace(file, apiKey) {
  const form = new FormData();
  form.append("file", file);
  form.append("apikey", apiKey || OCR_SPACE_DEMO_KEY);
  form.append("OCREngine", "2"); // engine 2 handles messy/handwritten text better than the default
  form.append("scale", "true");
  form.append("detectOrientation", "true");

  const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: form });
  const data = await res.json();
  if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.[0] || "OCR.space failed");
  return (data.ParsedResults || []).map((r) => r.ParsedText).join("\n").trim();
}

// ---------- Tesseract.js (free, runs in-browser, no API key — fallback) ----------
async function runTesseract(file, onProgress) {
  const worker = await createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

// ---------- Combined OCR: preprocess, try handwriting-tuned engine first, fall back, keep the longer result ----------
export async function runOCR(file, onProgress, apiKey) {
  const cleaned = await preprocessImage(file);

  let spaceText = "";
  try {
    onProgress?.(10);
    spaceText = await runOCRSpace(cleaned, apiKey);
    onProgress?.(60);
  } catch {
    spaceText = "";
  }

  let tesseractText = "";
  try {
    tesseractText = await runTesseract(cleaned, (p) => onProgress?.(60 + Math.round(p * 0.4)));
  } catch {
    tesseractText = "";
  }

  onProgress?.(100);
  // Handwriting-tuned engine tends to win on doctor scrawl; pick whichever produced more readable content.
  return spaceText.length >= tesseractText.length ? spaceText || tesseractText : tesseractText || spaceText;
}

// ---------- Medicine line parsing (heuristic, no AI required) ----------
const FREQ_PATTERNS = [
  { re: /\bonce\s*(a\s*day|daily)?\b|\bqd\b|\bod\b/i, label: "Once a day" },
  { re: /\btwice\s*(a\s*day|daily)?\b|\bbid\b|\bb\.i\.d\.?\b/i, label: "Twice a day" },
  { re: /\bthree\s*times?\s*(a\s*day|daily)?\b|\btid\b|\bt\.i\.d\.?\b/i, label: "Three times a day" },
  { re: /\bfour\s*times?\s*(a\s*day|daily)?\b|\bqid\b|\bq\.i\.d\.?\b/i, label: "Four times a day" },
  { re: /\bevery\s*(\d+)\s*hours?\b|q(\d+)h/i, label: "Every few hours" },
  { re: /\bas\s*needed\b|\bprn\b/i, label: "As needed" },
  { re: /\bat\s*bedtime\b|\bhs\b/i, label: "At bedtime" },
];

const DOSAGE_RE = /(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|units?))/i;

export function parsePrescriptionLines(rawText) {
  const lines = rawText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const candidates = lines.filter((l) => DOSAGE_RE.test(l) || FREQ_PATTERNS.some((f) => f.re.test(l)));
  const sourceLines = candidates.length > 0 ? candidates : lines;

  return sourceLines.map((line, idx) => {
    const dosageMatch = line.match(DOSAGE_RE);
    const freqMatch = FREQ_PATTERNS.find((f) => f.re.test(line));
    let name = line;
    if (dosageMatch) name = name.slice(0, dosageMatch.index).trim();
    name = name.replace(/^[\d.\-\)\s]+/, "").replace(/[,:\-]+$/, "").trim();
    if (!name) name = line.trim();
    return {
      id: `med-${idx}-${Date.now()}`,
      rawLine: line,
      name,
      dosage: dosageMatch ? dosageMatch[0] : "",
      frequency: freqMatch ? freqMatch.label : "",
    };
  });
}

// ---------- Drug lookup: RxNorm (NIH, free, no key) + OpenFDA (free, no key) ----------
export async function lookupMedicine(name) {
  const cleanName = name.replace(/[^a-zA-Z\s\-]/g, "").trim();
  if (!cleanName) return null;

  let normalizedName = cleanName;
  try {
    const rxRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(cleanName)}&search=2`
    );
    const rxData = await rxRes.json();
    const rxcui = rxData?.idGroup?.idGroup ?? rxData?.idGroup?.rxnormId?.[0];
  } catch {
    // RxNorm lookup is best-effort; fall through to OpenFDA with the raw name
  }

  try {
    const query = `openfda.generic_name:"${cleanName}"+OR+openfda.brand_name:"${cleanName}"+OR+openfda.substance_name:"${cleanName}"`;
    const fdaRes = await fetch(
      `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(query)}&limit=1`
    );
    if (!fdaRes.ok) return { name: cleanName, found: false };
    const fdaData = await fdaRes.json();
    const result = fdaData?.results?.[0];
    if (!result) return { name: cleanName, found: false };

    const purpose = firstSentence(result.purpose?.[0] || result.indications_and_usage?.[0]);
    const warnings = firstSentence(result.warnings?.[0] || result.warnings_and_cautions?.[0]);
    const brandName = result.openfda?.brand_name?.[0];
    const genericName = result.openfda?.generic_name?.[0];

    return {
      name: cleanName,
      found: true,
      brandName,
      genericName,
      purpose: purpose || "Information not available — please ask your pharmacist.",
      warnings: warnings || "",
    };
  } catch {
    return { name: cleanName, found: false };
  }
}

function firstSentence(text) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^.*?[.!?](?:\s|$)/);
  const sentence = match ? match[0] : clean.slice(0, 220);
  return sentence.trim();
}

// ---------- Translation: MyMemory (free, no key required for low volume) ----------
const translateCache = new Map();

export async function translateText(text, targetLang) {
  if (!text || targetLang === "en") return text;
  const cacheKey = `${targetLang}:${text}`;
  if (translateCache.has(cacheKey)) return translateCache.get(cacheKey);

  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`
    );
    const data = await res.json();
    const translated = data?.responseData?.translatedText || text;
    translateCache.set(cacheKey, translated);
    return translated;
  } catch {
    return text;
  }
}

// ---------- Reminders: browser Notifications + downloadable .ics calendar ----------
export async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function scheduleDailyReminder(medicineName, timeHHMM, onFire) {
  const [h, m] = timeHHMM.split(":").map(Number);
  const checkAndFire = () => {
    const now = new Date();
    if (now.getHours() === h && now.getMinutes() === m) {
      onFire();
    }
  };
  const intervalId = setInterval(checkAndFire, 60 * 1000);
  return () => clearInterval(intervalId);
}

export function buildICS(medicineName, timeHHMM, frequencyLabel) {
  const [h, m] = timeHHMM.split(":").map(Number);
  const now = new Date();
  now.setHours(h, m, 0, 0);
  const dt = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@medihelper`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dt}`,
    `DTSTART:${dt}`,
    `RRULE:FREQ=DAILY`,
    `SUMMARY:Take ${medicineName}`,
    `DESCRIPTION:Reminder to take ${medicineName} (${frequencyLabel || "as prescribed"})`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function downloadICS(filename, icsContent) {
  const blob = new Blob([icsContent], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
