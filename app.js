/* Sabaq v4 — caption recitation: word-by-word captions with grammar pills
   + English glosses (Marhaba-style function, Sabaq's own emerald + gold look).
   New flow: animated intro -> guest only -> choose your plan -> today's
   lesson (resumes where you left off) -> caption recitation in 3 modes
   (Beginner / Medium / Harder) with a teacher-audio button (max 3 listens)
   and a 3-font picker (Uthmani / West African / Kufic).
   The ear is the same Groq Worker as v3 (SABAQ_EAR_URL); the live engine
   (2.5 s cumulative slices, LCS scoring, no prompt) is reused unchanged.
   Word data: data/words.json — Quranic Arabic Corpus morphology v0.4
   (POS + grammar features) + word-by-word English glosses. A word with no
   data shows Arabic only; no gloss or tag is ever invented.
   Small static site: index.html + app.js + style.css + data/quran.json +
   data/reciters.json + data/words.json. Runs over HTTP, NOT file://. */

(function () {
  "use strict";

  /* ---------- Groq ear (Whisper) — optional, key never lives here ---------- */
  // Paste the deployed sabaq-ear Worker URL here, e.g.
  // "https://sabaq-ear.<your-subdomain>.workers.dev".
  // Empty ("") = no Groq — the app checks in the browser (Web Speech)
  // instead. The Groq API key lives only as a secret on the Worker.
  var SABAQ_EAR_URL = "https://sabaqear.ltrisk.workers.dev";
  var EAR_GROQ = "groq";
  var EAR_BROWSER = "browser";
  var earInUse = null; // which ear graded the last check (or is listening now)
  var groqBusy = false; // a Groq recording or upload is in flight
  var groqFailedOnce = false; // this tap already fell back to the browser
  var mediaRecorder = null;
  var groqChunks = [];
  var groqTimer = null;
  var GROQ_MAX_MS = 20000; // record at most ~20 s per verse

  /* ---------- v2 constants (unchanged) ---------- */

  var SPLITS = {
    30: [12, 10, 8],
    45: [18, 15, 12],
    60: [24, 20, 16],
    90: [36, 30, 24],
    120: [48, 40, 32]
  };

  var MODE_LABELS = {
    beginner: "Beginner",
    returner: "Returner",
    adult: "Adult",
    parent: "Parent / Family"
  };

  // Verse bank for the live practice check (v2, unchanged).
  var VERSE_BANK = [
    { ref: "Al-Fatiha 1:1", arabic: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ", translit: "Bismillaahir-Rahmaanir-Raheem" },
    { ref: "Al-Fatiha 1:2", arabic: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ", translit: "Alhamdu lillaahi Rabbil-'aalameen" },
    { ref: "Al-Fatiha 1:3", arabic: "الرَّحْمَٰنِ الرَّحِيمِ", translit: "Ar-Rahmaanir-Raheem" },
    { ref: "Al-Fatiha 1:4", arabic: "مَالِكِ يَوْمِ الدِّينِ", translit: "Maaliki yawmid-deen" },
    { ref: "Al-Fatiha 1:5", arabic: "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ", translit: "Iyyaaka na'budu wa iyyaaka nasta'een" },
    { ref: "Al-Fatiha 1:6", arabic: "اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ", translit: "Ihdinas-siraatal-mustaqeem" },
    { ref: "Al-Fatiha 1:7", arabic: "صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ", translit: "Siraatal-ladheena an'amta 'alayhim ghayril-maghdoobi 'alayhim wa lad-daalleen" },
    { ref: "Al-Ikhlas 112:1", arabic: "قُلْ هُوَ اللَّهُ أَحَدٌ", translit: "Qul huwallaahu ahad" },
    { ref: "Al-Ikhlas 112:2", arabic: "اللَّهُ الصَّمَدُ", translit: "Allaahus-samad" },
    { ref: "Al-Ikhlas 112:3", arabic: "لَمْ يَلِدْ وَلَمْ يُولَدْ", translit: "Lam yalid wa lam yoolad" },
    { ref: "Al-Ikhlas 112:4", arabic: "وَلَمْ يَكُن لَّهُ كُفُوًا أَحَدٌ", translit: "Wa lam yakun lahu kufuwan ahad" }
  ];

  /* ---------- v3 data (loaded via fetch) ---------- */

  var quranData = null;      // { meta, surahs: [...] }
  var reciterData = null;    // { defaultReciter, meta, reciters: [...] }
  var wordsData = null;      // { _meta, words: { "s:a": [[form, gloss, pos, [subtags]], ...] } }
  var dataLoaded = false;
  var dataError = false;

  /* ---------- State ---------- */

  var state = {
    mode: null,
    qiraat: null,
    minutes: 45,
    screen: "home",
    task: "sabaq",
    done: { sabaq: false, sabqi: false, manzil: false },
    reciterId: null,
    currentSurah: 1,
    showTranslit: true,
    fontSize: 30,
    chosenSurah: null, // surah the user picked to learn (null = default plan)
    currentJuz: null,   // juz the user tapped on the map
    account: null       // { type: "guest" } or null — local only, no backend
  };

  function saveState() {
    try {
      sessionStorage.setItem("sabaq-v1", JSON.stringify({
        mode: state.mode,
        qiraat: state.qiraat,
        minutes: state.minutes,
        chosenSurah: state.chosenSurah
      }));
    } catch (e) {}
  }

  function loadState() {
    try {
      var raw = sessionStorage.getItem("sabaq-v1");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved.mode && MODE_LABELS[saved.mode]) { state.mode = saved.mode; }
      if (saved.qiraat === "hafs" || saved.qiraat === "warsh") { state.qiraat = saved.qiraat; }
      if (SPLITS[saved.minutes]) { state.minutes = saved.minutes; }
      if (typeof saved.chosenSurah === "number" && saved.chosenSurah >= 1 && saved.chosenSurah <= 114) {
        state.chosenSurah = saved.chosenSurah;
      }
    } catch (e) {}
  }

  /* ---------- Account (local guest only — no backend, no password) ---------- */

  function saveAccount() {
    try {
      if (state.account) { localStorage.setItem("sabaq-v3-account", JSON.stringify(state.account)); }
      else { localStorage.removeItem("sabaq-v3-account"); }
    } catch (e) {}
  }

  function loadAccount() {
    try {
      var raw = localStorage.getItem("sabaq-v3-account");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && saved.type === "guest") { state.account = { type: "guest" }; }
    } catch (e) {}
  }

  function renderAccount() {
    // v4b: no header button anymore — this only drives the guest line
    // on Home ("You're learning as a guest…").
    var line = el("accountLine");
    if (line) { line.hidden = !(state.account && state.account.type === "guest"); }
  }

  /* v4b: no account UI at all — guest only. The sign-in button and the
     account sheet are gone from the page, so there is nothing to open.
     Guest state is set by the intro "Continue as guest" button. */
  function continueAsGuest() {
    state.account = { type: "guest" };
    saveAccount();
    renderAccount();
  }

  function loadPrefs() {
    try {
      var r = localStorage.getItem("sabaq-v3-reciter");
      if (r) { state.reciterId = r; }
      var f = localStorage.getItem("sabaq-v3-font");
      if (f) { var n = parseInt(f, 10); if (n >= 24 && n <= 44) { state.fontSize = n; } }
      var t = localStorage.getItem("sabaq-v3-translit");
      if (t === "off") { state.showTranslit = false; }
    } catch (e) {}
  }

  function savePrefs() {
    try {
      if (state.reciterId) { localStorage.setItem("sabaq-v3-reciter", state.reciterId); }
      localStorage.setItem("sabaq-v3-font", String(state.fontSize));
      localStorage.setItem("sabaq-v3-translit", state.showTranslit ? "on" : "off");
    } catch (e) {}
  }

  /* ---------- Element helpers ---------- */

  function el(id) { return document.getElementById(id); }

  function forEach(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function pad3(n) {
    return ("00" + n).slice(-3);
  }

  /* ---------- Reciter helpers ---------- */

  function getReciter(id) {
    if (!reciterData) { return null; }
    var found = null;
    reciterData.reciters.forEach(function (r) { if (r.id === id) { found = r; } });
    return found;
  }

  function currentReciter() {
    return getReciter(state.reciterId) || getReciter(reciterData && reciterData.defaultReciter) || (reciterData && reciterData.reciters[0]) || null;
  }

  function audioUrl(reciter, surahNum, ayahInSurah) {
    var base = (reciterData && reciterData.meta && reciterData.meta.audioBase) || "https://everyayah.com/data";
    return base + "/" + reciter.folder + "/" + pad3(surahNum) + pad3(ayahInSurah) + ".mp3";
  }

  function setReciter(id) {
    if (!getReciter(id)) { return false; }
    stopAudio();
    state.reciterId = id;
    savePrefs();
    renderReciterList();
    updateReciterButton();
    return true;
  }

  function initials(name) {
    var parts = (name || "").split(/\s+/).filter(function (w) { return w; });
    var out = "";
    if (parts[0]) { out += parts[0].charAt(0); }
    if (parts[1]) { out += parts[1].charAt(0); }
    return out.toUpperCase() || "?";
  }

  /* ---------- Navigation ---------- */

  function showScreen(name) {
    state.screen = name;
    forEach(document.querySelectorAll(".screen"), function (s) {
      s.classList.toggle("is-active", s.getAttribute("data-screen") === name);
    });
    forEach(document.querySelectorAll(".nav-btn"), function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-goto") === name);
    });
    if (name !== "loop") { closePractice(); }
    if (name !== "live") { stopLiveListening(); }
    window.scrollTo(0, 0);
  }

  /* ---------- UI updates (v2) ---------- */

  function updatePill() {
    el("qiraatPill").textContent = state.qiraat
      ? "Reading: " + (state.qiraat === "hafs" ? "Hafs" : "Warsh")
      : "Reading: —";
  }

  function updateSummary() {
    var parts = [];
    parts.push(state.mode ? MODE_LABELS[state.mode] : "Pick a mode");
    parts.push(state.qiraat ? (state.qiraat === "hafs" ? "Hafs" : "Warsh") : "Pick a reading");
    parts.push(state.minutes + " minutes");
    el("planSummary").textContent = parts.join(" · ");
  }

  function updateSplit() {
    var split = SPLITS[state.minutes];
    var total = state.minutes;
    el("barSabaq").style.width = Math.round(split[0] / total * 100) + "%";
    el("barSabqi").style.width = Math.round(split[1] / total * 100) + "%";
    el("barManzil").style.width = Math.round(split[2] / total * 100) + "%";
    el("minSabaq").textContent = split[0] + " min";
    el("minSabqi").textContent = split[1] + " min";
    el("minManzil").textContent = split[2] + " min";
    el("taskMinSabaq").textContent = split[0] + " min";
    el("taskMinSabqi").textContent = split[1] + " min";
    el("taskMinManzil").textContent = split[2] + " min";
  }

  function markSelected(selector, valueAttr, value) {
    forEach(document.querySelectorAll(selector), function (b) {
      b.classList.toggle("is-selected", b.getAttribute(valueAttr) === value);
    });
  }

  /* ---------- Comparison engine (v2, unchanged) ---------- */

  /* Normalizer: strip ALL Quranic diacritics/marks (the old range U+064B–U+0655
     missed U+0656–U+065F and the U+06D6–U+06ED annotation marks that the
     Uthmani text actually uses — e.g. U+06ED in An-Naba 78:21 مِرْصَادًۭا —
     so those words could never match a plain transcript). Dagger alef
     (U+0670) still maps to ا; the alef-length difference it creates
     (الرحمٰن -> الرحمان vs recognizer's الرحمن) is handled by the
     skeleton match in wordsEqual() below. Standalone hamza ء is dropped:
     recognizers routinely omit it (شيء heard as شي). */
  function normalizeArabic(s) {
    return (s || "")
      .replace(/[\u064B-\u065F\u06D6-\u06ED]/g, "")
      .replace(/\u0640/g, "")
      .replace(/\u0670/g, "ا")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/ء/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* Two normalized words count as the same word when they are identical, or
     when they are identical once every alef is removed. Alef length is the
     one thing recognizers spell unreliably (dagger alef in the Uthmani text
     vs plain spelling: الرحمان vs الرحمن, مالك vs ملك when the dagger alef
     is dropped). The guard keeps a word made only of alefs from matching
     everything. This is a word check, not tajweed: alef-length alone is
     not scored as a mistake. */
  function stripAlef(w) { return (w || "").replace(/ا/g, ""); }

  function wordsEqual(a, b) {
    if (a === b) { return true; }
    if (!a || !b) { return false; }
    var sa = stripAlef(a), sb = stripAlef(b);
    return sa.length > 0 && sa === sb;
  }

  /* Recognizers often join two spoken words into one token (الحمد لله heard
     as الحمدلله). Split a heard token back apart when it is exactly the
     concatenation of 2-3 adjacent expected words, so a correct recitation
     is not marked as missing both words. */
  function splitJoinedWords(expected, heard) {
    var out = [];
    heard.forEach(function (h) {
      var found = null;
      for (var i = 0; i < expected.length - 1 && !found; i++) {
        if (expected[i] + expected[i + 1] === h) { found = [expected[i], expected[i + 1]]; }
        else if (i < expected.length - 2 && expected[i] + expected[i + 1] + expected[i + 2] === h) {
          found = [expected[i], expected[i + 1], expected[i + 2]];
        }
      }
      if (found) { out = out.concat(found); } else { out.push(h); }
    });
    return out;
  }

  function splitWords(s) {
    var n = normalizeArabic(s);
    return n ? n.split(" ") : [];
  }

  /* The bundled Uthmani text prepends the Bismillah to ayah 1 of every
     surah (except 1 and 9). A practice check must test the verse itself,
     not the Bismillah — strip those first 4 words when they are the
     Bismillah. The guard keeps Fatiha 1:1 intact (the whole verse IS the
     Bismillah) and leaves any other verse untouched. */
  function stripLeadingBismillah(text) {
    var words = (text || "").split(/\s+/);
    if (words.length > 4) {
      var first4 = words.slice(0, 4).map(normalizeArabic);
      var expected = ["بسم", "الله", "الرحمن", "الرحيم"];
      var isBismillah = first4.every(function (w, i) { return wordsEqual(w, expected[i]); });
      if (isBismillah) { return words.slice(4).join(" "); }
    }
    return text;
  }

  function lcsIndices(a, b, eq) {
    eq = eq || function (x, y) { return x === y; };
    var n = a.length, m = b.length;
    var dp = [], i, j;
    for (i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var matchedA = [], matchedB = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { matchedA.push(i); matchedB.push(j); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
      else { j++; }
    }
    return { a: matchedA, b: matchedB };
  }

  function scoreRecitation(expectedWords, heardWords) {
    var expected = expectedWords.map(normalizeArabic).filter(function (w) { return w; });
    var heard = heardWords.map(normalizeArabic).filter(function (w) { return w; });
    heard = splitJoinedWords(expected, heard);
    if (!expected.length) { return { score: 0, matched: [], missed: [], extras: heard }; }
    var lcs = lcsIndices(expected, heard, wordsEqual);
    var matchedSet = {}, heardSet = {};
    lcs.a.forEach(function (i) { matchedSet[i] = true; });
    lcs.b.forEach(function (j) { heardSet[j] = true; });
    var missed = [], extras = [];
    expected.forEach(function (w, i) { if (!matchedSet[i]) { missed.push(i); } });
    heard.forEach(function (w, j) { if (!heardSet[j]) { extras.push(w); } });
    return {
      score: Math.round(lcs.a.length / expected.length * 100),
      matched: lcs.a,
      missed: missed,
      extras: extras
    };
  }

  /* ---------- Live practice check (v2, unchanged) ---------- */

  var verseIndex = 0;
  // The loop cards promise specific verses (Sabaq: An-Naba 21-26, Sabqi:
  // An-Naba 1-20, Manzil: Al-Mulk 1-12). The check MUST test THOSE verses.
  // Bug: the panel always drew from the old Fatiha/Ikhlas bank, so tapping
  // the Sabaq card showed "Al-Fatiha 1:1" and any An-Naba recitation scored
  // as entirely missing. Each task's list is built from the bundled Quran
  // data; the old bank survives only as a fallback if the data fails to load.
  var TASK_RANGES = {
    sabaq: { surah: 78, from: 21, to: 26 },
    sabqi: { surah: 78, from: 1, to: 20 },
    manzil: { surah: 67, from: 1, to: 12 }
  };
  var taskVerses = { sabaq: null, sabqi: null, manzil: null };
  var taskIndex = { sabaq: 0, sabqi: 0, manzil: 0 };
  var bestScores = { sabaq: {}, sabqi: {}, manzil: {} };
  var activeVerses = VERSE_BANK; // fallback until the Quran data loads
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  var listening = false;
  var listenStart = 0;
  var restarts = 0;
  var finalTranscript = "";
  var lastResult = null;

  var TASK_LABELS = { sabaq: "Sabaq", sabqi: "Sabqi", manzil: "Manzil", diag: "Level check" };

  /* ---------- Choose what to learn (layout fix, Nov 2) ----------
     The default plan is An-Naba / Al-Mulk. When the user picks a surah
     (surah picker, juz map, or the level check), the plan rebuilds around
     THAT surah instead: Sabaq = its first 6 ayahs, Sabqi = the next chunk,
     Manzil = the old review (Al-Mulk, or Al-Fatiha if the chosen surah
     IS Al-Mulk). Nothing is chosen = the default plan, unchanged. */
  function currentTaskRanges() {
    if (state.chosenSurah && quranData) {
      var surah = getSurah(state.chosenSurah);
      if (surah) {
        var n = surah.ayahs.length;
        return {
          sabaq: { surah: surah.number, from: 1, to: Math.min(6, n) },
          sabqi: n > 6
            ? { surah: surah.number, from: 7, to: Math.min(26, n) }
            : { surah: surah.number, from: 1, to: n },
          manzil: surah.number === 67
            ? { surah: 1, from: 1, to: 7 }
            : { surah: 67, from: 1, to: 12 }
        };
      }
    }
    return TASK_RANGES;
  }

  function renderLearningLine() {
    var name = el("learningSurahName");
    if (!name) { return; }
    var surah = state.chosenSurah ? getSurah(state.chosenSurah) : getSurah(78);
    name.textContent = surah ? surah.englishName : "An-Naba";
  }

  function renderTaskCards() {
    if (!quranData) { return; }
    var ranges = currentTaskRanges();
    var kinds = { sabaq: "New lesson", sabqi: "Recent review", manzil: "Old review" };
    ["sabaq", "sabqi", "manzil"].forEach(function (task) {
      var r = ranges[task];
      var surah = getSurah(r.surah);
      if (!surah) { return; }
      var cap = task.charAt(0).toUpperCase() + task.slice(1);
      var title = el("taskTitle" + cap);
      var sub = el("taskSub" + cap);
      if (title) {
        title.textContent = kinds[task] + " · " + surah.englishName + " " + r.from + "–" + r.to;
      }
      if (sub) {
        if (task === "sabaq") { sub.textContent = (r.to - r.from + 1) + " new ayahs to learn"; }
        else if (task === "sabqi") {
          sub.textContent = state.chosenSurah
            ? "Review " + (r.to - r.from + 1) + " ayahs"
            : "Fix 3 words from yesterday";
        } else { sub.textContent = "Keep old verses fresh"; }
      }
    });
    renderLearningLine();
  }

  function setChosenSurah(num) {
    if (!quranData) { return false; }
    var surah = getSurah(num);
    if (!surah) { return false; }
    state.chosenSurah = num;
    saveState();
    // Fresh start for the new lesson — the stored verse index belongs to
    // the old ranges and may not exist in the new ones.
    taskIndex = { sabaq: 0, sabqi: 0, manzil: 0 };
    buildTaskVerses();
    renderTaskCards();
    return true;
  }

  function chooseSurah(num) {
    if (!setChosenSurah(num)) { return false; }
    showScreen("loop");
    return true;
  }

  function currentVerse() { return activeVerses[verseIndex]; }

  function buildTaskVerses() {
    if (!quranData) { return; }
    var ranges = currentTaskRanges();
    Object.keys(ranges).forEach(function (task) {
      var r = ranges[task];
      var surah = getSurah(r.surah);
      if (!surah) { return; }
      var list = [];
      surah.ayahs.forEach(function (a) {
        if (a.numberInSurah >= r.from && a.numberInSurah <= r.to) {
          list.push({
            ref: surah.englishName + " " + r.surah + ":" + a.numberInSurah,
            arabic: stripLeadingBismillah(a.text),
            translit: a.translit || ""
          });
        }
      });
      if (list.length) { taskVerses[task] = list; }
    });
    if (taskVerses[state.task]) { activeVerses = taskVerses[state.task]; }
  }

  function saveProgress() {
    try {
      localStorage.setItem("sabaq-v2", JSON.stringify({ v: 2, per: {
        sabaq: { i: taskIndex.sabaq, best: bestScores.sabaq },
        sabqi: { i: taskIndex.sabqi, best: bestScores.sabqi },
        manzil: { i: taskIndex.manzil, best: bestScores.manzil }
      }}));
    } catch (e) {}
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem("sabaq-v2");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (!saved.per) { return; } // v1 shape (one global verseIndex) — start fresh per task
      Object.keys(taskIndex).forEach(function (task) {
        var p = saved.per[task];
        if (!p) { return; }
        if (typeof p.i === "number") { taskIndex[task] = p.i; }
        if (p.best) { bestScores[task] = p.best; }
      });
    } catch (e) {}
  }

  function updateProgressLine() {
    if (state.task === "diag") {
      el("practiceProgress").textContent = "Verse " + (verseIndex + 1) + " of " + activeVerses.length + " · level check";
      return;
    }
    var best = (bestScores[state.task] || {})[verseIndex];
    el("practiceProgress").textContent = "Verse " + (verseIndex + 1) + " of " + activeVerses.length +
      " · best " + (typeof best === "number" ? best + "%" : "—");
  }

  function renderVerse() {
    var v = currentVerse();
    var words = v.arabic.split(/\s+/);
    var html = "";
    words.forEach(function (w) {
      html += '<span class="word word-neutral">' + w + "</span> ";
    });
    el("practiceVerse").innerHTML = html;
    el("practiceTranslit").textContent = v.translit;
    el("practiceTask").textContent = (TASK_LABELS[state.task] || "Sabaq") + " · " + v.ref;
    el("practiceVerseNum").textContent = (verseIndex + 1) + " of " + activeVerses.length;
    el("practiceQiraat").textContent = state.qiraat === "warsh" ? "Warsh" : "Hafs";
    el("practiceNext").textContent = (state.task === "diag" && verseIndex >= activeVerses.length - 1)
      ? "See my level →" : "Next verse";
    updateProgressLine();
  }

  function renderColored(result) {
    var v = currentVerse();
    var words = v.arabic.split(/\s+/);
    var matchedSet = {};
    result.matched.forEach(function (i) { matchedSet[i] = true; });
    var html = "";
    words.forEach(function (w, i) {
      var cls = matchedSet[i] ? "word-good" : "word-missed";
      html += '<span class="word ' + cls + '">' + w + "</span> ";
    });
    el("practiceVerse").innerHTML = html;
  }

  function setMicUI(isListening) {
    el("micBtn").classList.toggle("is-listening", isListening);
    el("micBtnText").textContent = isListening ? "Tap to stop" : "Tap and recite";
  }

  function showMicError(msg) {
    var s = el("practiceStatus");
    s.textContent = msg;
    s.classList.add("practice-error");
  }

  function clearMicError() {
    el("practiceStatus").classList.remove("practice-error");
  }

  /* ---------- Groq ear (Whisper) ---------- */
  // Records a short clip with MediaRecorder, POSTs it to the sabaq-ear
  // Worker, and scores the returned transcript with the SAME scorer and
  // result display as the browser check. No key lives in the app — the
  // Worker holds it server-side. Any failure falls back to the browser
  // check (once per tap) and says so in plain language.

  function setEarLine(ear) {
    earInUse = ear;
    var line = el("earLine");
    if (!line) { return; }
    if (ear === EAR_GROQ) {
      line.textContent = "Checking with Groq — the AI ear";
    } else if (ear === EAR_BROWSER) {
      line.textContent = "Checking in your browser";
    } else {
      line.textContent = "";
    }
    line.hidden = !ear;
  }

  function groqAvailable() {
    return !!SABAQ_EAR_URL && typeof MediaRecorder !== "undefined";
  }

  function startGroqCheck() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMicError("Live listening needs Chrome or Edge — open this file in one of those.");
      return;
    }
    el("practiceResult").hidden = true;
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    clearMicError();
    setEarLine(EAR_GROQ);
    el("practiceStatus").textContent = "Getting the mic ready…";
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = "";
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].forEach(function (m) {
        if (!mime && window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; }
      });
      groqChunks = [];
      try {
        mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        showMicError("Recording could not start — tap the mic to try again.");
        return;
      }
      mediaRecorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) { groqChunks.push(ev.data); }
      };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        // If the user closed the panel mid-recording, do not send anything.
        if (el("practicePanel").hidden) { groqBusy = false; listening = false; setMicUI(false); return; }
        sendGroqClip();
      };
      mediaRecorder.start(250);
      groqBusy = true;
      listening = true;
      setMicUI(true);
      el("practiceStatus").textContent = "Recording… tap to stop";
      groqTimer = setTimeout(function () { stopGroqRecording(); }, GROQ_MAX_MS);
    }).catch(function () {
      showMicError("Mic is blocked — tap the mic icon in the address bar and allow it, then try again.");
    });
  }

  function stopGroqRecording() {
    if (groqTimer) { clearTimeout(groqTimer); groqTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) {}
    }
  }

  async function sendGroqClip() {
    groqBusy = true;
    listening = false;
    setMicUI(false);
    el("practiceStatus").textContent = "Checking with Groq…";
    var type = (groqChunks[0] && groqChunks[0].type) || "audio/webm";
    var blob = new Blob(groqChunks, { type: type });
    groqChunks = [];
    if (!blob.size) {
      finishGroqHeard("");
      return;
    }
    var form = new FormData();
    form.append("file", blob, "recitation.webm");
    form.append("language", "ar");
    var res;
    try {
      res = await fetch(SABAQ_EAR_URL, { method: "POST", body: form });
    } catch (e) {
      groqFallback("Groq did not answer — checking in your browser instead.");
      return;
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var msg = (data && data.error) || "Groq did not answer.";
      groqFallback(msg + " Checking in your browser instead.");
      return;
    }
    var transcript = data && typeof data.text === "string" ? data.text : "";
    finishGroqHeard(transcript);
  }

  function finishGroqHeard(transcript) {
    groqBusy = false;
    listening = false;
    setMicUI(false);
    setEarLine(EAR_GROQ);
    finalTranscript = transcript;
    finishListening();
  }

  function groqFallback(msg) {
    groqBusy = false;
    listening = false;
    setMicUI(false);
    setEarLine(EAR_BROWSER);
    if (groqFailedOnce) {
      // Already fell back once on this tap — say so plainly and stop.
      showMicError(msg || "The Groq check did not work — tap the mic to try again.");
      return;
    }
    groqFailedOnce = true;
    startListening(); // Web Speech path
    // startListening() sets its own status line; put the reason back on top.
    el("practiceStatus").textContent = msg || "Groq did not answer — checking in your browser instead.";
  }

  function startListening() {
    if (!SR) {
      showMicError("Live listening needs Chrome or Edge — open this file in one of those.");
      return;
    }
    try {
      rec = new SR();
    } catch (e) {
      showMicError("Live listening could not start — try opening this file in Chrome or Edge.");
      return;
    }
    rec.lang = "ar-SA";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    finalTranscript = "";
    lastResult = null;
    restarts = 0;
    el("practiceResult").hidden = true;
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    clearMicError();
    el("practiceStatus").textContent = "Listening… speak now";
    rec.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) {
          finalTranscript += (finalTranscript ? " " : "") + r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim) {
        el("interimText").textContent = interim;
        el("interimLine").hidden = false;
      }
    };
    rec.onerror = function (ev) {
      var code = ev && ev.error ? ev.error : "unknown";
      listening = false;
      setMicUI(false);
      el("interimLine").hidden = true;
      if (code === "aborted") { return; }
      if (code === "not-allowed" || code === "service-not-allowed") {
        showMicError("Mic is blocked — tap the mic icon in the address bar and allow it, then try again.");
      } else if (code === "no-speech") {
        showMicError("I did not hear anything — check your mic and try again.");
      } else if (code === "network") {
        showMicError("Listening needs internet right now — check your connection and try again.");
      } else {
        showMicError("Listening stopped — tap the mic to try again.");
      }
    };
    rec.onend = function () {
      if (!listening) { return; }
      listening = false;
      setMicUI(false);
      el("interimLine").hidden = true;
      if (!finalTranscript.trim() && restarts < 1 && (Date.now() - listenStart) < 3000) {
        restarts++;
        startListening();
        return;
      }
      finishListening();
    };
    listening = true;
    listenStart = Date.now();
    setMicUI(true);
    try {
      rec.start();
    } catch (e) {
      listening = false;
      setMicUI(false);
      showMicError("Listening stopped — tap the mic to try again.");
    }
  }

  function toggleMic() {
    if (listening || groqBusy) {
      // Stop whichever ear is running.
      if (mediaRecorder && mediaRecorder.state !== "inactive") { stopGroqRecording(); return; }
      if (groqBusy) { return; } // upload in flight — let it finish
      listening = false;
      try { if (rec) { rec.stop(); } } catch (e) {}
      finishListening();
      return;
    }
    groqFailedOnce = false;
    if (groqAvailable()) {
      startGroqCheck();
    } else {
      setEarLine(EAR_BROWSER);
      startListening();
    }
  }

  function finishListening() {
    setMicUI(false);
    el("interimLine").hidden = true;
    clearMicError();
    var heard = finalTranscript.trim();
    var v = currentVerse();
    var words = v.arabic.split(/\s+/);
    if (!heard) {
      el("practiceStatus").textContent = "I did not hear anything — try again";
      el("practiceScore").textContent = "—";
      el("scoreRing").style.background = "conic-gradient(var(--gold) 0 0%, var(--line) 0% 100%)";
      el("resultTitle").textContent = "I did not hear anything";
      el("practiceFeedback").innerHTML = '<p class="fix">No words came through. Check your mic, speak clearly, and try again.</p>';
      el("practiceMemoryNote").textContent = "";
      el("heardLine").hidden = true;
      el("practiceNext").hidden = true;
      el("practiceResult").hidden = false;
      el("practiceResult").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    var result = scoreRecitation(words, heard.split(/\s+/));
    lastResult = result;
    renderColored(result);
    el("heardText").textContent = heard;
    el("heardLine").hidden = false;
    var missedWords = result.missed.map(function (i) { return words[i]; });
    el("practiceScore").textContent = result.score + "%";
    el("scoreRing").style.background = "conic-gradient(var(--gold) 0 " + result.score + "%, var(--line) " + result.score + "% 100%)";
    var pass = result.score >= 80;
    if (result.score === 100) {
      el("resultTitle").textContent = "Beautiful — all words heard";
    } else if (pass) {
      el("resultTitle").textContent = "Good work!";
    } else {
      el("resultTitle").textContent = "Almost — try this verse again";
    }
    var fb = "";
    if (result.score === 100) {
      fb = '<p class="fix">Every word heard. Move on to the next verse when you are ready.</p>';
    } else if (pass) {
      fb = '<p class="fix"><strong>Heard ' + (words.length - result.missed.length) + ' of ' + words.length + ' words.</strong> Missed: ' + missedWords.join(" ") + '</p>';
    } else {
      fb = '<p class="fix"><strong>Missed:</strong> ' + missedWords.join(" ") + '</p><p class="fix">Listen to the verse above, then recite it again.</p>';
    }
    if (result.extras.length) {
      fb += '<p class="fix">Extra words heard: ' + result.extras.join(" ") + '</p>';
    }
    el("practiceFeedback").innerHTML = fb;
    el("practiceMemoryNote").textContent = pass ? "Memory: verse complete." : "";
    el("practiceStatus").textContent = "";
    if (state.task === "diag") {
      // Level check: record the FIRST score for this verse and always move
      // on after a scored verse — the recommendation uses first-attempt
      // scores, so a low score is information, not a failure to retry.
      if (typeof diagScores[verseIndex] !== "number") { diagScores[verseIndex] = result.score; }
      el("resultTitle").textContent = pass ? "Nice — well done" : "Noted — let's keep going";
      el("practiceMemoryNote").textContent = "";
      el("practiceNext").hidden = false;
      el("practiceNext").textContent = verseIndex >= activeVerses.length - 1 ? "See my level →" : "Next verse";
    } else {
      el("practiceNext").hidden = !pass;
      el("practiceNext").textContent = "Next verse";
      if (pass) {
        var prev = (bestScores[state.task] || {})[verseIndex];
        if (typeof prev !== "number" || result.score > prev) { bestScores[state.task][verseIndex] = result.score; }
        saveProgress();
        updateProgressLine();
      }
    }
    el("practiceResult").hidden = false;
    el("practiceResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openPractice(task) {
    state.task = task;
    lastResult = null;
    // Point the panel at THIS task's verses (built from the Quran data),
    // resuming where the user left off in this task.
    activeVerses = taskVerses[task] || VERSE_BANK;
    verseIndex = taskIndex[task] || 0;
    if (!activeVerses[verseIndex]) { verseIndex = 0; }
    renderVerse();
    el("diagResult").hidden = true;
    el("practiceResult").hidden = true;
    el("practiceStatus").textContent = "";
    clearMicError();
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    setEarLine(null);
    groqFailedOnce = false;
    if (!SR && !groqAvailable()) {
      el("micBtn").disabled = true;
      showMicError("Live listening needs Chrome or Edge — open this file in one of those.");
    } else {
      el("micBtn").disabled = false;
    }
    setMicUI(false);
    el("practicePanel").hidden = false;
    el("practicePanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closePractice() {
    if (groqTimer) { clearTimeout(groqTimer); groqTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    groqBusy = false;
    if (listening) {
      listening = false;
      try { if (rec) { rec.stop(); } } catch (e) {}
    }
    setMicUI(false);
    el("practicePanel").hidden = true;
    el("practiceResult").hidden = true;
    el("diagResult").hidden = true;
    el("practiceStatus").textContent = "";
    clearMicError();
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    setEarLine(null);
  }

  function nextVerse() {
    if (!lastResult) { return; }
    if (state.task === "diag") {
      // Level check: walk the 3 verses, then show the recommendation.
      if (verseIndex >= activeVerses.length - 1) {
        showDiagResult();
      } else {
        verseIndex++;
        renderVerse();
        el("practiceResult").hidden = true;
        el("heardLine").hidden = true;
        el("interimLine").hidden = true;
        clearMicError();
        el("practiceStatus").textContent = "";
      }
      return;
    }
    if (lastResult.score < 80) { return; }
    markTaskDone(state.task);
    if (verseIndex >= activeVerses.length - 1) {
      verseIndex = 0;
      taskIndex[state.task] = 0;
      saveProgress();
      renderVerse();
      el("practiceResult").hidden = true;
      el("heardLine").hidden = true;
      el("interimLine").hidden = true;
      clearMicError();
      el("practiceStatus").textContent = "You finished all " + activeVerses.length + " verses — starting again from the top.";
    } else {
      verseIndex++;
      taskIndex[state.task] = verseIndex;
      saveProgress();
      renderVerse();
      el("practiceResult").hidden = true;
      el("heardLine").hidden = true;
      el("interimLine").hidden = true;
      clearMicError();
      el("practiceStatus").textContent = "";
    }
  }

  function markTaskDone(task) {
    state.done[task] = true;
    var doneEl = el("taskDone" + task.charAt(0).toUpperCase() + task.slice(1));
    if (doneEl) { doneEl.hidden = false; }
    var card = document.querySelector('[data-task="' + task + '"]');
    if (card) { card.classList.add("is-done"); }
  }

  /* ---------- Level check ("Where are you?", layout fix Nov 2) ----------
     A SHORT entry check, not the full diagnostic engine: 3 verses
     (Fatiha 1:1, Ikhlas 112:1, An-Naba 78:1), scored by the same mic/ear
     check as the daily plan. The recommendation uses first-attempt
     scores: avg >= 80 -> Returner starting An-Naba; 40-79 -> Beginner
     starting Al-Ikhlas; below 40 -> Beginner starting Al-Fatiha. */
  var DIAG_SPECS = [
    { surah: 1, ayah: 1 },
    { surah: 112, ayah: 1 },
    { surah: 78, ayah: 1 }
  ];
  var diagVerses = null;
  var diagScores = [];       // first-attempt score per verse (0-100)
  var diagRecommendation = null;

  function buildDiagVerses() {
    if (!quranData) { return; }
    diagVerses = [];
    DIAG_SPECS.forEach(function (spec) {
      var surah = getSurah(spec.surah);
      if (!surah) { return; }
      var a = null;
      surah.ayahs.forEach(function (x) { if (x.numberInSurah === spec.ayah) { a = x; } });
      if (a) {
        diagVerses.push({
          ref: surah.englishName + " " + spec.surah + ":" + spec.ayah,
          arabic: stripLeadingBismillah(a.text),
          translit: a.translit || ""
        });
      }
    });
  }

  function openDiagnostic() {
    if (!quranData || !diagVerses || !diagVerses.length) { return false; }
    state.task = "diag";
    activeVerses = diagVerses;
    verseIndex = 0;
    diagScores = [];
    diagRecommendation = null;
    el("diagResult").hidden = true;
    renderVerse();
    el("practiceResult").hidden = true;
    el("practiceStatus").textContent = "";
    clearMicError();
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    setEarLine(null);
    groqFailedOnce = false;
    if (!SR && !groqAvailable()) {
      el("micBtn").disabled = true;
      showMicError("Live listening needs Chrome or Edge — open this file in one of those.");
    } else {
      el("micBtn").disabled = false;
    }
    setMicUI(false);
    showScreen("loop");
    el("practicePanel").hidden = false;
    el("practicePanel").scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  function computeDiagRecommendation() {
    var scored = diagScores.filter(function (s) { return typeof s === "number"; });
    var avg = scored.length
      ? Math.round(scored.reduce(function (a, b) { return a + b; }, 0) / scored.length)
      : 0;
    if (avg >= 80) { return { mode: "returner", surah: 78, avg: avg }; }
    if (avg >= 40) { return { mode: "beginner", surah: 112, avg: avg }; }
    return { mode: "beginner", surah: 1, avg: avg };
  }

  function showDiagResult() {
    diagRecommendation = computeDiagRecommendation();
    var surah = getSurah(diagRecommendation.surah);
    var name = surah ? surah.englishName : "";
    el("diagLevel").textContent = "Your level: " + MODE_LABELS[diagRecommendation.mode] +
      " (" + diagRecommendation.avg + "% across 3 verses)";
    el("diagStartSurah").textContent = "Start with: " + name + " — short, steady verses to build from.";
    el("diagStartLearning").textContent = "Start learning " + name + " →";
    el("practicePanel").hidden = true;
    el("practiceResult").hidden = true;
    el("diagResult").hidden = false;
    el("diagResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- 30-juz map (v2; tiles became tappable, layout fix Nov 2) ---------- */

  var juzStarts = {}; // juz -> { surah, ayah } of the juz's first ayah

  function computeJuzStarts() {
    if (!quranData) { return; }
    juzStarts = {};
    quranData.surahs.forEach(function (s) {
      s.ayahs.forEach(function (a) {
        if (!juzStarts[a.juz]) { juzStarts[a.juz] = { surah: s.number, ayah: a.numberInSurah }; }
      });
    });
  }

  // Tapping a juz opens reading at the juz's first ayah AND makes that
  // surah today's lesson — the map is an entry point, not a picture.
  function openJuz(n) {
    if (!quranData || !juzStarts[n]) { return false; }
    var start = juzStarts[n];
    state.currentJuz = n;
    setChosenSurah(start.surah);
    buildJuzGrid();
    openRead(start.surah);
    var row = document.querySelector('.ayah-row[data-ayah="' + start.ayah + '"]');
    if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); }
    return true;
  }

  /* ---------- 30-juz map (v2) ---------- */

  function buildJuzGrid() {
    var grid = el("juzGrid");
    var html = "";
    for (var i = 1; i <= 30; i++) {
      var cls = "juz-tile";
      if (i === 30) { cls += " in-progress"; }
      if (state.currentJuz === i) { cls += " is-selected"; }
      html += '<button class="' + cls + '" type="button" data-juz="' + i + '" title="Juz ' + i + '">' + i + "</button>";
    }
    grid.innerHTML = html;
    forEach(grid.querySelectorAll("[data-juz]"), function (b) {
      b.addEventListener("click", function () {
        openJuz(parseInt(b.getAttribute("data-juz"), 10));
      });
    });
  }

  /* ================= v3: data loading ================= */

  function loadData() {
    return Promise.all([
      fetch("data/quran.json").then(function (r) {
        if (!r.ok) { throw new Error("quran.json HTTP " + r.status); }
        return r.json();
      }),
      fetch("data/reciters.json").then(function (r) {
        if (!r.ok) { throw new Error("reciters.json HTTP " + r.status); }
        return r.json();
      }),
      // Word-by-word captions: non-fatal — without it the caption shows
      // Arabic only (no pills, no glosses), never a fake tag.
      fetch("data/words.json").then(function (r) {
        if (!r.ok) { return null; }
        return r.json();
      }).catch(function () { return null; })
    ]).then(function (results) {
      quranData = results[0];
      reciterData = results[1];
      wordsData = results[2] && results[2].words ? results[2] : null;
      dataLoaded = true;
      if (!state.reciterId) { state.reciterId = reciterData.defaultReciter; }
      renderSurahList("");
      renderReciterList("");
      updateReciterButton();
      computeJuzStarts();
      buildDiagVerses();
      buildTaskVerses();
      renderTaskCards();
      renderLesson(); // pre-fill the v4 lesson screen (tiers + picker)
      // Render the first surah's reading view so it is ready, but STAY on
      // the intro — fresh load must land on the Basmala, not on Fatiha.
      openRead(1, { scroll: false, show: false });
    }).catch(function (err) {
      dataError = true;
      el("loadError").hidden = false;
    });
  }

  function getSurah(num) {
    if (!quranData) { return null; }
    var found = null;
    quranData.surahs.forEach(function (s) { if (s.number === num) { found = s; } });
    return found;
  }

  /* ================= v3: surah picker ================= */

  function renderSurahList(query) {
    var list = el("surahList");
    if (!quranData) { list.innerHTML = ""; return; }
    var q = (query || "").trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
    var html = "";
    var shown = 0;
    quranData.surahs.forEach(function (s) {
      var hay = (s.englishName + " " + s.name + " " + (s.englishNameTranslation || "") + " " + s.number).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
      if (q && hay.indexOf(q) === -1) { return; }
      shown++;
      html += '<button class="surah-row" type="button" data-surah="' + s.number + '">' +
        '<span class="surah-num">' + s.number + '</span>' +
        '<span class="surah-names"><span class="surah-name-en">' + s.englishName + '</span><br />' +
        '<span class="surah-name-sub">' + (s.englishNameTranslation || "") + ' · ' + s.revelationType + '</span></span>' +
        '<span class="surah-name-ar" dir="rtl" lang="ar">' + s.name + '</span>' +
        '<span class="surah-count">' + s.ayahs.length + ' ayahs</span>' +
        "</button>";
    });
    list.innerHTML = html;
    el("surahNoResults").hidden = shown !== 0;
    forEach(list.querySelectorAll("[data-surah]"), function (b) {
      b.addEventListener("click", function () {
        openRead(parseInt(b.getAttribute("data-surah"), 10));
      });
    });
  }

  /* ================= v3: Read mode ================= */

  function openRead(surahNum, opts) {
    var surah = getSurah(surahNum);
    if (!surah) { return false; }
    stopAudio();
    state.currentSurah = surahNum;
    el("readSurahAr").textContent = surah.name;
    el("readSurahEn").textContent = surah.englishName + " — " + (surah.englishNameTranslation || "");
    el("readSurahMeta").textContent = "Surah " + surah.number + " · " + surah.ayahs.length + " ayahs · " +
      surah.revelationType + " · Juz " + surah.ayahs[0].juz;
    // Bismillah line: surah 1 already starts with it as ayah 1; surah 9 has none.
    el("readBismillah").hidden = (surahNum === 1 || surahNum === 9);
    el("translationNote").hidden = true;
    var list = el("ayahList");
    var html = "";
    surah.ayahs.forEach(function (a, i) {
      html += '<button class="ayah-row" type="button" data-ayah-index="' + i + '" data-ayah="' + a.numberInSurah + '">' +
        '<span class="ayah-text" dir="rtl" lang="ar">' + stripLeadingBismillah(a.text) +
        '<span class="ayah-end">' + a.numberInSurah + '</span></span>';
      if (a.translit) {
        html += '<span class="ayah-translit"' + (state.showTranslit ? "" : ' hidden') + '>' + a.translit + '</span>';
      }
      html += '<span class="ayah-audio-error" data-error-for="' + i + '" hidden></span>';
      html += "</button>";
    });
    list.innerHTML = html;
    forEach(list.querySelectorAll("[data-ayah-index]"), function (b) {
      b.addEventListener("click", function () {
        var idx = parseInt(b.getAttribute("data-ayah-index"), 10);
        playAyah(state.currentSurah, idx, { continuous: false });
      });
    });
    applyFontSize();
    updateTranslitButton();
    updateReciterButton();
    updateRangeInputs();
    refreshDownloadState();
    if (!opts || opts.show !== false) { showScreen("read"); }
    if (!opts || opts.scroll !== false) { window.scrollTo(0, 0); }
    return true;
  }

  function applyFontSize() {
    var screen = el("screen-read");
    if (screen) { screen.style.setProperty("--read-font-size", state.fontSize + "px"); }
    var val = el("fontSizeVal");
    if (val) { val.textContent = String(state.fontSize); }
  }

  function updateTranslitButton() {
    var b = el("translitBtn");
    if (b) { b.textContent = state.showTranslit ? "On" : "Off"; }
  }

  function updateReciterButton() {
    var r = currentReciter();
    var b = el("settingsReciterBtn");
    if (b) { b.textContent = r ? r.name : "Choose"; }
    var name = el("playbackReciterName");
    if (name && r) { name.textContent = r.name; }
  }

  function updateRangeInputs() {
    var surah = getSurah(state.currentSurah);
    if (!surah) { return; }
    var max = surah.ayahs.length;
    var s = el("rangeStart"), e = el("rangeEnd");
    s.max = max; e.max = max;
    if (parseInt(s.value, 10) > max) { s.value = 1; }
    if (parseInt(e.value, 10) > max) { e.value = Math.min(5, max); }
  }

  /* ================= v3: audio player ================= */

  var audioEl = null;
  var preloadAudio = null;
  var player = {
    playing: false,       // true while an ayah is sounding
    continuous: false,    // walk down the surah on 'ended'
    surah: null,          // surah number of the playing ayah
    ayahIndex: -1,        // 0-based index into the surah
    speed: 1,
    repeatOne: false,
    repeatRange: null,    // { start: 1-based, end: 1-based } or null
    ayaDelay: 0,          // seconds of pause between ayahs (0 = continuous)
    delayTimer: null,
    fallbackReciterId: null // one-off fallback reciter for the current ayah only
  };

  function clearHighlight() {
    forEach(document.querySelectorAll(".ayah-row.is-playing"), function (r) {
      r.classList.remove("is-playing");
    });
  }

  function highlightAyah(surahNum, ayahIndex) {
    clearHighlight();
    if (surahNum !== state.currentSurah) { return; }
    var row = document.querySelector('.ayah-row[data-ayah-index="' + ayahIndex + '"]');
    if (row) {
      row.classList.add("is-playing");
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function updatePlaybackBar() {
    var bar = el("playbackBar");
    if (!player.playing && player.ayahIndex < 0) { bar.hidden = true; return; }
    bar.hidden = false;
    var r = currentReciter();
    var name = player.fallbackReciterId ? (getReciter(player.fallbackReciterId) || {}).name : (r && r.name);
    el("playbackReciterName").textContent = name || "—";
    el("playbackPlayPause").textContent = player.playing ? "⏸ Pause" : "▶ Play";
    el("playbackSpeed").textContent = (player.speed === 1 ? "1x" : player.speed + "x");
    var rep = el("playbackRepeat");
    rep.classList.toggle("is-on", player.repeatOne || !!player.repeatRange);
    rep.textContent = player.repeatOne ? "↻ 1" : (player.repeatRange ? "↻ ⇄" : "↻");
    var one = el("repeatOneBtn");
    if (one) { one.textContent = player.repeatOne ? "On" : "Off"; }
  }

  function preloadNext(surahNum, ayahIndex) {
    var surah = getSurah(surahNum);
    var reciter = currentReciter();
    if (!surah || !reciter) { return; }
    var next = ayahIndex + 1;
    if (next >= surah.ayahs.length) { return; }
    try {
      if (!preloadAudio) { preloadAudio = new Audio(); }
      preloadAudio.preload = "auto";
      preloadAudio.src = audioUrl(reciter, surahNum, surah.ayahs[next].numberInSurah);
      preloadAudio.load();
    } catch (e) {}
  }

  function showAyahAudioError(ayahIndex, reciter) {
    var box = document.querySelector('[data-error-for="' + ayahIndex + '"]');
    if (!box) { return; }
    var others = (reciterData.reciters || []).filter(function (r) {
      return r.qiraat === "hafs" && r.id !== reciter.id;
    });
    var html = "No audio for this ayah from " + reciter.name + ".";
    if (others.length) {
      html += ' <button class="fallback-btn" type="button" data-fallback="' + others[0].id + '">Hear it from ' + others[0].name + ' instead</button>';
    }
    box.innerHTML = html;
    box.hidden = false;
    var btn = box.querySelector("[data-fallback]");
    if (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        box.hidden = true;
        box.innerHTML = "";
        playAyah(player.surah, ayahIndex, { continuous: false, fallbackReciterId: btn.getAttribute("data-fallback") });
      });
    }
  }

  function playAyah(surahNum, ayahIndex, opts) {
    opts = opts || {};
    var surah = getSurah(surahNum);
    var reciter = opts.fallbackReciterId ? getReciter(opts.fallbackReciterId) : currentReciter();
    if (!surah || !reciter || !surah.ayahs[ayahIndex]) { return false; }
    if (player.delayTimer) { clearTimeout(player.delayTimer); player.delayTimer = null; }
    player.surah = surahNum;
    player.ayahIndex = ayahIndex;
    player.continuous = !!opts.continuous;
    player.fallbackReciterId = opts.fallbackReciterId || null;
    var ayah = surah.ayahs[ayahIndex];
    var url = audioUrl(reciter, surahNum, ayah.numberInSurah);
    // Clear any stale error box on this ayah.
    var box = document.querySelector('[data-error-for="' + ayahIndex + '"]');
    if (box) { box.hidden = true; box.innerHTML = ""; }
    highlightAyah(surahNum, ayahIndex);
    audioEl.playbackRate = player.speed;
    audioEl.src = url;
    player.playing = true;
    updatePlaybackBar();
    var playPromise = audioEl.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        // Autoplay policy or a bad file: the error handler below reports it.
      });
    }
    preloadNext(surahNum, ayahIndex);
    return true;
  }

  function pauseAudio() {
    if (player.delayTimer) { clearTimeout(player.delayTimer); player.delayTimer = null; }
    try { audioEl.pause(); } catch (e) {}
    player.playing = false;
    player.continuous = false;
    updatePlaybackBar();
  }

  function stopAudio() {
    if (player.delayTimer) { clearTimeout(player.delayTimer); player.delayTimer = null; }
    try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch (e) {}
    player.playing = false;
    player.continuous = false;
    player.surah = null;
    player.ayahIndex = -1;
    player.fallbackReciterId = null;
    clearHighlight();
    var bar = el("playbackBar");
    if (bar) { bar.hidden = true; }
    var tp = el("toolbarPlay");
    if (tp) { tp.textContent = "▶ Play"; }
  }

  function onAyahEnded() {
    var surah = getSurah(player.surah);
    if (!surah) { player.playing = false; updatePlaybackBar(); return; }
    // Repeat one ayah.
    if (player.repeatOne) {
      playAyah(player.surah, player.ayahIndex, { continuous: player.continuous, fallbackReciterId: player.fallbackReciterId });
      return;
    }
    // Repeat a range: walk inside it, loop back to its start.
    if (player.repeatRange) {
      var cur = surah.ayahs[player.ayahIndex].numberInSurah;
      var nextNum = cur + 1;
      if (nextNum > player.repeatRange.end) { nextNum = player.repeatRange.start; }
      var nextIdx = nextNum - 1;
      if (player.ayaDelay > 0) {
        player.playing = false; updatePlaybackBar();
        player.delayTimer = setTimeout(function () {
          playAyah(player.surah, nextIdx, { continuous: true, fallbackReciterId: player.fallbackReciterId });
        }, player.ayaDelay * 1000);
      } else {
        playAyah(player.surah, nextIdx, { continuous: true, fallbackReciterId: player.fallbackReciterId });
      }
      return;
    }
    // Continuous play: next ayah in the surah, else stop at the end.
    if (player.continuous) {
      var ni = player.ayahIndex + 1;
      if (ni < surah.ayahs.length) {
        if (player.ayaDelay > 0) {
          player.playing = false; updatePlaybackBar();
          player.delayTimer = setTimeout(function () {
            playAyah(player.surah, ni, { continuous: true, fallbackReciterId: player.fallbackReciterId });
          }, player.ayaDelay * 1000);
        } else {
          playAyah(player.surah, ni, { continuous: true, fallbackReciterId: player.fallbackReciterId });
        }
        return;
      }
    }
    player.playing = false;
    player.continuous = false;
    updatePlaybackBar();
  }

  function onAudioError() {
    // The <audio> element cannot tell a 404 from a network drop, so the
    // message names the reciter and offers a one-tap fallback — never a
    // silent switch to another voice.
    if (player.ayahIndex < 0 || !player.surah) { return; }
    var reciter = player.fallbackReciterId ? getReciter(player.fallbackReciterId) : currentReciter();
    if (!reciter) { return; }
    player.playing = false;
    player.continuous = false;
    updatePlaybackBar();
    showAyahAudioError(player.ayahIndex, reciter);
  }

  function wireAudio() {
    audioEl = el("audioEl");
    audioEl.addEventListener("ended", onAyahEnded);
    audioEl.addEventListener("error", onAudioError);
    audioEl.addEventListener("timeupdate", function () {
      var scrub = el("playbackScrub");
      if (audioEl.duration && isFinite(audioEl.duration)) {
        scrub.value = Math.round(audioEl.currentTime / audioEl.duration * 100);
        el("playbackTimes").textContent = fmtTime(audioEl.currentTime) + " / " + fmtTime(audioEl.duration);
      }
    });
    audioEl.addEventListener("play", function () { player.playing = true; updatePlaybackBar(); });
    audioEl.addEventListener("pause", function () {
      if (!player.delayTimer) { player.playing = false; updatePlaybackBar(); }
    });
    el("playbackScrub").addEventListener("input", function () {
      if (audioEl.duration && isFinite(audioEl.duration)) {
        audioEl.currentTime = (parseInt(el("playbackScrub").value, 10) / 100) * audioEl.duration;
      }
    });
    el("playbackPlayPause").addEventListener("click", function () {
      if (player.playing) {
        pauseAudio();
      } else if (player.ayahIndex >= 0 && player.surah) {
        playAyah(player.surah, player.ayahIndex, { continuous: player.continuous, fallbackReciterId: player.fallbackReciterId });
      } else {
        playAyah(state.currentSurah, 0, { continuous: true });
      }
    });
    el("playbackSpeed").addEventListener("click", function () {
      var speeds = [0.75, 1, 1.25];
      var i = speeds.indexOf(player.speed);
      player.speed = speeds[(i + 1) % speeds.length];
      audioEl.playbackRate = player.speed;
      var sel = el("speedSelect");
      if (sel) { sel.value = String(player.speed); }
      updatePlaybackBar();
    });
    el("playbackRepeat").addEventListener("click", function () {
      if (player.repeatOne) {
        player.repeatOne = false;
        player.repeatRange = { start: 1, end: Math.min(5, (getSurah(state.currentSurah) || { ayahs: [] }).ayahs.length || 5) };
      } else if (player.repeatRange) {
        player.repeatRange = null;
      } else {
        player.repeatOne = true;
      }
      updatePlaybackBar();
    });
    el("playbackClose").addEventListener("click", stopAudio);
  }

  /* ================= v3: reciter picker ================= */

  function renderReciterList(query) {
    var list = el("reciterList");
    if (!reciterData) { list.innerHTML = ""; return; }
    var q = (query || "").trim().toLowerCase();
    var html = "";
    var shown = 0;
    reciterData.reciters.forEach(function (r) {
      var hay = (r.name + " " + r.arabicName + " " + r.style + " " + r.qiraat).toLowerCase();
      if (q && hay.indexOf(q) === -1) { return; }
      shown++;
      var selected = r.id === state.reciterId;
      var bitrateNote = r.bitrate;
      var dlText = "Download Audio (" + (r.fullQuranSize || "full Quran") + ")";
      if (selected) { dlText = "Selected ✓ — " + dlText; }
      html += '<button class="reciter-row' + (selected ? " is-selected" : "") + '" type="button" data-reciter="' + r.id + '">' +
        '<span class="reciter-avatar" aria-hidden="true">' + initials(r.name) + '</span>' +
        '<span class="reciter-info">' +
        '<span class="reciter-name">' + r.name + (r.status === "partial" ? '<span class="badge-partial">Partial</span>' : "") + '</span><br />' +
        '<span class="reciter-ar" dir="rtl" lang="ar">' + r.arabicName + '</span><br />' +
        '<span class="reciter-meta">' + r.style + ' · ' + bitrateNote + (r.knownGaps ? ' · ' + r.knownGaps : "") + '</span>' +
        '<span class="reciter-dl">' + dlText + '</span>' +
        '</span>' +
        '<span class="reciter-state">' + (selected ? '<span class="check">✓</span>' : '<span class="cloud">☁↓</span>') + '</span>' +
        "</button>";
    });
    list.innerHTML = html;
    el("reciterNoResults").hidden = shown !== 0;
    forEach(list.querySelectorAll("[data-reciter]"), function (b) {
      b.addEventListener("click", function () {
        setReciter(b.getAttribute("data-reciter"));
        showScreen("read");
      });
    });
  }

  /* ================= v3: per-surah download (Cache API) ================= */

  var downloadState = {}; // "surahNum:reciterId" -> "downloaded" | "downloading" | "unavailable"

  function cacheName() { return "sabaq-v3-surah"; }

  function downloadKey(surahNum, reciterId) { return surahNum + ":" + reciterId; }

  function refreshDownloadState() {
    var surah = getSurah(state.currentSurah);
    var reciter = currentReciter();
    var badge = el("downloadBadge");
    var status = el("downloadStatus");
    var btn = el("downloadSurahBtn");
    if (!surah || !reciter) { return; }
    if (typeof caches === "undefined") {
      badge.hidden = true;
      status.textContent = "Offline download needs a secure connection (https or localhost) — streaming still works.";
      if (btn) { btn.disabled = true; }
      return;
    }
    if (btn) { btn.disabled = false; }
    var key = downloadKey(surah.number, reciter.id);
    if (downloadState[key] === "downloaded") {
      badge.hidden = false;
      status.textContent = "Saved on this device for " + reciter.name + ".";
      return;
    }
    var firstUrl = audioUrl(reciter, surah.number, surah.ayahs[0].numberInSurah);
    caches.match(firstUrl).then(function (hit) {
      if (hit) {
        downloadState[key] = "downloaded";
        badge.hidden = false;
        status.textContent = "Saved on this device for " + reciter.name + ".";
      } else {
        badge.hidden = true;
        if (downloadState[key] !== "downloading") { status.textContent = ""; }
      }
    }).catch(function () {
      badge.hidden = true;
    });
  }

  function downloadSurah() {
    var surah = getSurah(state.currentSurah);
    var reciter = currentReciter();
    var status = el("downloadStatus");
    if (!surah || !reciter) { return; }
    if (typeof caches === "undefined") {
      status.textContent = "Offline download needs a secure connection (https or localhost) — streaming still works.";
      return;
    }
    var key = downloadKey(surah.number, reciter.id);
    downloadState[key] = "downloading";
    status.textContent = "Downloading… 0 of " + surah.ayahs.length + " ayahs";
    caches.open(cacheName()).then(function (cache) {
      var done = 0;
      var chain = Promise.resolve();
      surah.ayahs.forEach(function (a) {
        chain = chain.then(function () {
          var url = audioUrl(reciter, surah.number, a.numberInSurah);
          return fetch(url).then(function (resp) {
            if (resp.ok) { return cache.put(url, resp); }
            // CORS-blocked but fetchable: store an opaque copy instead.
            return fetch(url, { mode: "no-cors" }).then(function (opaque) {
              return cache.put(url, opaque);
            });
          }).catch(function () {
            return fetch(url, { mode: "no-cors" }).then(function (opaque) {
              return cache.put(url, opaque);
            }).catch(function () { /* one missing ayah must not kill the rest */ });
          }).then(function () {
            done++;
            status.textContent = "Downloading… " + done + " of " + surah.ayahs.length + " ayahs";
          });
        });
      });
      return chain.then(function () {
        downloadState[key] = "downloaded";
        el("downloadBadge").hidden = false;
        status.textContent = "Saved on this device for " + reciter.name + " (" + done + " of " + surah.ayahs.length + " ayahs).";
      });
    }).catch(function () {
      downloadState[key] = null;
      status.textContent = "Download did not finish — check your connection and try again. Streaming still works.";
    });
  }

  /* ================= v4: caption recitation =================
     Word-by-word captions (Marhaba-style function, Sabaq's own look):
     each word shows its grammar pill (noun / verb / particle + sub-tags
     like marfūʿ, majrūr) and its English gloss underneath. Data comes only
     from data/words.json (Quranic Arabic Corpus morphology + word-by-word
     glosses) — a word with no data shows Arabic only, never a fake tag.
     Sub-tags are MAXIMUM detail: every grammar tag the dataset provides
     (form, tense, voice, mood, particle type, case, gender, number,
     definiteness, person) — it is the Quran, not normal Arabic.
     Captions build RIGHT-TO-LEFT: words enter from the right, the line
     grows leftwards, like any Quran.
     Four modes (the karaoke ladder + diagnostic):
       beginner   — full caption on screen, words light gold as recited.
       medium     — words appear one by one out of nothing as you recite
                    them (heard words + flagged words only). A wrong word
                    STOPS the recitation: it turns red, the correction
                    sheet opens, you retry that word before continuing.
       harder     — memorization test: screen blank, a word is revealed
                    only when you say it correctly; a wrong word is
                    revealed red as the correction and stops the take.
       diagnostic — recite a whole surah from start to finish; words
                    appear as recited, wrong words flag red live, and at
                    the end a report shows the mistake % and a breakdown
                    (substituted / skipped / extra). No stopping.
     Teacher audio: the teacher recites line 1 first (button), max 3
     listens per ayah, using the chosen reciter; after the 3rd listen the
     button disappears until the next line.
     Lesson structure (classical, confirmed Nov 4): every day has three
     tiers — Sabaq (today's new lesson), Sabqi (recent revision), Manzil
     (older revision, rotating juz). Lesson length is a level setting:
     Beginner 5 ayahs, Standard 1 page (~8 ayahs), Advanced 2 pages
     (~16 ayahs); default Beginner for a new guest. */

  var CAP_MODES = {
    beginner: "Full caption on screen — words light up gold as you recite them.",
    medium: "Words appear one by one as you recite them — recite from memory, each correct word pops in.",
    harder: "Memorization test — the screen is blank. A word appears only when you say it right.",
    diagnostic: "Recite the whole surah from start to finish — words appear as you say them, wrong words flag red, and you get a report at the end."
  };
  var CAP_FONTS = { uthmani: "Uthmani", alkalami: "West African", kufi: "Kufic" };
  var capMode = "beginner";
  var capFont = "uthmani";
  var teacherListens = 0;
  var liveStoppedAt = -1; // word index the recitation stopped at (medium/harder), -1 = not stopped
  var TEACHER_MAX = 3;
  var planKind = null; // "surah" | "juz" | "ayah" | "review"
  var lastPosition = null; // { plan, surah, from, to, ayah } — resume point

  function loadCapPrefs() {
    try {
      var m = localStorage.getItem("sabaq-v4-capmode");
      if (CAP_MODES[m]) { capMode = m; }
      var f = localStorage.getItem("sabaq-v4-capfont");
      if (CAP_FONTS[f]) { capFont = f; }
      var p = localStorage.getItem("sabaq-v4-plan");
      if (p === "surah" || p === "juz" || p === "ayah" || p === "review") { planKind = p; }
      var raw = localStorage.getItem("sabaq-v4-last");
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved.surah === "number") { lastPosition = saved; }
      }
    } catch (e) {}
  }

  function saveCapPrefs() {
    try {
      localStorage.setItem("sabaq-v4-capmode", capMode);
      localStorage.setItem("sabaq-v4-capfont", capFont);
      if (planKind) { localStorage.setItem("sabaq-v4-plan", planKind); }
    } catch (e) {}
  }

  function saveLastPosition() {
    if (!live) { return; }
    lastPosition = {
      plan: planKind, surah: live.surah, from: live.from, to: live.to,
      ayah: live.ayahs[live.idx] ? live.ayahs[live.idx].numberInSurah : live.from,
      ts: Date.now()
    };
    try { localStorage.setItem("sabaq-v4-last", JSON.stringify(lastPosition)); } catch (e) {}
  }

  /* Word data for one ayah: [[form, gloss|null, pos, [subtags]], ...].
     Falls back to the verse text (Arabic only) when words.json is missing
     or has no entry for the ayah. */
  function getWordData(surahNum, ayahNum) {
    if (wordsData && wordsData.words) {
      var entry = wordsData.words[surahNum + ":" + ayahNum];
      if (entry && entry.length) { return entry; }
    }
    return null;
  }

  function captionWordsForAyah(surahNum, ayahNum, ayahText) {
    var entry = getWordData(surahNum, ayahNum);
    if (entry) {
      var list = entry;
      // The bundled text prepends the Bismillah to ayah 1 of every surah
      // (except 1 and 9), and words.json keeps those 4 words — but the app
      // strips the Bismillah for recitation (Fatiha 1:1 excepted: the whole
      // verse IS the Bismillah). Drop the 4 Bismillah words from the word
      // list so the caption matches what is recited.
      if (ayahNum === 1 && surahNum !== 1 && list.length > 4) {
        var first4 = list.slice(0, 4).map(function (w) { return normalizeArabic(w[0]); });
        var expected = ["بسم", "الله", "الرحمن", "الرحيم"];
        var isBismillah = first4.every(function (w, i) { return wordsEqual(w, expected[i]); });
        if (isBismillah) { list = list.slice(4); }
      }
      return list.map(function (w) {
        return { text: w[0], gloss: w[1] || "", pos: w[2] || "", subs: w[3] || [] };
      });
    }
    var text = stripLeadingBismillah(ayahText || "");
    return text.split(/\s+/).filter(function (w) { return w; }).map(function (w) {
      return { text: w, gloss: "", pos: "", subs: [] };
    });
  }

  /* Mode + font switching (persisted; re-renders the caption). */
  function setCapMode(mode) {
    if (!CAP_MODES[mode]) { return; }
    var wasDiag = capMode === "diagnostic";
    capMode = mode;
    saveCapPrefs();
    forEach(document.querySelectorAll("[data-capmode]"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-capmode") === mode);
    });
    var note = el("capModeNote");
    if (note) { note.textContent = CAP_MODES[mode]; }
    // Diagnostic runs a whole surah from start to finish: switching into
    // it expands the live range to the full surah. Switching out keeps
    // the range as it is.
    if (mode === "diagnostic" && live && !liveDiag) {
      var surah = getSurah(live.surah);
      if (surah) {
        openLive(live.surah, 1, surah.ayahs.length, { tier: "diagnostic", diagnostic: true });
        return;
      }
    }
    if (wasDiag && mode !== "diagnostic" && live && liveDiag) { liveDiag = false; liveDiagStats = null; }
    if (live) { renderLiveAyah(); }
  }

  function setCapFont(font) {
    if (!CAP_FONTS[font]) { return; }
    capFont = font;
    saveCapPrefs();
    var screen = el("screen-live");
    if (screen) { screen.setAttribute("data-capfont", font); }
    forEach(document.querySelectorAll("[data-capfont]"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-capfont") === font);
    });
  }

  /* Teacher audio: plays the current ayah with the chosen reciter, max 3
     listens per ayah. Counts a listen only when playback actually starts. */
  function playTeacher() {
    if (!live) { return false; }
    if (teacherListens >= TEACHER_MAX) { return false; }
    stopAudio();
    var ayah = live.ayahs[live.idx];
    var ok = playAyah(live.surah, ayah.numberInSurah - 1, { continuous: false });
    if (!ok) {
      el("liveStatus").textContent = "Teacher audio is not available right now — pick a reciter in Read mode first.";
      return false;
    }
    teacherListens++;
    updateTeacherBtn();
    el("liveStatus").textContent = "Listen — then tap the mic and recite it yourself.";
    return true;
  }

  function updateTeacherBtn() {
    var b = el("liveTeacherBtn");
    var note = el("liveTeacherNote");
    if (!b) { return; }
    var left = TEACHER_MAX - teacherListens;
    // After the 3rd listen the button DISAPPEARS until the next line.
    b.hidden = left <= 0;
    b.disabled = left <= 0;
    b.innerHTML = "&#9654; Listen to your teacher";
    if (note) {
      note.textContent = left <= 0
        ? "You have heard it 3 times — now it is your turn."
        : "Hear line 1 first, up to 3 times — then you recite. (" + left + " left)";
    }
  }

  /* ---------- Plan + lesson flow (v4) ---------- */

  var PLAN_LABELS = {
    surah: "Learn a specific surah",
    juz: "Learn your juz",
    ayah: "Learn a specific ayah",
    review: "Review my memorization"
  };

  /* Lesson length (level setting, changeable in the plan picker).
     Classical consensus: Sabaq = 1/2 to 1 page per day (3–10 lines).
     Beginner 5 ayahs, Standard 1 page (~8 ayahs), Advanced 2 pages
     (~16 ayahs). Default Beginner for a new guest. */
  var LESSON_LEVELS = {
    beginner: { ayahs: 5, label: "Beginner · 5 ayahs", note: "Beginner: 5 new ayahs a day." },
    standard: { ayahs: 8, label: "Standard · 1 page", note: "Standard: about 1 page a day (~8 ayahs)." },
    advanced: { ayahs: 16, label: "Advanced · 2 pages", note: "Advanced: about 2 pages a day (~16 ayahs)." }
  };
  var lessonLevel = "beginner";

  /* Completed lessons (localStorage, newest first, max 20) — the memory
     the Sabqi / Manzil tiers read from. A lesson is recorded when the user
     taps Done on the last ayah of a live range. */
  var completedLessons = [];

  function loadCompletedLessons() {
    try {
      var raw = localStorage.getItem("sabaq-v4-completed");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        completedLessons = saved.filter(function (l) {
          return l && typeof l.surah === "number" && typeof l.from === "number";
        }).slice(0, 20);
      }
    } catch (e) {}
  }

  function saveCompletedLessons() {
    try { localStorage.setItem("sabaq-v4-completed", JSON.stringify(completedLessons)); } catch (e) {}
  }

  function recordCompletedLesson(surah, from, to) {
    if (!surah || !from) { return; }
    completedLessons = completedLessons.filter(function (l) {
      return !(l.surah === surah && l.from === from && l.to === to);
    });
    completedLessons.unshift({ surah: surah, from: from, to: to, ts: Date.now() });
    if (completedLessons.length > 20) { completedLessons.length = 20; }
    saveCompletedLessons();
  }

  function loadLessonLevel() {
    try {
      var l = localStorage.getItem("sabaq-v4-level");
      if (LESSON_LEVELS[l]) { lessonLevel = l; }
    } catch (e) {}
  }

  function setLessonLevel(level) {
    if (!LESSON_LEVELS[level]) { return; }
    lessonLevel = level;
    try { localStorage.setItem("sabaq-v4-level", level); } catch (e) {}
    forEach(document.querySelectorAll("[data-level]"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-level") === level);
    });
    var note = el("lessonLevelNote");
    if (note) { note.textContent = LESSON_LEVELS[level].note; }
    // The level sets the Sabaq length: keep the start, stretch the end.
    if (planKind !== "ayah" && planKind !== "review") {
      var from = parseInt(el("lessonFrom").value, 10) || 1;
      var surah = getSurah(parseInt(el("lessonSurahSelect").value, 10) || 1);
      if (surah) {
        el("lessonTo").value = Math.min(from + LESSON_LEVELS[level].ayahs - 1, surah.ayahs.length);
      }
    }
    renderLesson();
  }

  function juzFor(surahNum, ayahNum) {
    if (!quranData) { return null; }
    var s = getSurah(surahNum);
    if (!s || !s.ayahs[ayahNum - 1]) { return null; }
    return s.ayahs[ayahNum - 1].juz || null;
  }

  function rangeWordCount(surahNum, from, to) {
    var n = 0;
    for (var a = from; a <= to; a++) {
      var s = getSurah(surahNum);
      var text = s && s.ayahs[a - 1] ? s.ayahs[a - 1].text : "";
      n += captionWordsForAyah(surahNum, a, text).length;
    }
    return n;
  }

  function rangeLabel(r) {
    var s = getSurah(r.surah);
    var name = s ? s.englishName : "";
    return name + " " + r.surah + ":" + r.from + (r.to > r.from ? "–" + r.to : "");
  }

  /* Sabaq: today's new lesson — the picker's start, stretched to the
     level length (or a single ayah for the ayah plan, or the first open
     mistake for the review plan). */
  function sabaqRange() {
    if (!quranData) { return null; }
    var n = LESSON_LEVELS[lessonLevel].ayahs;
    if (planKind === "juz") {
      var jn = parseInt(el("lessonJuzSelect").value, 10) || 30;
      var start = juzStarts[jn];
      if (!start) { return null; }
      var js = getSurah(start.surah);
      var jt = parseInt(el("lessonTo").value, 10) || (start.ayah + n - 1);
      return { surah: start.surah, from: start.ayah,
               to: Math.max(start.ayah, Math.min(jt, js ? js.ayahs.length : jt)) };
    }
    if (planKind === "review") {
      var first = null;
      liveMistakes.forEach(function (m) { if (m.status === "open" && !first) { first = m; } });
      if (first) { return { surah: first.surah, from: first.ayah, to: first.ayah }; }
      var rs = parseInt(el("lessonSurahSelect").value, 10) || 1;
      var rf = parseInt(el("lessonFrom").value, 10) || 1;
      return { surah: rs, from: rf, to: rf };
    }
    var surahNum = parseInt(el("lessonSurahSelect").value, 10) || 1;
    var from = parseInt(el("lessonFrom").value, 10) || 1;
    var surah = getSurah(surahNum);
    if (!surah) { return null; }
    from = Math.max(1, Math.min(from, surah.ayahs.length));
    if (planKind === "ayah") { return { surah: surahNum, from: from, to: from }; }
    // The picker's To is the range end: the level only sets it when the
    // level changes or the picker is seeded (fresh start / resume), so a
    // resumed range keeps its saved end instead of being re-cut.
    var to = parseInt(el("lessonTo").value, 10) || from;
    return { surah: surahNum, from: from,
             to: Math.max(from, Math.min(to, surah.ayahs.length)) };
  }

  /* Sabqi: revision of the last 5–10 pages / recent lessons — the most
     recent completed lesson (other than today's Sabaq), else the level
     length of ayahs immediately before the Sabaq start in the same
     surah. Null when there is nothing recent to revise yet. */
  function sabqiRange() {
    var sb = sabaqRange();
    if (!sb) { return null; }
    var n = LESSON_LEVELS[lessonLevel].ayahs;
    for (var i = 0; i < completedLessons.length; i++) {
      var l = completedLessons[i];
      if (l.surah === sb.surah && l.from === sb.from && l.to === sb.to) { continue; }
      return { surah: l.surah, from: l.from, to: l.to };
    }
    if (sb.from > 1) {
      return { surah: sb.surah, from: Math.max(1, sb.from - n), to: sb.from - 1 };
    }
    return null;
  }

  /* Manzil: rotation of older memorized juz, 1/4 to 1 juz. Rotates daily
     through the juz that have completed lessons (other than the Sabaq
     juz); the daily slice is the level length of ayahs from the start of
     that juz. Null when no older juz exists yet. */
  function manzilRange() {
    var sb = sabaqRange();
    if (!sb) { return null; }
    var n = LESSON_LEVELS[lessonLevel].ayahs;
    var sbJuz = juzFor(sb.surah, sb.from);
    var juzList = [];
    completedLessons.forEach(function (l) {
      var j = juzFor(l.surah, l.from);
      if (j && j !== sbJuz && juzList.indexOf(j) < 0) { juzList.push(j); }
    });
    if (!juzList.length) { return null; }
    var day = Math.floor(Date.now() / 86400000);
    var juz = juzList[day % juzList.length];
    var start = juzStarts[juz];
    if (!start) { return null; }
    var s = getSurah(start.surah);
    return { surah: start.surah, from: start.ayah,
             to: Math.min(start.ayah + n - 1, s ? s.ayahs.length : start.ayah + n - 1),
             juz: juz };
  }

  function openPlan(plan) {
    planKind = plan;
    saveCapPrefs();
    lessonPickerInit = false; // new plan, new picker defaults
    var line = el("lessonPlanLine");
    if (line) { line.textContent = "Your plan: " + PLAN_LABELS[plan]; }
    el("lessonJuzField").hidden = plan !== "juz";
    el("lessonSurahField").hidden = plan === "juz" || plan === "review";
    el("lessonFrom").disabled = plan === "ayah" || plan === "review";
    el("lessonTo").disabled = plan === "ayah" || plan === "review";
    renderLesson();
    showScreen("lesson");
  }

  function lessonDefaults() {
    // Suggested Sabaq start: resume point if it fits this plan, else the
    // plan's fresh start (Al-Fatiha for surah/ayah, Juz 30 for juz) at the
    // current level length.
    var n = LESSON_LEVELS[lessonLevel].ayahs;
    var d = { surah: 1, from: 1, to: Math.min(n, 7) };
    if (lastPosition && (!planKind || lastPosition.plan === planKind || !lastPosition.plan)) {
      var s = getSurah(lastPosition.surah);
      if (s) { d = { surah: lastPosition.surah, from: lastPosition.from, to: lastPosition.to }; }
    } else if (planKind === "juz") {
      var jz = juzStarts[30] || { surah: 78, ayah: 1 };
      var js = getSurah(jz.surah);
      d = { surah: jz.surah, from: jz.ayah,
            to: Math.min(jz.ayah + n - 1, js ? js.ayahs.length : jz.ayah + 4) };
    }
    return d;
  }

  var lessonPickerInit = false; // picker inputs take defaults once per plan

  function renderLesson() {
    if (!quranData) { return; }
    var d = lessonDefaults();
    var surahSel = el("lessonSurahSelect");
    if (!surahSel.options.length) {
      quranData.surahs.forEach(function (s) {
        var o = document.createElement("option");
        o.value = String(s.number);
        o.textContent = s.number + " · " + s.englishName;
        surahSel.appendChild(o);
      });
    }
    var juzSel = el("lessonJuzSelect");
    if (!juzSel.options.length) {
      for (var j = 1; j <= 30; j++) {
        var oj = document.createElement("option");
        oj.value = String(j);
        oj.textContent = "Juz " + j;
        juzSel.appendChild(oj);
      }
    }
    // The picker holds the Sabaq start: defaults once per plan, then the
    // user's own edits (and the level stretch) rule until the plan changes.
    if (!lessonPickerInit) {
      surahSel.value = String(d.surah);
      juzSel.value = planKind === "juz" ? "30" : "1";
      el("lessonFrom").value = d.from;
      el("lessonTo").value = d.to;
      lessonPickerInit = true;
    }
    forEach(document.querySelectorAll("[data-level]"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-level") === lessonLevel);
    });
    var note = el("lessonLevelNote");
    if (note) { note.textContent = LESSON_LEVELS[lessonLevel].note; }

    // The three tiers, every day: Sabaq (new) + Sabqi (recent) + Manzil (old).
    var sb = sabaqRange();
    var sq = sabqiRange();
    var mz = manzilRange();
    if (sb) {
      el("tierSabaqTitle").textContent = rangeLabel(sb);
      el("tierSabaqSub").textContent = (sb.to - sb.from + 1) + " ayah" +
        (sb.to > sb.from ? "s" : "") + " · " + rangeWordCount(sb.surah, sb.from, sb.to) + " words";
      el("tierSabaqStart").disabled = false;
    }
    if (sq) {
      el("tierSabqiTitle").textContent = rangeLabel(sq);
      el("tierSabqiSub").textContent = (sq.to - sq.from + 1) + " ayah" +
        (sq.to > sq.from ? "s" : "") + " · " + rangeWordCount(sq.surah, sq.from, sq.to) + " words";
      el("tierSabqiStart").disabled = false;
    } else {
      el("tierSabqiTitle").textContent = "No recent lesson yet";
      el("tierSabqiSub").textContent = "Finish your first lesson — your revision will show here.";
      el("tierSabqiStart").disabled = true;
    }
    if (mz) {
      el("tierManzilTitle").textContent = "Juz " + mz.juz + " · " + rangeLabel(mz);
      el("tierManzilSub").textContent = (mz.to - mz.from + 1) + " ayah" +
        (mz.to > mz.from ? "s" : "") + " · " + rangeWordCount(mz.surah, mz.from, mz.to) + " words";
      el("tierManzilStart").disabled = false;
    } else {
      el("tierManzilTitle").textContent = "No older revision yet";
      el("tierManzilSub").textContent = "Once you finish lessons in another juz, it will rotate here.";
      el("tierManzilStart").disabled = true;
    }
    var resumeBtn = el("lessonResumeBtn");
    if (resumeBtn) { resumeBtn.hidden = !lastPosition; }
    var rnote = el("lessonNote");
    if (planKind === "review") {
      var open = liveMistakes.filter(function (m) { return m.status === "open"; }).length;
      if (rnote) {
        rnote.hidden = false;
        rnote.textContent = open
          ? open + " word" + (open === 1 ? "" : "s") + " to fix — we will start at the first one."
          : "No open mistakes yet — recite a lesson first, then come back here.";
      }
    } else if (rnote) { rnote.hidden = true; }
  }

  function startLesson(tier) {
    if (!quranData) { return false; }
    tier = tier || "sabaq";
    var r = tier === "sabqi" ? sabqiRange() : tier === "manzil" ? manzilRange() : sabaqRange();
    if (!r) { return false; }
    var ok = openLive(r.surah, r.from, r.to, { tier: tier });
    if (ok) { saveLastPosition(); }
    return ok;
  }

  /* Diagnostic: recite the whole surah that holds today's Sabaq, from
     start to finish, in diagnostic mode. */
  function lessonDiagnostic() {
    if (!quranData) { return false; }
    var sb = sabaqRange();
    if (!sb) { return false; }
    var surah = getSurah(sb.surah);
    if (!surah) { return false; }
    var ok = openLive(sb.surah, 1, surah.ayahs.length, { tier: "diagnostic", diagnostic: true });
    if (ok) {
      setCapMode("diagnostic"); // buttons + note; range already full-surah
      saveLastPosition();
    }
    return ok;
  }

  /* ---------- Intro Basmala animation (v4b) ----------
     The intro IS the Basmala, animated like the one on the SDG site —
     but as its four WORDS, not per letter. Splitting Arabic into
     letter spans breaks the joining and the phrase reads scattered
     (that is what the v4 screenshot showed). Each word starts off its
     place, then glides in. Ink / gold / deep gold. The intro stays as
     the entry screen (with the guest button below) — it does not
     auto-dismiss. Reduced-motion shows the phrase assembled. */
  function animateBasmala() {
    var ar = el("introBasmala");
    if (!ar || ar.getAttribute("data-animated")) { return; }
    ar.setAttribute("data-animated", "1");
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) { return; }
    var words = ar.textContent.trim().split(/\s+/);
    function rnd(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
    var frag = document.createDocumentFragment();
    words.forEach(function (w, i) {
      var span = document.createElement("span");
      span.className = "lt c" + (i % 3);
      span.textContent = w;
      var ang = rnd(i * 3 + 1) * Math.PI * 2;
      var dist = 0.22 + rnd(i * 3 + 2) * 0.4;
      var dx = Math.cos(ang) * dist * window.innerWidth;
      var dy = Math.sin(ang) * dist * window.innerHeight;
      span.style.setProperty("--dx", dx.toFixed(0) + "px");
      span.style.setProperty("--dy", dy.toFixed(0) + "px");
      span.style.setProperty("--rot", ((rnd(i * 3 + 3) - 0.5) * 30).toFixed(1) + "deg");
      span.style.setProperty("--delay", (i * 130) + "ms");
      span.style.setProperty("--dur", (720 + rnd(i * 7 + 5) * 140).toFixed(0) + "ms");
      frag.appendChild(span);
      if (i < words.length - 1) { frag.appendChild(document.createTextNode(" ")); }
    });
    if (!words.length) { return; }
    ar.textContent = "";
    ar.appendChild(frag);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { ar.classList.add("go"); });
    });
  }

  /* ================= v3: live feedback mode =================
     Tarteel's interaction pattern, Sabaq's own UI (emerald + gold):
     recite and each word turns GOLD the moment the ear accepts it; a
     wrong / skipped word turns RED in place; tap a red word to see what
     was said vs the correct word; mistakes are logged to a history.
     Honest limits, stated in the UI: word-level check only — it does
     NOT check tajweed, and the ear can mishear (every ear false-positives
     on Sory's An-Naba 78:1, عم → أما — see sabaq-ear-test/RESULTS.md).
     The ear is the same Groq Worker as the practice check (SABAQ_EAR_URL):
     MediaRecorder slices of 2–3 s, each slice re-sends the whole take so
     far (cumulative blob) and the transcript is aligned to the verse.
     No `prompt` is sent — the Nov 3 prompt-hint test did NOT fix عم.
     Scoring reuses the v2 engine (normalizeArabic / lcsIndices /
     scoreRecitation) — nothing new is invented here. */

  var live = null; // { surah, from, to, ayahs: [{ref, arabic, translit, numberInSurah}], idx, words: [{text, state, heard}] }
  var liveListening = false;
  var liveRecorder = null;
  var liveStream = null;
  var liveChunks = [];
  var liveSending = false;
  var livePendingSlice = false;
  var liveDonePending = false;
  var liveHeardText = ""; // cumulative transcript for the current ayah take
  var liveTakeSeq = 0;    // bumps on every new take — stale slice replies are dropped
  var liveHold = false;   // "Don't move on until it's fixed" toggle (default off)
  var liveMistakes = [];  // {id, surah, ayah, ref, wordIndex, correct, heard, status, ts}
  var liveDiag = false;   // diagnostic run: whole surah, report at the end
  var liveDiagStats = null; // {total, heard, substituted, skipped, extra, tallied:{}}
  var liveSheetWord = -1; // word index open in the correction sheet
  var liveSR = null;      // browser fallback recognizer (Web Speech)
  var liveMaxTimer = null;
  var liveWantFinal = false; // only a mic-toggle stop / Done sends a final slice
  var LIVE_SLICE_MS = 2500;   // MediaRecorder timeslice
  var LIVE_MAX_MS = 120000;   // stop a take after 2 minutes

  /* Word states: pending (not heard yet) -> good (gold) | bad (red, open
     mistake) -> fixed (gold + red wavy underline) | dismissed (neutral,
     never re-flagged in this take — the safety valve for false positives).
     retry: a word the user is re-trying after a flag (via the sheet or a
     whole-ayah retry) — said right, it becomes fixed, not just good. */

  function liveMistakeId(wordIndex) {
    return live.surah + ":" + live.ayahs[live.idx].numberInSurah + ":" + wordIndex;
  }

  function liveCurrentAyah() { return live ? live.ayahs[live.idx] : null; }

  function liveScore() {
    if (!live) { return 0; }
    var n = 0;
    live.words.forEach(function (w) { if (w.state === "good" || w.state === "fixed") { n++; } });
    return n;
  }

  function liveHasOpenMistakes() {
    if (!live) { return false; }
    return live.words.some(function (w) { return w.state === "bad"; });
  }

  function liveCurrentIndex() {
    if (!live) { return -1; }
    for (var i = 0; i < live.words.length; i++) {
      if (live.words[i].state === "pending" || live.words[i].state === "dismissed" ||
          live.words[i].state === "retry") { return i; }
    }
    return -1;
  }

  /* Live alignment: LCS of expected vs heard (same engine as the practice
     check). A missed word is flagged RED only once the user has moved past
     it (a later word is matched) — the last word is never flagged mid-take,
     it is just not heard yet. `final` (on Done) flags every missed word,
     including trailing ones. Extras heard in place of a missed word are
     attributed to it from the gap between the surrounding matched words. */
  function liveAlign(expectedRaw, heardRaw, final) {
    var expected = expectedRaw.map(normalizeArabic).filter(function (w) { return w; });
    var heard = heardRaw.map(normalizeArabic).filter(function (w) { return w; });
    heard = splitJoinedWords(expected, heard);
    var lcs = lcsIndices(expected, heard, wordsEqual);
    var matchedSet = {};
    var heardMatched = {}; // heard index -> expected index
    lcs.a.forEach(function (i, k) { matchedSet[i] = true; heardMatched[lcs.b[k]] = i; });
    var maxMatched = lcs.a.length ? Math.max.apply(null, lcs.a) : -1;
    var flagged = [];
    for (var i = 0; i < expected.length; i++) {
      if (matchedSet[i]) { continue; }
      if (!final && i > maxMatched) { continue; } // not reached yet — wait
      var prevH = -1, nextH = heard.length;
      for (var j = 0; j < heard.length; j++) {
        if (heardMatched[j] !== undefined) {
          if (heardMatched[j] < i) { prevH = j; }
          else if (heardMatched[j] > i && nextH === heard.length) { nextH = j; }
        }
      }
      var said = [];
      for (var h = prevH + 1; h < nextH; h++) { said.push(heard[h]); }
      flagged.push({ index: i, heard: said });
    }
    return { matched: matchedSet, flagged: flagged, maxMatched: maxMatched };
  }

  /* Apply one alignment to the word states. Monotonic: a good word never
     goes back, a bad word can only become fixed, a dismissed word can only
     become good (the user proved it) — never re-flagged in this take.
     Returns the index of the first word newly flagged bad by this
     alignment, or -1 (used for stop-at-wrong-word in karaoke modes). */
  function applyLiveAlignment(align) {
    if (!live) { return -1; }
    var firstNewBad = -1;
    Object.keys(align.matched).forEach(function (k) {
      var i = parseInt(k, 10);
      var w = live.words[i];
      if (!w) { return; }
      if (w.state === "bad" || w.state === "retry") { w.state = "fixed"; markMistakeFixed(liveMistakeId(i)); }
      else if (w.state === "pending" || w.state === "dismissed") { w.state = "good"; }
    });
    align.flagged.forEach(function (f) {
      var w = live.words[f.index];
      if (!w) { return; }
      if (w.state === "pending" || w.state === "retry") {
        w.state = "bad";
        w.heard = f.heard.join(" ");
        logLiveMistake(f.index, w.heard);
        if (firstNewBad < 0) { firstNewBad = f.index; }
      } else if (w.state === "bad") {
        w.heard = f.heard.join(" ");
        updateLiveMistakeHeard(f.index, w.heard);
      }
    });
    renderLiveAyah();
    return firstNewBad;
  }

  /* The one entry point for transcripts: Groq slices (cumulative text),
     browser finals (appended text), and the headless test hook. */
  function applyLiveTranscript(text) {
    liveHeardText = text || "";
    var heardEl = el("liveHeardText");
    if (heardEl) { heardEl.textContent = liveHeardText; }
    el("liveHeardLine").hidden = !liveHeardText.trim();
    if (!live) { return; }
    var words = live.words.map(function (w) { return w.text; });
    var heardWords = liveHeardText.trim() ? liveHeardText.trim().split(/\s+/) : [];
    var firstNewBad = applyLiveAlignment(liveAlign(words, heardWords, false));
    // Karaoke modes stop at the wrong word: the recitation does NOT keep
    // going — the word turns red, the correction is shown with it, and
    // the user retries that word before continuing. Beginner keeps going
    // (all words are on screen); Diagnostic never stops (whole-surah run).
    if (firstNewBad >= 0 && (capMode === "medium" || capMode === "harder") && !liveDiag) {
      liveStoppedAt = firstNewBad;
      stopLiveListening();
      el("liveStatus").textContent = "Stopped at a wrong word — fix it, then keep going.";
      openLiveSheet(firstNewBad);
    }
    var heard = liveScore();
    if (heard === live.words.length && live.words.length) {
      el("liveStatus").textContent = "Beautiful — every word heard. Tap Next when you are ready.";
    }
  }

  /* ---------- Mistake history (on screen + localStorage) ---------- */

  function saveLiveMistakes() {
    try { localStorage.setItem("sabaq-v3-live-mistakes", JSON.stringify(liveMistakes)); } catch (e) {}
  }

  function loadLiveMistakes() {
    try {
      var raw = localStorage.getItem("sabaq-v3-live-mistakes");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        liveMistakes = saved.filter(function (m) {
          return m && typeof m.id === "string" && typeof m.correct === "string";
        }).slice(0, 50);
      }
    } catch (e) {}
  }

  function findLiveMistake(id) {
    var found = null;
    liveMistakes.forEach(function (m) { if (m.id === id) { found = m; } });
    return found;
  }

  function logLiveMistake(wordIndex, heard) {
    if (!live) { return; }
    var id = liveMistakeId(wordIndex);
    var existing = findLiveMistake(id);
    if (existing) {
      // Re-flagged after a retry (or after a dismiss + fresh take): it is
      // an open mistake again — re-open the entry, do not duplicate it.
      existing.status = "open";
      existing.heard = heard;
      saveLiveMistakes();
      renderLiveHistory();
      return;
    }
    var ayah = live.ayahs[live.idx];
    liveMistakes.unshift({
      id: id, surah: live.surah, ayah: ayah.numberInSurah, ref: ayah.ref,
      wordIndex: wordIndex, correct: live.words[wordIndex].text, heard: heard || "",
      status: "open", ts: Date.now()
    });
    if (liveMistakes.length > 50) { liveMistakes.length = 50; }
    saveLiveMistakes();
    renderLiveHistory();
  }

  function updateLiveMistakeHeard(wordIndex, heard) {
    var m = findLiveMistake(liveMistakeId(wordIndex));
    if (m && m.status === "open") { m.heard = heard; saveLiveMistakes(); renderLiveHistory(); }
  }

  function markMistakeFixed(id) {
    var m = findLiveMistake(id);
    if (m && m.status === "open") { m.status = "fixed"; saveLiveMistakes(); renderLiveHistory(); }
  }

  function dismissLiveMistake(id) {
    var m = findLiveMistake(id);
    if (!m) { return; }
    m.status = "dismissed";
    // If the word is on the current ayah, take its red off too.
    if (live && m.surah === live.surah) {
      var idx = -1;
      live.ayahs.forEach(function (a, k) { if (a.numberInSurah === m.ayah) { idx = k; } });
      if (idx === live.idx && live.words[m.wordIndex] && live.words[m.wordIndex].state === "bad") {
        live.words[m.wordIndex].state = "dismissed";
        live.words[m.wordIndex].heard = "";
      }
    }
    saveLiveMistakes();
    renderLiveHistory();
    renderLiveAyah();
  }

  function renderLiveHistory() {
    var box = el("liveHistory");
    var note = el("liveHistoryNote");
    if (!box) { return; }
    if (!liveMistakes.length) { box.innerHTML = ""; if (note) { note.hidden = false; } return; }
    if (note) { note.hidden = true; }
    var html = "";
    liveMistakes.forEach(function (m) {
      var statusText = m.status === "open" ? "Needs work" : (m.status === "fixed" ? "Fixed ✓" : "Dismissed");
      html += '<button class="live-mistake' + (m.status === "fixed" ? " is-fixed" : "") +
        (m.status === "dismissed" ? " is-dismissed" : "") + '" type="button" data-mistake="' + m.id + '">' +
        '<span class="live-mistake-ref">' + m.ref + '</span>' +
        '<span class="live-mistake-words"><strong>' + m.correct + '</strong> — you said <em>' + (m.heard || "—") + '</em></span>' +
        '<span class="live-mistake-status ' + m.status + '">' + statusText + '</span>' +
        '<span class="live-mistake-x" data-dismiss="' + m.id + '" aria-label="Dismiss">✕</span>' +
        "</button>";
    });
    box.innerHTML = html;
    forEach(box.querySelectorAll("[data-mistake]"), function (b) {
      b.addEventListener("click", function (ev) {
        var dis = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-dismiss") : null;
        if (dis) { ev.stopPropagation(); dismissLiveMistake(dis); return; }
        var m = findLiveMistake(b.getAttribute("data-mistake"));
        if (!m) { return; }
        // Jump to that ayah and open its correction sheet.
        if (live && live.surah === m.surah) {
          var idx = -1;
          live.ayahs.forEach(function (a, k) { if (a.numberInSurah === m.ayah) { idx = k; } });
          if (idx >= 0) { liveGoTo(idx); openLiveSheet(m.wordIndex); return; }
        }
        openLive(m.surah, m.ayah, m.ayah);
        openLiveSheet(m.wordIndex);
      });
    });
  }

  /* ---------- Rendering ---------- */

  /* ---------- Caption rendering (v4) ----------
     RTL columns: each word is a column — grammar pills on top (gold POS
     pill + purple sub-pills, only when the dataset has them), the Arabic
     word, the English gloss underneath (only when the dataset has one).
     A word with no data shows Arabic only — never a fake tag.
     Visibility by mode:
       beginner   — every word on screen; pending dimmed, good gold.
       medium     — karaoke: pending words are invisible placeholders
                    (they keep their place in the line), heard and flagged
                    words pop in.
       harder     — memorization test: the screen is blank; only words you
                    said right (or that were flagged and fixed) appear.
       diagnostic — like medium: words appear as recited, wrong words red.
     Correct = gold; wrong/skipped = red in place; fixed = gold with a
     red wavy underline (it was wrong, now it is right); dismissed =
     neutral (the false-positive safety valve). */
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderLiveAyah() {
    if (!live) { return; }
    var ayah = live.ayahs[live.idx];
    var surah = getSurah(live.surah);
    el("liveSurahLine").textContent = surah ? surah.englishName : "";
    el("liveFrom").value = live.from;
    el("liveTo").value = live.to;
    el("liveAyahRef").textContent = ayah.ref + " · Ayah " + (live.idx + 1) + " of " + live.ayahs.length;
    var current = liveCurrentIndex();
    var html = "";
    live.words.forEach(function (w, i) {
      var cls = "cap-word";
      if (w.state === "good") { cls += " is-good"; }
      else if (w.state === "bad") { cls += " is-bad"; }
      else if (w.state === "fixed") { cls += " is-fixed"; }
      else if (w.state === "dismissed") { cls += " is-dismissed"; }
      else if (i === current) { cls += " is-current"; }
      // Mode visibility: medium + diagnostic keep pending words as
      // invisible placeholders (the line keeps its shape); harder shows
      // nothing until a word is said right.
      if (w.state === "pending" || w.state === "retry") {
        if (capMode === "medium" || capMode === "diagnostic") { cls += " is-unheard"; }
        else if (capMode === "harder") { cls += " is-hidden"; }
      }
      var pills = "";
      if (w.pos) { pills += '<span class="cap-pill pos">' + escHtml(w.pos) + "</span>"; }
      (w.subs || []).forEach(function (t) {
        pills += '<span class="cap-pill sub">' + escHtml(t) + "</span>";
      });
      html += '<span class="' + cls + '" data-word="' + i + '" role="button" tabindex="0">' +
        (pills ? '<span class="cap-pills">' + pills + "</span>" : "") +
        '<span class="cap-ar">' + escHtml(w.text) + "</span>" +
        (w.gloss ? '<span class="cap-gloss">' + escHtml(w.gloss) + "</span>" : "") +
        "</span>";
    });
    el("liveVerse").innerHTML = html;
    el("liveTranslit").textContent = ayah.translit || "";
    el("liveScoreLine").textContent = "Heard " + liveScore() + " of " + live.words.length + " words";
    renderCapDetail();
    el("livePrevBtn").disabled = live.idx === 0;
    el("liveNextBtn").disabled = live.idx >= live.ayahs.length - 1;
    el("liveHoldNote").hidden = !(liveHold && liveHasOpenMistakes());
    forEach(el("liveVerse").querySelectorAll("[data-word]"), function (sp) {
      sp.addEventListener("click", function () {
        openLiveSheet(parseInt(sp.getAttribute("data-word"), 10));
      });
    });
  }

  /* ---------- Current-word detail strip (v4b) ----------
     The word you are on, big, with its FULL grammar (POS + every
     sub-pill) and gloss — the video's caption, under the flowing line.
     The line itself shows only the POS pill per word; the strip is
     where the maximum detail lives. Follows liveCurrentIndex(); when
     every word is heard it stays on the last word. */
  function renderCapDetail() {
    var box = el("capDetail");
    if (!box || !live || !live.words.length) { if (box) { box.hidden = true; } return; }
    var idx = liveCurrentIndex();
    if (idx < 0 || idx >= live.words.length) { idx = live.words.length - 1; }
    var w = live.words[idx];
    box.hidden = false;
    var pills = "";
    if (w.pos) { pills += '<span class="cap-pill pos">' + escHtml(w.pos) + "</span>"; }
    (w.subs || []).forEach(function (t) {
      pills += '<span class="cap-pill sub">' + escHtml(t) + "</span>";
    });
    el("capDetailPills").innerHTML = pills;
    var ar = el("capDetailAr");
    ar.textContent = w.text;
    ar.className = "cap-detail-ar" +
      ((w.state === "good" || w.state === "fixed") ? " is-good" : w.state === "bad" ? " is-bad" : "");
    el("capDetailGloss").textContent = w.gloss || "";
    var stateTxt = "Word " + (idx + 1) + " of " + live.words.length;
    if (w.state === "good") { stateTxt += " — heard ✓"; }
    else if (w.state === "fixed") { stateTxt += " — fixed ✓"; }
    else if (w.state === "bad") { stateTxt += " — flagged, tap the word to see why"; }
    else if (w.state === "dismissed") { stateTxt += " — dismissed"; }
    else { stateTxt += " — recite it"; }
    el("capDetailState").textContent = stateTxt;
  }

  function liveResetTake() {
    if (!live) { return; }
    liveTakeSeq++;
    liveChunks = [];
    liveWantFinal = false;
    liveStoppedAt = -1;
    teacherListens = 0; // new line, new 3 listens
    updateTeacherBtn();
    var ayah = live.ayahs[live.idx];
    // Words come from the word-by-word dataset (form + gloss + POS +
    // sub-tags); the fallback is the verse text, Arabic only.
    live.words = captionWordsForAyah(live.surah, ayah.numberInSurah, ayah.arabic)
      .map(function (w) {
        return { text: w.text, gloss: w.gloss, pos: w.pos, subs: w.subs,
                 state: "pending", heard: "" };
      });
    liveHeardText = "";
    renderLiveAyah();
  }

  function liveGoTo(idx) {
    if (!live) { return; }
    stopLiveListening();
    liveDonePending = false;
    live.idx = idx;
    el("liveSummary").hidden = true;
    el("liveSummaryNextBtn").hidden = false;
    el("liveHeardLine").hidden = true;
    el("liveInterimLine").hidden = true;
    el("liveStatus").textContent = "";
    el("liveStatus").classList.remove("practice-error");
    liveResetTake();
  }

  function openLive(surahNum, from, to, opts) {
    if (!quranData) { return false; }
    var surah = getSurah(surahNum);
    if (!surah) { return false; }
    var n = surah.ayahs.length;
    from = Math.max(1, parseInt(from, 10) || 1);
    to = Math.max(from, Math.min(n, parseInt(to, 10) || Math.min(5, n)));
    stopLiveListening();
    liveDonePending = false;
    liveDiag = !!(opts && opts.diagnostic);
    liveDiagStats = liveDiag
      ? { total: 0, heard: 0, substituted: 0, skipped: 0, extra: 0, tallied: {} }
      : null;
    var ayahs = [];
    surah.ayahs.forEach(function (a) {
      if (a.numberInSurah >= from && a.numberInSurah <= to) {
        ayahs.push({
          ref: surah.englishName + " " + surahNum + ":" + a.numberInSurah,
          // Fatiha 1:1 keeps its Bismillah (the whole verse IS the Bismillah);
          // other surahs' ayah 1 drops the prepended Bismillah, as usual.
          arabic: stripLeadingBismillah(a.text),
          translit: a.translit || "",
          numberInSurah: a.numberInSurah
        });
      }
    });
    if (!ayahs.length) { return false; }
    live = { surah: surahNum, from: from, to: to, ayahs: ayahs, idx: 0, words: [],
             tier: (opts && opts.tier) || null };
    liveResetTake();
    el("liveSummary").hidden = true;
    el("liveHeardLine").hidden = true;
    el("liveInterimLine").hidden = true;
    el("liveStatus").textContent = "";
    el("liveStatus").classList.remove("practice-error");
    setLiveEarLine(null);
    renderLiveHistory();
    showScreen("live");
    return true;
  }

  /* ---------- Mic: Groq slices (primary) + Web Speech (fallback) ---------- */

  function setLiveEarLine(ear) {
    var line = el("liveEarLine");
    if (!line) { return; }
    if (ear === EAR_GROQ) { line.textContent = "Checking with Groq — the AI ear"; }
    else if (ear === EAR_BROWSER) { line.textContent = "Checking in your browser"; }
    else { line.textContent = ""; }
    line.hidden = !ear;
  }

  function setLiveMicUI(isListening) {
    el("liveMicBtn").classList.toggle("is-listening", isListening);
    el("liveMicBtnText").textContent = isListening ? "Tap to stop" : "Tap and recite";
  }

  function showLiveError(msg) {
    var s = el("liveStatus");
    s.textContent = msg;
    s.classList.add("practice-error");
  }

  function afterLiveSlice() {
    if (livePendingSlice) { livePendingSlice = false; sendLiveSlice(false); return; }
    if (liveDonePending) { liveDonePending = false; liveDone(); }
  }

  /* Sends the whole take so far (cumulative blob) — MediaRecorder chunks
     are sequential segments of one webm stream, so concatenating them in
     order is a valid file. One send at a time; a slice that lands while
     one is in flight queues a single re-send. */
  function sendLiveSlice(isFinal) {
    var seq = liveTakeSeq;
    if (!liveChunks.length) { afterLiveSlice(); return; }
    if (liveSending) { livePendingSlice = true; return; }
    var type = (liveChunks[0] && liveChunks[0].type) || "audio/webm";
    var blob = new Blob(liveChunks, { type: type });
    if (!blob.size) { afterLiveSlice(); return; }
    liveSending = true;
    el("liveStatus").textContent = "Checking…";
    var form = new FormData();
    form.append("file", blob, "live.webm");
    form.append("language", "ar");
    // No `prompt` — the Nov 3 prompt-hint test did not fix عم (clip 4 stayed 50).
    fetch(SABAQ_EAR_URL, { method: "POST", body: form }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (out) {
      liveSending = false;
      if (live && liveTakeSeq === seq) {
        if (out.ok && out.data && typeof out.data.text === "string") {
          applyLiveTranscript(out.data.text);
        } else {
          el("liveStatus").textContent = "The ear did not answer — your words are still on screen. Tap to stop and try again.";
        }
      }
      afterLiveSlice();
    }).catch(function () {
      liveSending = false;
      if (live && liveTakeSeq === seq) {
        el("liveStatus").textContent = "The ear did not answer — check your connection, then tap to stop and try again.";
      }
      afterLiveSlice();
    });
  }

  function startLiveGroq() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLiveError("Live feedback needs Chrome or Edge — open this in one of those.");
      return;
    }
    el("liveSummary").hidden = true;
    el("liveHeardLine").hidden = true;
    el("liveInterimLine").hidden = true;
    el("liveStatus").classList.remove("practice-error");
    setLiveEarLine(EAR_GROQ);
    el("liveStatus").textContent = "Getting the mic ready…";
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = "";
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].forEach(function (m) {
        if (!mime && window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; }
      });
      liveChunks = [];
      liveStream = stream;
      try {
        liveRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        showLiveError("Recording could not start — tap the mic to try again.");
        return;
      }
      liveRecorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) { liveChunks.push(ev.data); sendLiveSlice(false); }
      };
      liveRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        liveStream = null;
        liveListening = false;
        setLiveMicUI(false);
        // Final slice with everything recorded — only when the stop was a
        // mic-toggle stop or Done, and only if we are still on this take.
        if (liveWantFinal && live && document.getElementById("screen-live").classList.contains("is-active")) {
          liveWantFinal = false;
          sendLiveSlice(true);
          el("liveStatus").textContent = "Checking the last words…";
        }
      };
      liveRecorder.start(LIVE_SLICE_MS);
      liveListening = true;
      setLiveMicUI(true);
      el("liveStatus").textContent = "Listening… recite now";
      liveMaxTimer = setTimeout(function () {
        stopLiveListening();
        el("liveStatus").textContent = "Time's up — tap Done to see your score.";
      }, LIVE_MAX_MS);
    }).catch(function () {
      showLiveError("Mic is blocked — tap the mic icon in the address bar and allow it, then try again.");
    });
  }

  function startLiveBrowser() {
    try {
      liveSR = new SR();
    } catch (e) {
      showLiveError("Live feedback could not start — try opening this in Chrome or Edge.");
      return;
    }
    liveSR.lang = "ar-SA";
    liveSR.interimResults = true;
    liveSR.continuous = true;
    liveSR.maxAlternatives = 1;
    var finalSoFar = liveHeardText;
    liveSR.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) { finalSoFar += (finalSoFar ? " " : "") + r[0].transcript; }
        else { interim += r[0].transcript; }
      }
      if (interim) {
        el("liveInterimText").textContent = interim;
        el("liveInterimLine").hidden = false;
      }
      if (finalSoFar !== liveHeardText) { applyLiveTranscript(finalSoFar); }
    };
    liveSR.onerror = function (ev) {
      var code = ev && ev.error ? ev.error : "unknown";
      liveListening = false;
      setLiveMicUI(false);
      el("liveInterimLine").hidden = true;
      if (code === "aborted") { return; }
      if (code === "not-allowed" || code === "service-not-allowed") {
        showLiveError("Mic is blocked — tap the mic icon in the address bar and allow it, then try again.");
      } else if (code === "no-speech") {
        showLiveError("I did not hear anything — check your mic and try again.");
      } else if (code === "network") {
        showLiveError("Listening needs internet right now — check your connection and try again.");
      } else {
        showLiveError("Listening stopped — tap the mic to try again.");
      }
    };
    liveSR.onend = function () {
      if (!liveListening) { return; }
      liveListening = false;
      setLiveMicUI(false);
      el("liveInterimLine").hidden = true;
      el("liveStatus").textContent = "Listening stopped — tap the mic to try again.";
    };
    liveListening = true;
    setLiveMicUI(true);
    setLiveEarLine(EAR_BROWSER);
    el("liveStatus").textContent = "Listening… recite now";
    try {
      liveSR.start();
    } catch (e) {
      liveListening = false;
      setLiveMicUI(false);
      showLiveError("Listening stopped — tap the mic to try again.");
    }
  }

  function startLiveListening() {
    if (!live || liveListening || liveSending) { return; }
    el("liveSummary").hidden = true;
    el("liveHeardLine").hidden = true;
    el("liveInterimLine").hidden = true;
    el("liveStatus").classList.remove("practice-error");
    if (groqAvailable()) {
      startLiveGroq();
    } else if (SR) {
      startLiveBrowser();
    } else {
      showLiveError("Live feedback needs Chrome or Edge — open this in one of those.");
    }
  }

  function stopLiveListening() {
    if (liveMaxTimer) { clearTimeout(liveMaxTimer); liveMaxTimer = null; }
    if (liveRecorder && liveRecorder.state !== "inactive") {
      try { liveRecorder.stop(); } catch (e) {}
    }
    liveListening = false;
    setLiveMicUI(false);
    if (liveSR) {
      try { liveSR.stop(); } catch (e) {}
      liveSR = null;
    }
  }

  function toggleLiveMic() {
    if (!live) { return; }
    if (liveListening) { liveWantFinal = true; stopLiveListening(); return; }
    if (liveSending) { return; } // let the last check finish
    startLiveListening();
  }

  /* ---------- Diagnostic mode ----------
     A diagnostic run recites a whole surah from start to finish. Leaving
     an ayah finalizes it (every missed word is flagged, like Done) and
     tallies it into the run stats — first attempt only, so a retry does
     not rewrite the report. Breakdown types the scorer can distinguish:
       substituted — a word was flagged and something else was heard
       skipped     — a word was flagged and nothing was heard in its place
       extra       — a word was heard that is not in the text at all
     A dismissed word counts as heard: the user answered the ear's
     question ("no, I said it right") and the override stands — the ear
     is advisory, and it is known to false-positive (An-Naba 78:1 عم). */
  function tallyLiveAyah() {
    if (!live || !liveDiag || !liveDiagStats) { return; }
    if (liveDiagStats.tallied[live.idx]) { return; }
    liveDiagStats.tallied[live.idx] = true;
    var words = live.words.map(function (w) { return w.text; });
    var heardWords = liveHeardText.trim() ? liveHeardText.trim().split(/\s+/) : [];
    // Final pass: flag every missed word, including trailing ones.
    applyLiveAlignment(liveAlign(words, heardWords, true));
    var st = liveDiagStats;
    st.total += live.words.length;
    live.words.forEach(function (w) {
      if (w.state === "good" || w.state === "fixed" || w.state === "dismissed") { st.heard++; }
      else if (w.state === "bad") {
        if (w.heard && w.heard.trim()) { st.substituted++; }
        else { st.skipped++; }
      } else { st.skipped++; } // pending / retry: never heard right
    });
    var r = scoreRecitation(words, heardWords);
    st.extra += r.extras.length;
  }

  function diagReportText() {
    var st = liveDiagStats;
    var missed = st.total - st.heard;
    var mistakes = missed + st.extra;
    var pct = st.total ? Math.round(mistakes / st.total * 100) : 0;
    return {
      title: "Diagnostic report",
      line: "Mistakes: " + pct + "% (" + mistakes + " of " + st.total + " words)" +
        " · Wrong word: " + st.substituted + " · Skipped: " + st.skipped +
        " · Extra: " + st.extra,
      pct: pct, mistakes: mistakes, total: st.total
    };
  }

  /* ---------- Navigation + Done ---------- */

  function liveNext() {
    if (!live) { return; }
    if (liveHold && liveHasOpenMistakes()) {
      el("liveHoldNote").hidden = false;
      return;
    }
    if (liveDiag) { tallyLiveAyah(); }
    stopLiveListening();
    if (live.idx >= live.ayahs.length - 1) {
      liveGoTo(0);
      el("liveStatus").textContent = "You finished this range — starting again from the top.";
    } else {
      liveGoTo(live.idx + 1);
    }
  }

  function livePrev() {
    if (!live) { return; }
    if (live.idx === 0) { return; }
    stopLiveListening();
    liveGoTo(live.idx - 1);
  }

  function liveDone() {
    if (!live) { return; }
    if (liveListening) {
      // Stop the mic; the final slice lands in onstop, then we finalize.
      liveDonePending = true;
      liveWantFinal = true;
      el("liveStatus").textContent = "Checking the last words…";
      stopLiveListening();
      return;
    }
    if (liveSending) {
      liveDonePending = true;
      el("liveStatus").textContent = "Checking the last words…";
      return;
    }
    var words = live.words.map(function (w) { return w.text; });
    var heardWords = liveHeardText.trim() ? liveHeardText.trim().split(/\s+/) : [];
    var isLast = live.idx >= live.ayahs.length - 1;
    if (!liveHeardText.trim() && !(liveDiag && isLast)) {
      el("liveSummaryTitle").textContent = "I did not hear anything";
      el("liveSummaryLine").textContent = "No words came through. Check your mic, speak clearly, and try again.";
      el("liveDiagReport").hidden = true;
      el("liveSummary").hidden = false;
      el("liveSummary").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // Final pass: flag every missed word, including trailing ones.
    applyLiveAlignment(liveAlign(words, heardWords, true));
    var result = scoreRecitation(words, heardWords);
    var open = live.words.filter(function (w) { return w.state === "bad"; }).length;
    var heard = liveScore();
    if (liveDiag && isLast) {
      // End of the diagnostic run: the report, not the per-ayah summary.
      tallyLiveAyah();
      var rep = diagReportText();
      var surah = getSurah(live.surah);
      el("liveSummaryTitle").textContent = rep.title + " — " + (surah ? surah.englishName : "");
      el("liveSummaryLine").textContent = rep.line;
      el("liveDiagReportTitle").textContent = "Mistakes: " + rep.pct + "%";
      el("liveDiagReportLine").textContent = rep.mistakes + " of " + rep.total + " words · " +
        "Wrong word: " + liveDiagStats.substituted + " · Skipped: " + liveDiagStats.skipped +
        " · Extra: " + liveDiagStats.extra;
      el("liveDiagReport").hidden = false;
      el("liveSummaryNextBtn").hidden = true;
    } else {
      var title = result.score === 100 ? "Beautiful — every word heard"
        : (result.score >= 80 ? "Good work!" : "Almost — a few words to fix");
      el("liveSummaryTitle").textContent = title;
      el("liveSummaryLine").textContent = "Score " + result.score + "% · Heard " + heard + " of " + words.length + " words" +
        (open ? " · " + open + " word" + (open === 1 ? "" : "s") + " to fix" : " · nothing to fix") +
        (result.extras.length ? " · Extra heard: " + result.extras.join(" ") : "");
      el("liveDiagReport").hidden = true;
      el("liveSummaryNextBtn").hidden = false;
    }
    el("liveSummary").hidden = false;
    el("liveSummary").scrollIntoView({ behavior: "smooth", block: "start" });
    // Finishing the last ayah of a lesson completes the lesson — the
    // Sabqi / Manzil tiers read this. A diagnostic is a test, not a
    // lesson, so it is never recorded.
    if (isLast && !liveDiag) { recordCompletedLesson(live.surah, live.from, live.to); }
  }

  function liveTryAgain() {
    if (!live) { return; }
    // A word that was wrong gets a real second chance: said right in the
    // new take it shows as fixed, not just good.
    live.words.forEach(function (w) {
      w.state = (w.state === "bad") ? "retry" : "pending";
      w.heard = "";
    });
    liveHeardText = "";
    el("liveSummary").hidden = true;
    el("liveHeardLine").hidden = true;
    el("liveStatus").textContent = "";
    renderLiveAyah();
  }

  /* ---------- Correction sheet ---------- */

  function openLiveSheet(i) {
    if (!live) { return; }
    var w = live.words[i];
    if (!w || (w.state !== "bad" && w.state !== "fixed")) { return; }
    liveSheetWord = i;
    el("liveSheetTitle").textContent = w.state === "fixed" ? "Fixed ✓ — " + w.text : w.text;
    el("liveSheetHeard").textContent = "You said: " + (w.heard ? w.heard : "— (nothing heard)");
    el("liveSheetCorrect").textContent = "Correct: " + w.text;
    // Word info from the dataset: what it means + how it works. A word
    // with no data shows the honest fallback instead of a fake tag.
    var info = el("liveSheetWordInfo");
    if (info) {
      var parts = [];
      if (w.gloss) { parts.push("“" + w.gloss + "”"); }
      var gram = [];
      if (w.pos) { gram.push(w.pos); }
      (w.subs || []).forEach(function (t) { gram.push(t); });
      if (gram.length) { parts.push(gram.join(" · ")); }
      if (parts.length) {
        info.textContent = parts.join(" — ");
        info.hidden = false;
      } else {
        info.textContent = "No word data for this word yet — Arabic only.";
        info.hidden = false;
      }
    }
    el("liveSheetDismiss").style.display = w.state === "fixed" ? "none" : "";
    el("liveSheet").hidden = false;
  }

  function closeLiveSheet() {
    liveSheetWord = -1;
    el("liveSheet").hidden = true;
  }

  function liveSheetRetry() {
    if (!live || liveSheetWord < 0) { closeLiveSheet(); return; }
    var w = live.words[liveSheetWord];
    if (w) { w.state = "retry"; w.heard = ""; }
    if (liveStoppedAt === liveSheetWord) { liveStoppedAt = -1; }
    closeLiveSheet();
    renderLiveAyah();
    // Start listening so the user can re-recite right away.
    if (!liveListening) { startLiveListening(); }
  }

  function liveSheetDismiss() {
    if (!live || liveSheetWord < 0) { closeLiveSheet(); return; }
    var w = live.words[liveSheetWord];
    var stoppedHere = liveStoppedAt === liveSheetWord;
    if (w && w.state === "bad") {
      w.state = "dismissed";
      w.heard = "";
      dismissLiveMistake(liveMistakeId(liveSheetWord));
    }
    closeLiveSheet();
    renderLiveAyah();
    // If the recitation stopped at this word, dismissing it means "the
    // ear was wrong, keep going" — restart listening so the user can
    // carry on from where they stopped.
    if (stoppedHere) {
      liveStoppedAt = -1;
      if (!liveListening) { startLiveListening(); }
    }
  }

  function setLiveHold(on) {
    liveHold = !!on;
    try { localStorage.setItem("sabaq-v3-live-hold", liveHold ? "on" : "off"); } catch (e) {}
    var b = el("liveHoldToggle");
    if (!b) { return; }
    b.textContent = liveHold ? "On" : "Off";
    b.classList.toggle("is-on", liveHold);
    b.setAttribute("aria-pressed", liveHold ? "true" : "false");
    if (live) { renderLiveAyah(); }
  }

  /* ---------- Wire up (v2 + v3) ---------- */

  function init() {
    loadState();
    loadPrefs();
    loadAccount();
    loadProgress();
    buildJuzGrid();
    renderVerse();
    renderAccount();
    wireAudio();

    forEach(document.querySelectorAll("[data-mode]"), function (b) {
      b.addEventListener("click", function () {
        state.mode = b.getAttribute("data-mode");
        markSelected("[data-mode]", "data-mode", state.mode);
        saveState();
        updateSummary();
        showScreen("qiraat");
      });
    });

    forEach(document.querySelectorAll("[data-qiraat]"), function (b) {
      b.addEventListener("click", function () {
        state.qiraat = b.getAttribute("data-qiraat");
        markSelected("[data-qiraat]", "data-qiraat", state.qiraat);
        saveState();
        updatePill();
        updateSummary();
        showScreen("time");
      });
    });

    forEach(document.querySelectorAll("[data-minutes]"), function (b) {
      b.addEventListener("click", function () {
        state.minutes = parseInt(b.getAttribute("data-minutes"), 10);
        markSelected("[data-minutes]", "data-minutes", String(state.minutes));
        saveState();
        updateSplit();
        updateSummary();
      });
    });

    forEach(document.querySelectorAll("[data-task]"), function (b) {
      b.addEventListener("click", function () {
        openPractice(b.getAttribute("data-task"));
      });
    });

    forEach(document.querySelectorAll("[data-goto]"), function (b) {
      b.addEventListener("click", function () {
        showScreen(b.getAttribute("data-goto"));
      });
    });

    el("micBtn").addEventListener("click", toggleMic);
    el("practiceAgain").addEventListener("click", function () {
      lastResult = null;
      renderVerse();
      el("practiceResult").hidden = true;
      el("practiceStatus").textContent = "";
      clearMicError();
      el("heardLine").hidden = true;
      el("interimLine").hidden = true;
    });
    el("practiceNext").addEventListener("click", nextVerse);
    el("practiceClose").addEventListener("click", closePractice);

    if (state.mode) { markSelected("[data-mode]", "data-mode", state.mode); }
    if (state.qiraat) { markSelected("[data-qiraat]", "data-qiraat", state.qiraat); }
    markSelected("[data-minutes]", "data-minutes", String(state.minutes));
    updatePill();
    updateSplit();
    updateSummary();

    /* --- v3 wiring --- */
    el("surahSearch").addEventListener("input", function () {
      renderSurahList(el("surahSearch").value);
    });
    el("reciterSearch").addEventListener("input", function () {
      renderReciterList(el("reciterSearch").value);
    });
    el("toolbarPlay").addEventListener("click", function () {
      if (player.playing) {
        pauseAudio();
        el("toolbarPlay").textContent = "▶ Play";
      } else if (player.ayahIndex >= 0 && player.surah === state.currentSurah) {
        playAyah(player.surah, player.ayahIndex, { continuous: true, fallbackReciterId: player.fallbackReciterId });
        el("toolbarPlay").textContent = "⏸ Pause";
      } else {
        playAyah(state.currentSurah, 0, { continuous: true });
        el("toolbarPlay").textContent = "⏸ Pause";
      }
    });
    el("toolbarAudio").addEventListener("click", function () { showScreen("reciters"); });
    el("toolbarTranslation").addEventListener("click", function () {
      var note = el("translationNote");
      note.hidden = !note.hidden;
      el("toolbarTranslation").classList.toggle("is-on", !note.hidden);
    });
    el("toolbarMore").addEventListener("click", function () {
      var panel = el("readSettings");
      panel.hidden = !panel.hidden;
      el("toolbarMore").classList.toggle("is-on", !panel.hidden);
    });
    el("settingsReciterBtn").addEventListener("click", function () { showScreen("reciters"); });
    el("speedSelect").addEventListener("change", function () {
      player.speed = parseFloat(el("speedSelect").value);
      audioEl.playbackRate = player.speed;
      updatePlaybackBar();
    });
    el("delaySelect").addEventListener("change", function () {
      player.ayaDelay = parseInt(el("delaySelect").value, 10);
    });
    el("repeatOneBtn").addEventListener("click", function () {
      player.repeatOne = !player.repeatOne;
      if (player.repeatOne) { player.repeatRange = null; }
      updatePlaybackBar();
    });
    el("rangeApplyBtn").addEventListener("click", function () {
      var surah = getSurah(state.currentSurah);
      if (!surah) { return; }
      var s = Math.max(1, parseInt(el("rangeStart").value, 10) || 1);
      var e = Math.min(surah.ayahs.length, parseInt(el("rangeEnd").value, 10) || 1);
      if (e < s) { e = s; }
      player.repeatRange = { start: s, end: e };
      player.repeatOne = false;
      updatePlaybackBar();
    });
    el("rangeClearBtn").addEventListener("click", function () {
      player.repeatRange = null;
      player.repeatOne = false;
      updatePlaybackBar();
    });
    el("fontMinus").addEventListener("click", function () {
      state.fontSize = Math.max(24, state.fontSize - 2);
      savePrefs();
      applyFontSize();
    });
    el("fontPlus").addEventListener("click", function () {
      state.fontSize = Math.min(44, state.fontSize + 2);
      savePrefs();
      applyFontSize();
    });
    el("translitBtn").addEventListener("click", function () {
      state.showTranslit = !state.showTranslit;
      savePrefs();
      forEach(document.querySelectorAll(".ayah-translit"), function (t) {
        t.hidden = !state.showTranslit;
      });
      updateTranslitButton();
    });
    el("downloadSurahBtn").addEventListener("click", downloadSurah);

    /* --- layout-fix round (Nov 2) --- */
    el("diagStart").addEventListener("click", openDiagnostic);
    el("diagRetake").addEventListener("click", openDiagnostic);
    el("diagStartLearning").addEventListener("click", function () {
      if (!diagRecommendation) { return; }
      state.mode = diagRecommendation.mode;
      markSelected("[data-mode]", "data-mode", state.mode);
      saveState();
      setChosenSurah(diagRecommendation.surah);
      updateSummary();
      closePractice();
      showScreen("loop");
    });
    el("changeLearningBtn").addEventListener("click", function () { showScreen("surahs"); });
    el("learnThisSurahBtn").addEventListener("click", function () { chooseSurah(state.currentSurah); });

    /* --- live feedback mode --- */
    el("liveFeedbackBtn").addEventListener("click", function () {
      var surah = getSurah(state.currentSurah);
      openLive(state.currentSurah, 1, Math.min(5, surah ? surah.ayahs.length : 5));
    });
    el("loopLiveBtn").addEventListener("click", function () {
      var ranges = currentTaskRanges();
      openLive(ranges.sabaq.surah, ranges.sabaq.from, ranges.sabaq.to);
    });
    el("liveMicBtn").addEventListener("click", toggleLiveMic);
    el("livePrevBtn").addEventListener("click", livePrev);
    el("liveNextBtn").addEventListener("click", liveNext);
    el("liveDoneBtn").addEventListener("click", liveDone);
    el("liveTryAgainBtn").addEventListener("click", liveTryAgain);
    el("liveSummaryNextBtn").addEventListener("click", liveNext);
    el("liveApplyRange").addEventListener("click", function () {
      if (!live) { return; }
      openLive(live.surah, parseInt(el("liveFrom").value, 10), parseInt(el("liveTo").value, 10));
    });
    el("liveChangeSurah").addEventListener("click", function () { showScreen("surahs"); });
    el("liveHoldToggle").addEventListener("click", function () { setLiveHold(!liveHold); });
    el("liveClearHistoryBtn").addEventListener("click", function () {
      liveMistakes = [];
      saveLiveMistakes();
      renderLiveHistory();
    });
    el("liveCloseBtn").addEventListener("click", function () { showScreen("lesson"); });
    el("liveSheetClose").addEventListener("click", closeLiveSheet);
    el("liveSheetCloseBtn").addEventListener("click", closeLiveSheet);
    el("liveSheet").addEventListener("click", function (ev) {
      if (ev.target === el("liveSheet")) { closeLiveSheet(); }
    });
    el("liveSheetRetry").addEventListener("click", liveSheetRetry);
    el("liveSheetDismiss").addEventListener("click", liveSheetDismiss);
    loadLiveMistakes();
    renderLiveHistory();
    try {
      if (localStorage.getItem("sabaq-v3-live-hold") === "on") { setLiveHold(true); }
    } catch (e) {}

    /* --- v4: intro / plan / lesson / captions --- */
    loadCapPrefs();
    loadLessonLevel();
    loadCompletedLessons();
    setCapMode(capMode);
    setCapFont(capFont);
    el("introGuestBtn").addEventListener("click", function () { continueAsGuest(); showScreen("plan"); });
    forEach(document.querySelectorAll("[data-plan]"), function (b) {
      b.addEventListener("click", function () { openPlan(b.getAttribute("data-plan")); });
    });
    forEach(document.querySelectorAll("[data-level]"), function (b) {
      b.addEventListener("click", function () { setLessonLevel(b.getAttribute("data-level")); });
    });
    el("tierSabaqStart").addEventListener("click", function () { startLesson("sabaq"); });
    el("tierSabqiStart").addEventListener("click", function () { startLesson("sabqi"); });
    el("tierManzilStart").addEventListener("click", function () { startLesson("manzil"); });
    el("lessonDiagnosticBtn").addEventListener("click", lessonDiagnostic);
    el("lessonResumeBtn").addEventListener("click", function () {
      if (!lastPosition) { return; }
      openLive(lastPosition.surah, lastPosition.from, lastPosition.to);
      saveLastPosition();
    });
    // The picker edits the Sabaq start; the level sets its length.
    el("lessonSurahSelect").addEventListener("change", function () {
      el("lessonFrom").value = 1;
      var surah = getSurah(parseInt(el("lessonSurahSelect").value, 10) || 1);
      el("lessonTo").value = surah
        ? Math.min(LESSON_LEVELS[lessonLevel].ayahs, surah.ayahs.length)
        : LESSON_LEVELS[lessonLevel].ayahs;
      renderLesson();
    });
    el("lessonJuzSelect").addEventListener("change", function () {
      var jn = parseInt(el("lessonJuzSelect").value, 10) || 30;
      var start = juzStarts[jn];
      if (start) {
        var surah = getSurah(start.surah);
        el("lessonFrom").value = start.ayah;
        el("lessonTo").value = surah
          ? Math.min(start.ayah + LESSON_LEVELS[lessonLevel].ayahs - 1, surah.ayahs.length)
          : start.ayah + LESSON_LEVELS[lessonLevel].ayahs - 1;
      }
      renderLesson();
    });
    el("lessonFrom").addEventListener("change", function () {
      var from = parseInt(el("lessonFrom").value, 10) || 1;
      var surah = getSurah(parseInt(el("lessonSurahSelect").value, 10) || 1);
      if (planKind !== "ayah" && planKind !== "review" && surah) {
        el("lessonTo").value = Math.min(from + LESSON_LEVELS[lessonLevel].ayahs - 1, surah.ayahs.length);
      }
      renderLesson();
    });
    el("lessonTo").addEventListener("change", function () { renderLesson(); });
    forEach(document.querySelectorAll("[data-capmode]"), function (b) {
      b.addEventListener("click", function () { setCapMode(b.getAttribute("data-capmode")); });
    });
    forEach(document.querySelectorAll("[data-capfont]"), function (b) {
      b.addEventListener("click", function () { setCapFont(b.getAttribute("data-capfont")); });
    });
    el("liveTeacherBtn").addEventListener("click", playTeacher);

    showScreen("intro");
    animateBasmala();
    loadData();
  }

  /* Test hook (used by the headless verification only). */
  window.SabaqTest = {
    normalizeArabic: normalizeArabic,
    scoreRecitation: scoreRecitation,
    bank: VERSE_BANK,
    getVerseIndex: function () { return verseIndex; },
    getTask: function () { return state.task; },
    getPracticeRef: function () { var v = currentVerse(); return v ? v.ref : ""; },
    getPracticeVerseText: function () { var v = currentVerse(); return v ? v.arabic : ""; },
    getActiveVerseCount: function () { return activeVerses.length; },
    getTaskVerseCount: function (task) { return taskVerses[task] ? taskVerses[task].length : 0; },
    getListening: function () { return listening; },
    scoreTranscript: function (text) { finalTranscript = text; finishListening(); },
    // Groq ear hooks (test-only; the key never lives in the app)
    groqConfigured: function () { return !!SABAQ_EAR_URL; },
    groqAvailable: groqAvailable,
    whichEarWouldUse: function () { return groqAvailable() ? EAR_GROQ : EAR_BROWSER; },
    getEarInUse: function () { return earInUse; },
    getEarLine: function () { return el("earLine") ? el("earLine").textContent : ""; },
    setEarUrl: function (url) { SABAQ_EAR_URL = url || ""; },
    scoreGroqTranscript: function (text) { setEarLine(EAR_GROQ); finalTranscript = text; finishListening(); },
    // v3 hooks
    dataLoaded: function () { return dataLoaded; },
    dataError: function () { return dataError; },
    surahCount: function () { return quranData ? quranData.surahs.length : 0; },
    ayahCount: function () {
      if (!quranData) { return 0; }
      var n = 0;
      quranData.surahs.forEach(function (s) { n += s.ayahs.length; });
      return n;
    },
    getCurrentSurah: function () { return state.currentSurah; },
    getReciterId: function () { return state.reciterId; },
    getReciters: function () { return reciterData ? reciterData.reciters.map(function (r) { return r.id; }) : []; },
    setReciter: setReciter,
    openRead: openRead,
    openSurahs: function () { showScreen("surahs"); },
    audioUrlFor: function (reciterId, surahNum, ayahInSurah) {
      var r = getReciter(reciterId);
      return r ? audioUrl(r, surahNum, ayahInSurah) : null;
    },
    getAudioSrc: function () { return audioEl ? audioEl.currentSrc || audioEl.src : ""; },
    playAyah: playAyah,
    stopAudio: stopAudio,
    getPlayingAyah: function () {
      if (player.ayahIndex < 0 || !player.surah) { return null; }
      return { surah: player.surah, ayahIndex: player.ayahIndex, playing: player.playing };
    },
    getPlayerState: function () {
      return {
        playing: player.playing, continuous: player.continuous,
        surah: player.surah, ayahIndex: player.ayahIndex,
        speed: player.speed, repeatOne: player.repeatOne,
        repeatRange: player.repeatRange, ayaDelay: player.ayaDelay
      };
    },
    getDownloadState: function () {
      var r = currentReciter();
      return r ? (downloadState[downloadKey(state.currentSurah, r.id)] || "not-downloaded") : "not-downloaded";
    },
    simulateEnded: onAyahEnded,
    // layout-fix round hooks (test-only)
    getScreen: function () { return state.screen; },
    getAccountType: function () { return state.account ? state.account.type : null; },
    continueAsGuest: continueAsGuest,
    getChosenSurah: function () { return state.chosenSurah; },
    setChosenSurah: setChosenSurah,
    getTaskTitles: function () {
      return {
        sabaq: el("taskTitleSabaq") ? el("taskTitleSabaq").textContent : "",
        sabqi: el("taskTitleSabqi") ? el("taskTitleSabqi").textContent : "",
        manzil: el("taskTitleManzil") ? el("taskTitleManzil").textContent : ""
      };
    },
    getLearningLine: function () { return el("learningLine") ? el("learningLine").textContent : ""; },
    openJuz: openJuz,
    getJuzStart: function (n) { return juzStarts[n] || null; },
    openDiagnostic: openDiagnostic,
    getDiagVerseCount: function () { return diagVerses ? diagVerses.length : 0; },
    getDiagScores: function () { return diagScores.slice(); },
    getDiagRecommendation: function () { return diagRecommendation; },
    getViewportMeta: function () {
      var m = document.querySelector('meta[name="viewport"]');
      return m ? m.getAttribute("content") : "";
    },
    getLiveState: function () {
      if (!live) { return null; }
      return {
        surah: live.surah, from: live.from, to: live.to, idx: live.idx,
        ayahRef: live.ayahs[live.idx].ref, total: live.ayahs.length,
        listening: liveListening, hold: liveHold
      };
    },
    getLiveWords: function () {
      if (!live) { return []; }
      return live.words.map(function (w) {
        return { text: w.text, state: w.state, heard: w.heard,
                 gloss: w.gloss || "", pos: w.pos || "", subs: w.subs || [] };
      });
    },
    // v4 hooks
    wordsLoaded: function () { return !!wordsData; },
    getWordData: function (s, a) { return getWordData(s, a); },
    getCaptionWords: function (s, a) {
      var surah = getSurah(s);
      var text = surah && surah.ayahs[a - 1] ? surah.ayahs[a - 1].text : "";
      return captionWordsForAyah(s, a, text);
    },
    getCapMode: function () { return capMode; },
    setCapMode: setCapMode,
    getCapFont: function () { return capFont; },
    setCapFont: setCapFont,
    getTeacherListens: function () { return teacherListens; },
    playTeacher: playTeacher,
    isTeacherBtnHidden: function () { return el("liveTeacherBtn") ? el("liveTeacherBtn").hidden : true; },
    getLastPosition: function () { return lastPosition; },
    clearLastPosition: function () {
      lastPosition = null;
      lessonPickerInit = false; // re-seed the picker from fresh defaults
      try { localStorage.removeItem("sabaq-v4-last"); } catch (e) {}
      renderLesson();
    },
    getPlan: function () { return planKind; },
    openPlan: openPlan,
    startLesson: startLesson,
    lessonDiagnostic: lessonDiagnostic,
    getLessonLevel: function () { return lessonLevel; },
    setLessonLevel: setLessonLevel,
    getTierRanges: function () {
      return {
        sabaq: sabaqRange(), sabqi: sabqiRange(), manzil: manzilRange(),
        level: lessonLevel
      };
    },
    getCompletedLessons: function () { return completedLessons.slice(); },
    seedCompletedLessons: function (list) {
      completedLessons = (list || []).slice(0, 20);
      saveCompletedLessons();
      renderLesson();
    },
    clearCompletedLessons: function () {
      completedLessons = [];
      saveCompletedLessons();
      renderLesson();
    },
    getStoppedAt: function () { return liveStoppedAt; },
    getLiveDiag: function () { return liveDiag; },
    getDiagReport: function () {
      return liveDiagStats ? {
        total: liveDiagStats.total, heard: liveDiagStats.heard,
        substituted: liveDiagStats.substituted, skipped: liveDiagStats.skipped,
        extra: liveDiagStats.extra
      } : null;
    },
    getBasmalaLetters: function () {
      // v4b: the Basmala animates as 4 word spans, not per letter.
      var ar = el("introBasmala");
      return ar ? ar.querySelectorAll(".lt").length : 0;
    },
    basmalaIsGo: function () {
      var ar = el("introBasmala");
      return ar ? ar.classList.contains("go") : false;
    },
    // v4b: current-word detail strip contents (test-only).
    getCapDetail: function () {
      var box = el("capDetail");
      if (!box) { return null; }
      return {
        hidden: box.hidden,
        pills: el("capDetailPills") ? el("capDetailPills").textContent : "",
        ar: el("capDetailAr") ? el("capDetailAr").textContent : "",
        gloss: el("capDetailGloss") ? el("capDetailGloss").textContent : ""
      };
    },
    getLiveSheetWordInfo: function () {
      var info = el("liveSheetWordInfo");
      return info ? { hidden: info.hidden, text: info.textContent } : null;
    },
    // Feed a transcript as if a Groq slice just landed (cumulative text).
    applyLiveTranscript: applyLiveTranscript,
    getLiveHeard: function () { return liveHeardText; },
    getLiveScore: function () {
      return live ? { heard: liveScore(), total: live.words.length } : null;
    },
    getLiveMistakes: function () {
      return liveMistakes.map(function (m) {
        return { id: m.id, ref: m.ref, correct: m.correct, heard: m.heard, status: m.status };
      });
    },
    setLiveHold: setLiveHold,
    liveNext: liveNext,
    livePrev: livePrev,
    liveDone: liveDone,
    liveTryAgain: liveTryAgain,
    openLiveSheet: openLiveSheet,
    closeLiveSheet: closeLiveSheet,
    getLiveSheetWord: function () { return liveSheetWord; },
    getLiveSheetText: function () {
      return {
        heard: el("liveSheetHeard") ? el("liveSheetHeard").textContent : "",
        correct: el("liveSheetCorrect") ? el("liveSheetCorrect").textContent : "",
        hidden: el("liveSheet") ? el("liveSheet").hidden : true
      };
    },
    liveSheetRetry: liveSheetRetry,
    liveSheetDismiss: liveSheetDismiss,
    dismissLiveMistake: dismissLiveMistake,
    getLiveSummary: function () {
      return {
        hidden: el("liveSummary").hidden,
        title: el("liveSummaryTitle").textContent,
        line: el("liveSummaryLine").textContent
      };
    },
    getLiveHoldNoteHidden: function () { return el("liveHoldNote").hidden; },
    getLiveScreen: function () { return state.screen; },
    openLive: openLive,
    getLiveHistoryCount: function () { return liveMistakes.length; },
    clearLiveMistakes: function () {
      liveMistakes = [];
      saveLiveMistakes();
      renderLiveHistory();
    },
    // Quran-wide scorer self-check: every ayah scored against its own
    // plain (diacritic-free) form must be 100.
    selfCheckAll: function () {
      if (!quranData) { return null; }
      var total = 0, perfect = 0, bad = [];
      quranData.surahs.forEach(function (s) {
        s.ayahs.forEach(function (a) {
          total++;
          var words = a.text.split(/\s+/);
          var plain = normalizeArabic(a.text).split(/\s+/).filter(function (w) { return w; });
          var r = scoreRecitation(words, plain);
          if (r.score === 100) { perfect++; }
          else if (bad.length < 5) { bad.push(s.number + ":" + a.numberInSurah + " -> " + r.score); }
        });
      });
      return { total: total, perfect: perfect, bad: bad };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
