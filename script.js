const BACKEND_URL = "https://okehi-voice-to-text.hf.space/api/transcribe";
const MAX_RETRIES  = 2;         // retry failed requests up to 2 times
const RETRY_DELAY  = 1500;      // ms between retries


const recordBtn      = document.getElementById("recordBtn");
const stopBtn        = document.getElementById("stopBtn");
const fileInput      = document.getElementById("fileInput");
const transcript     = document.getElementById("transcript");
const spinner        = document.getElementById("spinner");
const spinnerText    = document.getElementById("spinnerText");
const languageSelector = document.getElementById("language");
const modelSelect    = document.getElementById("modelSelect");
const darkToggle     = document.getElementById("darkToggle");
const audioPlayer    = document.getElementById("audioPlayer");
const downloadBtn    = document.getElementById("downloadBtn");
const copyBtn        = document.getElementById("copyBtn");
const micMeterWrap   = document.getElementById("micMeterWrap");
const micMeterFill   = document.getElementById("micMeterFill");
const micLabel       = document.getElementById("micLabel");
const detectedLang   = document.getElementById("detectedLang");
const dropZone       = document.getElementById("dropZone");

let mediaRecorder;
let audioChunks  = [];
let audioContext;
let analyser;
let micLevelRaf;


const waveform = WaveSurfer.create({
  container:     "#waveform",
  waveColor:     "#cbd5e1",
  progressColor: "#6366f1",
  height:        80,
  barWidth:      2,
  barRadius:     3,
  responsive:    true,
});


darkToggle.addEventListener("change", () => {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  waveform.setOptions({
    waveColor:     isDark ? "#475569" : "#cbd5e1",
    progressColor: "#818cf8",
  });
});

copyBtn.onclick = async () => {
  const text = transcript.textContent;
  if (!text || text === "Ready for input...") return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = `<i data-lucide="check"></i> Copied!`;
    lucide.createIcons();
    setTimeout(() => { copyBtn.innerHTML = orig; lucide.createIcons(); }, 2000);
  } catch (err) {
    console.error("Clipboard error", err);
  }
};

// ─── Drag & Drop ────────────────────────────────────────────────────────────
["dragenter", "dragover"].forEach(evt =>
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach(evt =>
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  })
);
dropZone.addEventListener("drop", e => {
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("audio/")) processAudioFile(file);
  else alert("Please drop a valid audio file.");
});


function startMicMeter(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser     = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const buf = new Uint8Array(analyser.frequencyBinCount);
  micMeterWrap.classList.remove("hidden");

  function tick() {
    analyser.getByteFrequencyData(buf);
    const avg    = buf.reduce((a, b) => a + b, 0) / buf.length;
    const pct    = Math.min(100, (avg / 128) * 100 * 2.5); // scale for sensitivity
    micMeterFill.style.width = pct + "%";

    if (pct < 5)       micLabel.textContent = "Silent";
    else if (pct < 30) micLabel.textContent = "Low";
    else if (pct < 65) micLabel.textContent = "Good ✓";
    else               micLabel.textContent = "Loud!";

    micLevelRaf = requestAnimationFrame(tick);
  }
  tick();
}

function stopMicMeter() {
  cancelAnimationFrame(micLevelRaf);
  micMeterWrap.classList.add("hidden");
  micMeterFill.style.width = "0%";
  if (audioContext) { audioContext.close(); audioContext = null; }
}

recordBtn.onclick = async () => {
  try {
    // ✅ KEY FIX: Request high-quality audio with noise suppression & echo cancellation
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:       1,          // mono is best for speech
        sampleRate:         16000,      // 16 kHz is Whisper's native rate
        echoCancellation:   true,       // remove echo
        noiseSuppression:   true,       // reduce background noise
        autoGainControl:    true,       // normalize volume automatically
      },
    });

    // ✅ Pick the best available MIME type (WAV/WebM/OGG in priority order)
    const mimeType = getSupportedMimeType();
    mediaRecorder  = new MediaRecorder(stream, { mimeType });
    audioChunks    = [];

    waveform.empty();
    audioPlayer.classList.add("hidden");
    downloadBtn.classList.add("hidden");
    copyBtn.classList.add("hidden");
    detectedLang.classList.add("hidden");

    startMicMeter(stream);

    // ✅ Collect data every 250ms for smoother waveform
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = () => {
      stopMicMeter();
      stream.getTracks().forEach(t => t.stop()); // release mic

      const blob     = new Blob(audioChunks, { type: mimeType });
      const audioURL = URL.createObjectURL(blob);
      waveform.load(audioURL);
      audioPlayer.src = audioURL;
      audioPlayer.classList.remove("hidden");
      sendAudioToBackend(blob);
    };

    mediaRecorder.start(250); // timeslice = 250ms
    recordBtn.disabled  = true;
    stopBtn.disabled    = false;
    recordBtn.innerHTML = `<i data-lucide="mic-off"></i> Recording...`;
    recordBtn.classList.add("recording-pulse");
    lucide.createIcons();

  } catch (err) {
    if (err.name === "NotAllowedError") {
      alert("Microphone permission was denied. Please allow microphone access in your browser settings.");
    } else if (err.name === "NotFoundError") {
      alert("No microphone detected. Please connect a microphone and try again.");
    } else {
      alert("Could not access microphone: " + err.message);
    }
  }
};

stopBtn.onclick = () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recordBtn.disabled  = false;
  stopBtn.disabled    = true;
  recordBtn.innerHTML = `<i data-lucide="mic"></i> Start Recording`;
  recordBtn.classList.remove("recording-pulse");
  lucide.createIcons();
};

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (file) processAudioFile(file);
};

function processAudioFile(file) {
  const audioURL = URL.createObjectURL(file);
  waveform.load(audioURL);
  audioPlayer.src = audioURL;
  audioPlayer.classList.remove("hidden");
  detectedLang.classList.add("hidden");
  sendAudioToBackend(file);
}

function getSupportedMimeType() {
  const types = [
    "audio/wav",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // browser default
}

async function sendAudioToBackend(audioBlob, attempt = 1) {
  const formData = new FormData();

  // ✅ Give the file a proper extension so the backend reads it correctly
  const ext      = getExtensionFromMime(audioBlob.type || "audio/webm");
  formData.append("audio",    audioBlob, `recording.${ext}`);
  formData.append("language", languageSelector.value);
  formData.append("model",    modelSelect ? modelSelect.value : "base");

  transcript.textContent = "";
  transcript.classList.remove("transcript-error");
  spinner.classList.remove("hidden");
  spinnerText.textContent = attempt > 1
    ? `Retrying... (attempt ${attempt})`
    : "Analyzing audio...";

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      body:   formData,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.detail || `Server error ${response.status}`);
    }

    const result = await response.json();
    const text   = result.transcription?.trim();

    if (text) {
      transcript.textContent = text;
      downloadBtn.classList.remove("hidden");
      copyBtn.classList.remove("hidden");
      setupDownload(text);

      if (result.language_detected) {
        detectedLang.textContent = `Detected language: ${result.language_detected}`;
        detectedLang.classList.remove("hidden");
      }
    } else {
      transcript.textContent = "⚠️ No speech detected. Try speaking louder or closer to the microphone.";
      transcript.classList.add("transcript-error");
    }

  } catch (error) {
    console.error(`Attempt ${attempt} failed:`, error);

    if (attempt <= MAX_RETRIES) {
      spinnerText.textContent = `Retrying in ${RETRY_DELAY / 1000}s...`;
      setTimeout(() => sendAudioToBackend(audioBlob, attempt + 1), RETRY_DELAY);
      return; // keep spinner visible
    }

    transcript.textContent = `❌ Error: ${error.message || "Could not reach the transcription server."}`;
    transcript.classList.add("transcript-error");

  } finally {
    if (attempt > MAX_RETRIES || !transcript.classList.contains("hidden")) {
      // Only hide spinner after all retries exhausted or on success
    }
    spinner.classList.add("hidden");
  }
}

function getExtensionFromMime(mimeType) {
  if (mimeType.includes("wav"))  return "wav";
  if (mimeType.includes("ogg"))  return "ogg";
  if (mimeType.includes("mp4"))  return "mp4";
  if (mimeType.includes("webm")) return "webm";
  return "webm";
}

function setupDownload(text) {
  const blob         = new Blob([text], { type: "text/plain" });
  downloadBtn.href   = URL.createObjectURL(blob);
  downloadBtn.download = "transcription.txt";
}