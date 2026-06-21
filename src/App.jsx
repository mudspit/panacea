import { useEffect, useRef, useState } from "react";
import "./App.css";
import { LANGUAGES, t } from "./i18n";
import {
  runOCR,
  parsePrescriptionLines,
  lookupMedicine,
  translateText,
  ensureNotificationPermission,
  scheduleDailyReminder,
  buildICS,
  downloadICS,
} from "./services";

const STEPS = { UPLOAD: 0, REVIEW: 1, MEDICINES: 2, REMINDERS: 3 };

function App() {
  const [lang, setLang] = useState("en");
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [step, setStep] = useState(STEPS.UPLOAD);

  const [ocrProgress, setOcrProgress] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [rawText, setRawText] = useState("");

  const [medicines, setMedicines] = useState([]);
  const [isLookingUp, setIsLookingUp] = useState(false);

  const [reminders, setReminders] = useState([]);
  const [toast, setToast] = useState("");
  const cancelFns = useRef([]);

  const T = (key) => t(lang, key);

  useEffect(() => {
    return () => cancelFns.current.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleFileChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsReading(true);
    setOcrProgress(0);
    try {
      const text = await runOCR(file, setOcrProgress);
      setRawText(text);
      setStep(STEPS.REVIEW);
    } catch (err) {
      setRawText("");
      alert("We could not read that file. Please try another photo.");
    } finally {
      setIsReading(false);
    }
  }

  async function handleConfirmReview() {
    setStep(STEPS.MEDICINES);
    setIsLookingUp(true);
    const parsed = parsePrescriptionLines(rawText);
    const enriched = await Promise.all(
      parsed.map(async (med) => {
        const info = await lookupMedicine(med.name);
        let purpose = info?.purpose || "";
        let warnings = info?.warnings || "";
        if (lang !== "en") {
          purpose = await translateText(purpose, lang);
          warnings = await translateText(warnings, lang);
        }
        return { ...med, info, purpose, warnings };
      })
    );
    setMedicines(enriched);
    setIsLookingUp(false);
  }

  async function handleSaveReminder(med, time) {
    const granted = await ensureNotificationPermission();
    const cancel = granted
      ? scheduleDailyReminder(med.name, time, () => {
          new Notification(T("takeMedicineTitle"), {
            body: `${T("takeMedicineBody")} ${med.name}`,
          });
        })
      : () => {};
    cancelFns.current.push(cancel);

    setReminders((prev) => [
      ...prev,
      { id: `${med.id}-${time}`, medicineName: med.name, time, frequency: med.frequency },
    ]);
    setToast(T("reminderSavedToast"));
    setStep(STEPS.REMINDERS);
  }

  function handleDownloadICS(med, time) {
    const ics = buildICS(med.name, time, med.frequency);
    downloadICS(`${med.name.replace(/\s+/g, "_")}_reminder.ics`, ics);
  }

  function resetAll() {
    setStep(STEPS.UPLOAD);
    setRawText("");
    setMedicines([]);
  }

  return (
    <div className="app">
      {!disclaimerAccepted && (
        <div className="disclaimer-overlay">
          <div className="disclaimer-box">
            <h2>{T("disclaimerTitle")}</h2>
            <p>{T("disclaimerText")}</p>
            <button className="btn-primary" onClick={() => setDisclaimerAccepted(true)}>
              {T("iUnderstand")}
            </button>
          </div>
        </div>
      )}

      <header className="app-header">
        <div>
          <h1>{T("appTitle")}</h1>
          <p>{T("appSubtitle")}</p>
        </div>
        <div>
          <label htmlFor="lang-select" style={{ display: "block", fontSize: 14 }}>
            {T("languageLabel")}
          </label>
          <select id="lang-select" value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {step === STEPS.UPLOAD && (
        <div className="card">
          <h2>{T("step1")}</h2>
          <div className="upload-zone">
            <p>{T("uploadHint")}</p>
            <input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              id="file-input"
              style={{ display: "none" }}
              onChange={handleFileChosen}
            />
            <button className="btn-primary" onClick={() => document.getElementById("file-input").click()}>
              {T("chooseFile")}
            </button>
          </div>
          {isReading && (
            <div>
              <p>{T("reading")}</p>
              <div className="progress-bar-outer">
                <div className="progress-bar-inner" style={{ width: `${ocrProgress}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      {step === STEPS.REVIEW && (
        <div className="card">
          <h2>{T("reviewTitle")}</h2>
          <p>{T("reviewHint")}</p>
          <label style={{ fontSize: 16, color: "#555" }}>{T("editText")}</label>
          <textarea
            className="review-text"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          <div className="step-nav">
            <button className="btn-secondary" onClick={resetAll}>
              {T("startOverBtn")}
            </button>
            <button className="btn-primary" onClick={handleConfirmReview}>
              {T("continueBtn")}
            </button>
          </div>
        </div>
      )}

      {step === STEPS.MEDICINES && (
        <div>
          <h2>{T("medicinesTitle")}</h2>
          {isLookingUp && <p>{T("lookingUp")}</p>}
          {!isLookingUp &&
            medicines.map((med) => (
              <MedicineCard key={med.id} med={med} T={T} onSaveReminder={handleSaveReminder} onDownloadICS={handleDownloadICS} />
            ))}
          <div className="step-nav">
            <button className="btn-secondary" onClick={() => setStep(STEPS.REVIEW)}>
              {T("backBtn")}
            </button>
            <button className="btn-outline" onClick={() => setStep(STEPS.REMINDERS)}>
              {T("remindersTitle")}
            </button>
          </div>
        </div>
      )}

      {step === STEPS.REMINDERS && (
        <div className="card">
          <h2>{T("remindersTitle")}</h2>
          {reminders.length === 0 && <p>{T("noReminders")}</p>}
          {reminders.map((r) => (
            <div className="reminder-list-item" key={r.id}>
              <span>
                <strong>{r.medicineName}</strong> — {r.time} {r.frequency ? `(${r.frequency})` : ""}
              </span>
            </div>
          ))}
          <div className="step-nav">
            <button className="btn-secondary" onClick={() => setStep(STEPS.MEDICINES)}>
              {T("backBtn")}
            </button>
            <button className="btn-primary" onClick={resetAll}>
              {T("startOverBtn")}
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <p className="footer-disclaimer">{T("disclaimerText")}</p>

      <footer className="app-footer">
        <a
          href="https://www.paypal.com/donate/?business=mudspit%40gmail.com&currency_code=USD"
          target="_blank"
          rel="noopener noreferrer"
          className="paypal-donate-btn"
        >
          Donate with PayPal
        </a>
        <p className="footer-credit">Panacea — a web app ideation by Sherwin Martin</p>
      </footer>
    </div>
  );
}

function MedicineCard({ med, T, onSaveReminder, onDownloadICS }) {
  const [time, setTime] = useState("08:00");
  const [showReminder, setShowReminder] = useState(false);

  return (
    <div className="card">
      <p className="medicine-name">{med.name}</p>
      {med.dosage && <span className="tag">{T("dosageLabel")}: {med.dosage}</span>}
      {med.frequency && <span className="tag">{T("frequencyLabel")}: {med.frequency}</span>}

      {med.info?.found ? (
        <div>
          <p><strong>{T("purposeLabel")}:</strong> {med.purpose}</p>
          {med.warnings && (
            <div className="warning-box">
              <strong>{T("warningsLabel")}:</strong> {med.warnings}
            </div>
          )}
        </div>
      ) : (
        <div className="not-found-box">{T("notFound")}</div>
      )}

      <div className="reminder-block">
        {!showReminder ? (
          <button className="btn-outline" onClick={() => setShowReminder(true)}>
            {T("setReminder")}
          </button>
        ) : (
          <div>
            <p>{T("reminderTimesLabel")}</p>
            <div className="time-row">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              <button className="btn-primary" onClick={() => onSaveReminder(med, time)}>
                {T("saveReminder")}
              </button>
              <button className="btn-secondary" onClick={() => onDownloadICS(med, time)}>
                {T("downloadCalendar")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
