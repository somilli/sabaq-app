/* Sabaq v3 — Week 1: content spine + audio player + reciter picker + Read mode.
   Small static site: index.html + app.js + style.css + data/quran.json + data/reciters.json.
   Runs over HTTP (local server / Cloudflare Pages), NOT file:// — the Quran text
   loads via fetch(). No backend, no API keys, no accounts, no payments.
   Live practice check (Web Speech) is ported from v2 as-is. */

(function () {
  "use strict";

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
    fontSize: 30
  };

  function saveState() {
    try {
      sessionStorage.setItem("sabaq-v1", JSON.stringify({
        mode: state.mode,
        qiraat: state.qiraat,
        minutes: state.minutes
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
    } catch (e) {}
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

  function normalizeArabic(s) {
    return (s || "")
      .replace(/[\u064B-\u0655\u0640]/g, "").replace(/\u0670/g, "ا")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitWords(s) {
    var n = normalizeArabic(s);
    return n ? n.split(" ") : [];
  }

  function lcsIndices(a, b) {
    var n = a.length, m = b.length;
    var dp = [], i, j;
    for (i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var matchedA = [], matchedB = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { matchedA.push(i); matchedB.push(j); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
      else { j++; }
    }
    return { a: matchedA, b: matchedB };
  }

  function scoreRecitation(expectedWords, heardWords) {
    var expected = expectedWords.map(normalizeArabic).filter(function (w) { return w; });
    var heard = heardWords.map(normalizeArabic).filter(function (w) { return w; });
    if (!expected.length) { return { score: 0, matched: [], missed: [], extras: heard }; }
    var lcs = lcsIndices(expected, heard);
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
  var bestScores = {};
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  var listening = false;
  var listenStart = 0;
  var restarts = 0;
  var finalTranscript = "";
  var lastResult = null;

  var TASK_LABELS = { sabaq: "Sabaq", sabqi: "Sabqi", manzil: "Manzil" };

  function currentVerse() { return VERSE_BANK[verseIndex]; }

  function saveProgress() {
    try {
      localStorage.setItem("sabaq-v2", JSON.stringify({ verseIndex: verseIndex, best: bestScores }));
    } catch (e) {}
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem("sabaq-v2");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (typeof saved.verseIndex === "number" && VERSE_BANK[saved.verseIndex]) { verseIndex = saved.verseIndex; }
      if (saved.best) { bestScores = saved.best; }
    } catch (e) {}
  }

  function updateProgressLine() {
    var best = bestScores[verseIndex];
    el("practiceProgress").textContent = "Verse " + (verseIndex + 1) + " of " + VERSE_BANK.length +
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
    el("practiceVerseNum").textContent = (verseIndex + 1) + " of " + VERSE_BANK.length;
    el("practiceQiraat").textContent = state.qiraat === "warsh" ? "Warsh" : "Hafs";
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
    if (listening) {
      listening = false;
      try { if (rec) { rec.stop(); } } catch (e) {}
      finishListening();
    } else {
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
    el("practiceNext").hidden = !pass;
    el("practiceNext").textContent = "Next verse";
    if (pass) {
      var prev = bestScores[verseIndex];
      if (typeof prev !== "number" || result.score > prev) { bestScores[verseIndex] = result.score; }
      saveProgress();
      updateProgressLine();
    }
    el("practiceResult").hidden = false;
    el("practiceResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openPractice(task) {
    state.task = task;
    lastResult = null;
    renderVerse();
    el("practiceResult").hidden = true;
    el("practiceStatus").textContent = "";
    clearMicError();
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
    if (!SR) {
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
    if (listening) {
      listening = false;
      try { if (rec) { rec.stop(); } } catch (e) {}
    }
    setMicUI(false);
    el("practicePanel").hidden = true;
    el("practiceResult").hidden = true;
    el("practiceStatus").textContent = "";
    clearMicError();
    el("heardLine").hidden = true;
    el("interimLine").hidden = true;
  }

  function nextVerse() {
    if (!lastResult || lastResult.score < 80) { return; }
    markTaskDone(state.task);
    if (verseIndex >= VERSE_BANK.length - 1) {
      verseIndex = 0;
      saveProgress();
      renderVerse();
      el("practiceResult").hidden = true;
      el("heardLine").hidden = true;
      el("interimLine").hidden = true;
      clearMicError();
      el("practiceStatus").textContent = "You finished all 11 verses — starting again from the top.";
    } else {
      verseIndex++;
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

  /* ---------- 30-juz map (v2) ---------- */

  function buildJuzGrid() {
    var grid = el("juzGrid");
    var html = "";
    for (var i = 1; i <= 30; i++) {
      var cls = i === 30 ? "juz-tile in-progress" : "juz-tile";
      html += '<span class="' + cls + '" title="Juz ' + i + '">' + i + "</span>";
    }
    grid.innerHTML = html;
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
      })
    ]).then(function (results) {
      quranData = results[0];
      reciterData = results[1];
      dataLoaded = true;
      if (!state.reciterId) { state.reciterId = reciterData.defaultReciter; }
      renderSurahList("");
      renderReciterList("");
      updateReciterButton();
      openRead(1, { scroll: false });
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
        '<span class="ayah-text" dir="rtl" lang="ar">' + a.text +
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
    showScreen("read");
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

  /* ---------- Wire up (v2 + v3) ---------- */

  function init() {
    loadState();
    loadPrefs();
    loadProgress();
    buildJuzGrid();
    renderVerse();
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

    showScreen("home");
    loadData();
  }

  /* Test hook (used by the headless verification only). */
  window.SabaqTest = {
    normalizeArabic: normalizeArabic,
    scoreRecitation: scoreRecitation,
    bank: VERSE_BANK,
    getVerseIndex: function () { return verseIndex; },
    getListening: function () { return listening; },
    scoreTranscript: function (text) { finalTranscript = text; finishListening(); },
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
    simulateEnded: onAyahEnded
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
