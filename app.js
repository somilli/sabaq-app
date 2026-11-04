/* Sabaq v5 — retransform (Nov 4, 2026). Placement front door, Today as
   home (quest + 3 tiers + due strip), full-screen lesson stage + recap,
   flowing Mushaf page, Progress (journey map + XP + badges + analytics +
   parent view), 29-stage beginner path. Built on the v4c engine (SM-2,
   streaks, badges, XP, daily quest, Hifz rule) — that engine is untouched.
   The ear is the same Groq Worker as v3 (SABAQ_EAR_URL); the live engine
   (2.5 s cumulative slices, LCS scoring, no prompt) is reused unchanged,
   and placement uses the same ear and scorer. Word data: data/words.json
   — Quranic Arabic Corpus morphology v0.4 (POS + grammar features) +
   word-by-word English glosses. A word with no data shows Arabic only;
   no gloss or tag is ever invented. Small static site: index.html +
   app.js + style.css + data/quran.json + data/reciters.json +
   data/words.json. Runs over HTTP, NOT file://.
   Deleted in v5 (spec §2.3): the Home mode picker, the plan picker as a
   front door, the Time screen (folded into Today), the Loop screen and
   the v2 practice check, the Family screen (sample children — never
   recreated), the Qira'at picker screen (now a sheet), the inline read
   settings panel (now a sheet), the v2 3-verse diagnostic (replaced by
   placement). */

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
    qiraat: "hafs", // default: Hafs first (spec §5/§6); loadState may restore Warsh
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

  /* v5 navigation: 3 tabs (Today / Mushaf / Progress). The top bar,
     bottom nav and footer are hidden on the full-screen lesson stage,
     the placement flow and the intro (the front door has no nav). */
  var FULLSCREEN_SCREENS = { live: true, placement: true, intro: true };
  function showScreen(name) {
    state.screen = name;
    forEach(document.querySelectorAll(".screen"), function (s) {
      s.classList.toggle("is-active", s.getAttribute("data-screen") === name);
    });
    forEach(document.querySelectorAll(".nav-btn"), function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-goto") === name);
    });
    document.body.classList.toggle("stage-open", !!FULLSCREEN_SCREENS[name]);
    closeSheets();
    if (name !== "live") { stopLiveListening(); }
    if (name === "today") { renderToday(); }
    if (name === "progress") { renderProgress(); }
    if (name === "beginner") { renderBeginnerPath(); }
    window.scrollTo(0, 0);
  }

  /* Sheets: the only overlay pattern in v5. Opening one closes any other. */
  function openSheet(id) {
    closeSheets();
    var sh = el(id);
    if (sh) { sh.hidden = false; }
  }
  function closeSheets() {
    forEach(document.querySelectorAll(".sheet-overlay"), function (sh) {
      sh.hidden = true;
    });
  }
  function closeSheet(id) {
    var sh = el(id);
    if (sh) { sh.hidden = true; }
  }

  /* ---------- UI updates (v2) ---------- */

  function updatePill() {
    el("qiraatPill").textContent = state.qiraat
      ? "Reading: " + (state.qiraat === "hafs" ? "Hafs" : "Warsh")
      : "Reading: —";
  }

  function updateSplit() {
    var split = SPLITS[state.minutes];
    var total = state.minutes;
    var ms = el("minSabaq"), mq = el("minSabqi"), mz = el("minManzil");
    if (ms) { ms.textContent = split[0] + " min"; }
    if (mq) { mq.textContent = split[1] + " min"; }
    if (mz) { mz.textContent = split[2] + " min"; }
    var tv = el("timeTodayVal");
    if (tv) { tv.textContent = total + " min"; }
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

  /* ---------- Groq ear availability (kept; the v2 practice check and
     the v2 3-verse diagnostic were deleted in v5 — placement and the
     live engine replace them) ---------- */
  function groqAvailable() {
    return !!SABAQ_EAR_URL && typeof MediaRecorder !== "undefined";
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

  // v5: tapping a juz tile opens the Mushaf at that juz's first surah
  // (spec §7.1). It does not change today's lesson.
  function openJuz(n) {
    if (!quranData || !juzStarts[n]) { return false; }
    var start = juzStarts[n];
    state.currentJuz = n;
    buildJuzGrid();
    openRead(start.surah);
    var row = document.querySelector('.flow-ayah[data-ayah="' + start.ayah + '"]');
    if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); }
    return true;
  }

  /* ---------- 30-juz map (v2) ---------- */

  /* v5 juz map (spec §7.1): completed = solid gold + tick; current =
     ink + gold pulse ring; in-progress = partial gold fill (bottom-up,
     real coverage %); untouched = paper. The next lesson's juz gets a
     gold dot under the tile. A juz is completed only when every ayah in
     it has been covered by a finished lesson. */
  function currentJuz() {
    var sb = sabaqRange();
    if (sb) { var j = juzFor(sb.surah, sb.from); if (j) { return j; } }
    return 30;
  }
  function juzCoverageCount(j) {
    var cov = juzCoverage[j] || {};
    return Object.keys(cov).length;
  }
  function buildJuzGrid() {
    var grid = el("juzGrid");
    if (!grid) { return; }
    var cur = currentJuz();
    var nextJuz = null;
    var sb = sabaqRange();
    if (sb) { nextJuz = juzFor(sb.surah, sb.from); }
    var html = "";
    for (var i = 1; i <= 30; i++) {
      var total = juzAyahCount(i);
      var done = juzCoverageCount(i);
      var cls = "juz-tile";
      var label = String(i);
      if (total && done >= total) { cls += " is-done"; label = i + " \u2713"; }
      else if (i === cur) { cls += " is-current"; }
      else if (done > 0) { cls += " is-progress"; }
      if (state.currentJuz === i) { cls += " is-selected"; }
      if (nextJuz === i) { cls += " has-next-dot"; }
      var fill = total ? Math.round(done / total * 100) : 0;
      html += '<button class="' + cls + '" type="button" data-juz="' + i +
        '" data-fill="' + fill + '" style="--fill:' + fill + '%" title="Juz ' + i + '">' + label + "</button>";
    }
    grid.innerHTML = html;
    forEach(grid.querySelectorAll("[data-juz]"), function (b) {
      b.addEventListener("click", function () {
        openJuz(parseInt(b.getAttribute("data-juz"), 10));
      });
    });
    var line = el("juzMapLine");
    if (line) {
      var total = juzAyahCount(cur);
      line.textContent = "Juz " + cur + " · " + juzCoverageCount(cur) + " of " + total + " ayahs";
    }
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
      loadPlacement();
      loadBeginner();
      renderLesson(); // pre-fill Today (tiers + picker)
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
      var cov = surahCoverage[s.number] || {};
      var doneCount = Object.keys(cov).length;
      var pct = s.ayahs.length ? Math.round(doneCount / s.ayahs.length * 100) : 0;
      html += '<button class="surah-row" type="button" data-surah="' + s.number + '">' +
        '<span class="surah-num">' + s.number + '</span>' +
        '<span class="surah-names"><span class="surah-name-en">' + s.englishName + '</span><br />' +
        '<span class="surah-name-sub">' + (s.englishNameTranslation || "") + ' · ' + s.revelationType + '</span></span>' +
        '<span class="surah-side"><span class="surah-name-ar" dir="rtl" lang="ar">' + s.name + '</span>' +
        '<span class="surah-count">' + s.ayahs.length + ' ayahs</span></span>' +
        '<span class="surah-progress"><span class="surah-progress-fill" style="width:' + pct + '%"></span></span>' +
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

  /* v5 Mushaf reading page (spec §6): ayahs flow as continuous RTL
     text, one after the next, each ending with its number in a
     gold-ringed ornament. Tapping an ayah plays it (gold wash); tapping
     a word opens the word sheet (data from words.json only). The
     Bismillah is stripped from ayah 1 of surahs 2–114 and shown once as
     a centred line; surah 1's ayah 1 IS the Basmala; surah 9 has none.
     The translation note shows once per surah, the first time it opens. */
  var shownTranslationNote = {}; // surah number -> true (this session)
  var readFont = "uthmani"; // reading-page script: uthmani | alkalami | kufi
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
    var note = el("translationNote");
    if (!shownTranslationNote[surahNum]) {
      shownTranslationNote[surahNum] = true;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    var warsh = el("warshNote");
    if (warsh) { warsh.hidden = state.qiraat !== "warsh"; }
    var list = el("ayahList");
    var html = "";
    surah.ayahs.forEach(function (a, i) {
      var words = captionWordsForAyah(surahNum, a.numberInSurah, a.text);
      html += '<span class="flow-ayah" data-ayah-index="' + i + '" data-ayah="' + a.numberInSurah + '" role="button" tabindex="0">';
      words.forEach(function (w, wi) {
        html += '<span class="flow-word" data-word="' + wi + '">' + escHtml(w.text) + "</span> ";
      });
      html += '<span class="ayah-end">' + a.numberInSurah + "</span></span>";
      if (a.translit) {
        html += '<span class="ayah-translit" data-translit-for="' + i + '"' + (state.showTranslit ? "" : " hidden") + ">" + escHtml(a.translit) + "</span>";
      }
      html += '<span class="ayah-audio-error" data-error-for="' + i + '" hidden></span>';
    });
    list.innerHTML = html;
    list.setAttribute("data-readfont", readFont);
    forEach(list.querySelectorAll(".flow-ayah"), function (b) {
      b.addEventListener("click", function () {
        var idx = parseInt(b.getAttribute("data-ayah-index"), 10);
        playAyah(state.currentSurah, idx, { continuous: false });
      });
    });
    forEach(list.querySelectorAll(".flow-word"), function (w) {
      w.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var ayahEl = w.closest(".flow-ayah");
        var ayahNum = parseInt(ayahEl.getAttribute("data-ayah"), 10);
        var wi = parseInt(w.getAttribute("data-word"), 10);
        openWordSheet(state.currentSurah, ayahNum, wi);
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

  /* v5 word sheet: Arabic + gloss + grammar pills, all from words.json.
     A word with no gloss shows Arabic + grammar only; a word with no
     data shows Arabic only. Nothing is invented. */
  var wordSheetAyah = null; // { surah, ayah } the sheet was opened from
  function openWordSheet(surahNum, ayahNum, wordIndex) {
    var words = captionWordsForAyah(surahNum, ayahNum,
      (getSurah(surahNum) && getSurah(surahNum).ayahs[ayahNum - 1]) ? getSurah(surahNum).ayahs[ayahNum - 1].text : "");
    var w = words[wordIndex];
    if (!w) { return; }
    wordSheetAyah = { surah: surahNum, ayah: ayahNum };
    el("wordSheetAr").textContent = w.text;
    el("wordSheetGloss").textContent = w.gloss || "";
    var pills = "";
    if (w.pos) { pills += '<span class="cap-pill pos">' + escHtml(w.pos) + "</span>"; }
    (w.subs || []).forEach(function (t) {
      pills += '<span class="cap-pill sub">' + escHtml(t) + "</span>";
    });
    el("wordSheetPills").innerHTML = pills;
    openSheet("wordSheet");
  }

  /* Reading-page script: cycles Uthmani -> West African -> Kufic. */
  function cycleReadFont() {
    readFont = readFont === "uthmani" ? "alkalami" : readFont === "alkalami" ? "kufi" : "uthmani";
    var list = el("ayahList");
    if (list) { list.setAttribute("data-readfont", readFont); }
    var btn = el("toolbarFont");
    if (btn) {
      btn.textContent = readFont === "uthmani" ? "Font · Uthmani"
        : readFont === "alkalami" ? "Font · West African" : "Font · Kufic";
    }
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
    forEach(document.querySelectorAll(".flow-ayah.is-playing"), function (r) {
      r.classList.remove("is-playing");
    });
  }

  function highlightAyah(surahNum, ayahIndex) {
    clearHighlight();
    if (surahNum !== state.currentSurah) { return; }
    var row = document.querySelector('.flow-ayah[data-ayah-index="' + ayahIndex + '"]');
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
        closeSheet("reciterSheet");
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
      // Spec §9.3: the note is exactly this line; after the 3rd listen the
      // button disappears and no replacement text appears.
      note.textContent = left <= 0
        ? ""
        : "Hear line 1 first, up to 3 times — then you recite.";
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

  function recordCompletedLesson(surah, from, to, result) {
    if (!surah || !from) { return; }
    completedLessons = completedLessons.filter(function (l) {
      return !(l.surah === surah && l.from === from && l.to === to);
    });
    completedLessons.unshift({ surah: surah, from: from, to: to, ts: Date.now() });
    if (completedLessons.length > 20) { completedLessons.length = 20; }
    saveCompletedLessons();
    // v4c: a lesson with real heard words also feeds SM-2, the streak,
    // the lesson log, the word counter and the juz coverage. A lesson
    // recorded without a result (old callers) only feeds Sabqi/Manzil.
    if (result && typeof result.heard === "number" && typeof result.total === "number" && result.total > 0) {
      var today = todayStr();
      var accuracy = Math.round(result.heard / result.total * 100);
      var grade = gradeForAccuracy(accuracy);
      recordLessonLog({ date: today, heard: result.heard, total: result.total,
                        surah: surah, from: from, to: to, ts: Date.now() });
      recordStreakDay(today);
      progressTotals.wordsHeard += result.heard;
      progressTotals.lessons += 1;
      saveTotals();
      markCoverage(surah, from, to);
      saveJuzCoverage();
      saveSurahCoverage();
      bankXpFinishes(surah, from, to, today);
      sm2Update(surah, from, to, grade, today);
    }
  }

  /* ================= v4c: SM-2 + streaks + badges + progress ============
     Everything here is localStorage only, guest only, no network, no
     new AI cost. Nothing is invented: every number comes from a real
     completed lesson (or a real diagnostic). The ear, the modes, the
     caption line and the v4b look are untouched.
     Grade mapping (accuracy = words heard / words in the lesson):
       >= 95% -> 5 · 85–94% -> 4 · 70–84% -> 3 · 50–69% -> 2 · < 50% -> 1
     "Heard" counts words in state good / fixed / dismissed — the same
     definition the diagnostic report uses, so a dismissed word (the
     user's override of a false positive) counts as heard. */

  /* ---------- Dates (local-timezone calendar days) ---------- */
  var testToday = null; // test-only override, "YYYY-MM-DD" or null
  function pad2(n) { return ("0" + n).slice(-2); }
  function localDateStr(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function parseLocalDate(s) {
    var p = String(s || "").split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  function addDaysStr(dateStr, n) {
    var d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + n);
    return localDateStr(d);
  }
  function todayStr() { return testToday || localDateStr(new Date()); }
  function daysBetween(a, b) {
    return Math.round((parseLocalDate(b) - parseLocalDate(a)) / 86400000);
  }
  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtShortDate(dateStr) {
    var d = parseLocalDate(dateStr);
    return d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
  }

  /* ---------- SM-2 spaced repetition ---------- */
  // One record per lesson range, keyed "surah:from-to". Not capped at 20
  // like completedLessons — a review item must survive until it is due.
  var sm2 = {};
  function sm2Key(surah, from, to) { return surah + ":" + from + "-" + to; }
  function loadSM2() {
    try {
      var raw = localStorage.getItem("sabaq-v4-sm2");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        Object.keys(saved).forEach(function (k) {
          var r = saved[k];
          if (r && typeof r.surah === "number" && typeof r.from === "number" &&
              typeof r.due === "string") { sm2[k] = r; }
        });
      }
    } catch (e) {}
  }
  function saveSM2() {
    try { localStorage.setItem("sabaq-v4-sm2", JSON.stringify(sm2)); } catch (e) {}
  }
  function gradeForAccuracy(acc) {
    if (acc >= 95) { return 5; }
    if (acc >= 85) { return 4; }
    if (acc >= 70) { return 3; }
    if (acc >= 50) { return 2; }
    return 1;
  }
  function sm2Update(surah, from, to, grade, today) {
    var key = sm2Key(surah, from, to);
    var r = sm2[key] || { surah: surah, from: from, to: to,
                          ef: 2.5, interval: 0, reps: 0, due: today,
                          grade: null, ts: 0 };
    // Ease factor moves on every review (classic SM-2), floored at 1.3.
    r.ef = Math.max(1.3, r.ef + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
    if (grade >= 3) {
      if (r.reps === 0) { r.interval = 1; }
      else if (r.reps === 1) { r.interval = 6; }
      else { r.interval = Math.max(1, Math.round(r.interval * r.ef)); }
      r.reps += 1;
    } else {
      // Failed review: start the ladder again, due tomorrow.
      r.reps = 0;
      r.interval = 1;
    }
    r.grade = grade;
    r.due = addDaysStr(today, r.interval);
    r.ts = Date.now();
    sm2[key] = r;
    saveSM2();
    return r;
  }
  function getDueItems(today) {
    var out = [];
    Object.keys(sm2).forEach(function (k) { out.push(sm2[k]); });
    out = out.filter(function (r) { return r.due <= today; });
    out.sort(function (a, b) {
      if (a.due !== b.due) { return a.due < b.due ? -1 : 1; }
      return (a.ts || 0) - (b.ts || 0);
    });
    return out;
  }
  function getNextDueDate(today) {
    var next = null;
    Object.keys(sm2).forEach(function (k) {
      var d = sm2[k].due;
      if (d > today && (next === null || d < next)) { next = d; }
    });
    return next;
  }

  /* ---------- Daily streak ---------- */
  var streakDays = []; // ["YYYY-MM-DD", ...] — one entry per day a lesson was completed
  function loadStreakDays() {
    try {
      var raw = localStorage.getItem("sabaq-v4-days");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        streakDays = saved.filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
      }
    } catch (e) {}
  }
  function saveStreakDays() {
    try { localStorage.setItem("sabaq-v4-days", JSON.stringify(streakDays)); } catch (e) {}
  }
  function recordStreakDay(dateStr) {
    if (streakDays.indexOf(dateStr) < 0) {
      streakDays.push(dateStr);
      streakDays.sort();
      saveStreakDays();
    }
  }
  function streakStats(today) {
    var set = {};
    streakDays.forEach(function (d) { set[d] = true; });
    var sorted = Object.keys(set).sort();
    var best = 0, run = 0, prev = null;
    sorted.forEach(function (d) {
      run = (prev && daysBetween(prev, d) === 1) ? run + 1 : 1;
      if (run > best) { best = run; }
      prev = d;
    });
    // Current streak: the run ending today — or ending yesterday when
    // today has no lesson yet (the streak is still alive until midnight).
    var current = 0;
    var cursor = set[today] ? today : addDaysStr(today, -1);
    while (set[cursor]) { current++; cursor = addDaysStr(cursor, -1); }
    return { current: current, best: best, days: streakDays.slice() };
  }
  function weekDots(today) {
    var set = {};
    streakDays.forEach(function (d) { set[d] = true; });
    var letters = ["S", "M", "T", "W", "T", "F", "S"];
    var out = [];
    for (var i = 6; i >= 0; i--) {
      var d = addDaysStr(today, -i);
      out.push({ date: d, label: letters[parseLocalDate(d).getDay()],
                 done: !!set[d], isToday: i === 0 });
    }
    return out;
  }

  /* ---------- Lesson log (weekly analytics source of truth) ---------- */
  var lessonLog = []; // {date, heard, total, surah, from, to, ts} — max 100
  function loadLessonLog() {
    try {
      var raw = localStorage.getItem("sabaq-v4-lesson-log");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        lessonLog = saved.filter(function (e) {
          return e && typeof e.date === "string" &&
            typeof e.heard === "number" && typeof e.total === "number";
        }).slice(0, 100);
      }
    } catch (e) {}
  }
  function saveLessonLog() {
    try { localStorage.setItem("sabaq-v4-lesson-log", JSON.stringify(lessonLog)); } catch (e) {}
  }
  function recordLessonLog(entry) {
    lessonLog.unshift(entry);
    if (lessonLog.length > 100) { lessonLog.length = 100; }
    saveLessonLog();
  }

  /* ---------- Lifetime totals ---------- */
  // xpSurahs / xpJuz record finishes whose XP has already been banked
  // (each with its date) — so a surah or juz can only ever pay out once.
  var progressTotals = { wordsHeard: 0, lessons: 0, diagnostics: [], xpSurahs: [], xpJuz: [] };
  function loadTotals() {
    try {
      var raw = localStorage.getItem("sabaq-v4-totals");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        if (typeof saved.wordsHeard === "number") { progressTotals.wordsHeard = saved.wordsHeard; }
        if (typeof saved.lessons === "number") { progressTotals.lessons = saved.lessons; }
        if (Array.isArray(saved.diagnostics)) {
          progressTotals.diagnostics = saved.diagnostics.filter(function (d) {
            return /^\d{4}-\d{2}-\d{2}$/.test(d);
          }).slice(0, 50);
        }
        if (Array.isArray(saved.xpSurahs)) {
          progressTotals.xpSurahs = saved.xpSurahs.filter(function (e) {
            return e && typeof e.surah === "number" && typeof e.date === "string";
          });
        }
        if (Array.isArray(saved.xpJuz)) {
          progressTotals.xpJuz = saved.xpJuz.filter(function (e) {
            return e && typeof e.juz === "number" && typeof e.date === "string";
          });
        }
      }
    } catch (e) {}
  }
  function saveTotals() {
    try { localStorage.setItem("sabaq-v4-totals", JSON.stringify(progressTotals)); } catch (e) {}
  }
  function recordDiagnosticCompletion() {
    if (!live || live.diagRecorded) { return; }
    live.diagRecorded = true;
    progressTotals.diagnostics.push(todayStr());
    if (progressTotals.diagnostics.length > 50) { progressTotals.diagnostics.shift(); }
    saveTotals();
  }

  /* ---------- Juz + surah coverage (for the "First Juz Finished" badge
     and for XP surah/juz payouts) ---------- */
  // Cumulative maps juz -> {"surah:ayah": true} and surah -> {"ayah": true}
  // for every ayah ever in a completed lesson. Unlike completedLessons
  // they are never capped, so a juz or surah finished over many lessons
  // still counts.
  var juzCoverage = {};
  var surahCoverage = {};
  function loadJuzCoverage() {
    try {
      var raw = localStorage.getItem("sabaq-v4-juz-ayahs");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && typeof saved === "object") { juzCoverage = saved; }
    } catch (e) {}
  }
  function saveJuzCoverage() {
    try { localStorage.setItem("sabaq-v4-juz-ayahs", JSON.stringify(juzCoverage)); } catch (e) {}
  }
  function loadSurahCoverage() {
    try {
      var raw = localStorage.getItem("sabaq-v4-surah-ayahs");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && typeof saved === "object") { surahCoverage = saved; }
    } catch (e) {}
  }
  function saveSurahCoverage() {
    try { localStorage.setItem("sabaq-v4-surah-ayahs", JSON.stringify(surahCoverage)); } catch (e) {}
  }
  function markCoverage(surah, from, to) {
    for (var a = from; a <= to; a++) {
      var j = juzFor(surah, a);
      if (j) {
        if (!juzCoverage[j]) { juzCoverage[j] = {}; }
        juzCoverage[j][surah + ":" + a] = true;
      }
      if (!surahCoverage[surah]) { surahCoverage[surah] = {}; }
      surahCoverage[surah][a] = true;
    }
  }
  function juzAyahCount(j) {
    if (!quranData) { return 0; }
    var n = 0;
    quranData.surahs.forEach(function (s) {
      s.ayahs.forEach(function (a) { if (a.juz === j) { n++; } });
    });
    return n;
  }
  function juzFinished(j) {
    var total = juzAyahCount(j);
    if (!total) { return false; }
    var cov = juzCoverage[j] || {};
    return Object.keys(cov).length >= total;
  }
  function finishedJuzList() {
    var out = [];
    for (var j = 1; j <= 30; j++) { if (juzFinished(j)) { out.push(j); } }
    return out;
  }
  function surahAyahCount(surahNum) {
    if (!quranData) { return 0; }
    var s = getSurah(surahNum);
    return s ? s.ayahs.length : 0;
  }
  function surahFinished(surahNum) {
    var total = surahAyahCount(surahNum);
    if (!total) { return false; }
    var cov = surahCoverage[surahNum] || {};
    return Object.keys(cov).length >= total;
  }
  function finishedSurahList() {
    var out = [];
    Object.keys(surahCoverage).forEach(function (k) {
      var n = parseInt(k, 10);
      if (surahFinished(n)) { out.push(n); }
    });
    return out.sort(function (a, b) { return a - b; });
  }
  // Bank XP payouts for finishes: a surah or juz pays out once, on the
  // day it is finished. Called only from a real completed lesson.
  function bankXpFinishes(surah, from, to, today) {
    var changed = false;
    var hasSurah = false;
    progressTotals.xpSurahs.forEach(function (e) { if (e.surah === surah) { hasSurah = true; } });
    if (!hasSurah && surahFinished(surah)) {
      progressTotals.xpSurahs.push({ surah: surah, date: today });
      changed = true;
    }
    var seenJuz = {};
    for (var a = from; a <= to; a++) {
      var j = juzFor(surah, a);
      if (!j || seenJuz[j]) { continue; }
      seenJuz[j] = true;
      var hasJuz = false;
      progressTotals.xpJuz.forEach(function (e) { if (e.juz === j) { hasJuz = true; } });
      if (!hasJuz && juzFinished(j)) {
        progressTotals.xpJuz.push({ juz: j, date: today });
        changed = true;
      }
    }
    if (changed) { saveTotals(); }
  }

  /* ---------- Badges (derived, never stored — an earned badge always
     has the real event behind it in the stores above) ---------- */
  var BADGE_DEFS = [
    { id: "first-lesson", icon: "\uD83D\uDCDA", name: "First Lesson", req: "Complete your first lesson" },
    { id: "streak-3", icon: "\uD83D\uDD25", name: "3-Day Streak", req: "Learn 3 days in a row" },
    { id: "streak-7", icon: "\uD83D\uDD25", name: "7-Day Streak", req: "Learn 7 days in a row" },
    { id: "streak-30", icon: "\uD83C\uDFC6", name: "30-Day Streak", req: "Learn 30 days in a row" },
    { id: "first-diagnostic", icon: "\uD83E\uDDED", name: "First Diagnostic", req: "Finish a diagnostic" },
    { id: "perfect-lesson", icon: "\u2728", name: "Perfect Lesson", req: "100% of words heard in a lesson" },
    { id: "words-100", icon: "\uD83D\uDCAF", name: "100 Words Heard", req: "100 words heard in lessons" },
    { id: "first-juz", icon: "\uD83C\uDF19", name: "First Juz Finished", req: "Cover every ayah of one juz" }
  ];
  function computeBadges() {
    var st = streakStats(todayStr());
    var perfect = false;
    lessonLog.forEach(function (e) { if (e.total > 0 && e.heard === e.total) { perfect = true; } });
    var earned = {
      "first-lesson": lessonLog.length > 0,
      "streak-3": st.best >= 3,
      "streak-7": st.best >= 7,
      "streak-30": st.best >= 30,
      "first-diagnostic": progressTotals.diagnostics.length > 0,
      "perfect-lesson": perfect,
      "words-100": progressTotals.wordsHeard >= 100,
      "first-juz": finishedJuzList().length > 0
    };
    return BADGE_DEFS.map(function (d) {
      return { id: d.id, icon: d.icon, name: d.name, req: d.req, earned: !!earned[d.id] };
    });
  }

  /* ---------- Weekly analytics (last 7 calendar days, real data only) ---------- */
  function weeklyAnalytics() {
    var today = todayStr();
    var weekStart = addDaysStr(today, -6);
    var heard = 0, total = 0, lessons = 0;
    lessonLog.forEach(function (e) {
      if (e.date >= weekStart && e.date <= today) {
        heard += e.heard;
        total += e.total;
        lessons++;
      }
    });
    return {
      wordsWeek: heard,
      lessonsWeek: lessons,
      accuracy: total > 0 ? Math.round(heard / total * 100) : null,
      dueCount: getDueItems(today).length,
      nextDue: getNextDueDate(today)
    };
  }

  /* ---------- XP + levels (QuranCast's math, Sabaq's ladder) ----------
     XP: 50 per completed lesson, 500 per completed surah, 5,000 per
     completed juz. QuranCast gives the endpoints (Newcomer up to Qari
     at 10,000 XP); the rungs between are Sabaq's own ladder, built so
     a lesson-a-day learner levels up every few weeks, not every day.
     XP is derived from the banked counters above — it can never be
     paid twice for the same finish, and it is never invented. */
  var XP_PER_LESSON = 50;
  var XP_PER_SURAH = 500;
  var XP_PER_JUZ = 5000;
  var LEVELS = [
    { name: "Newcomer", xp: 0 },
    { name: "Student", xp: 250 },
    { name: "Learner", xp: 750 },
    { name: "Reciter", xp: 1500 },
    { name: "Memorizer", xp: 3000 },
    { name: "Hafiz", xp: 5000 },
    { name: "Qari", xp: 10000 }
  ];
  function xpTotal() {
    return XP_PER_LESSON * progressTotals.lessons +
      XP_PER_SURAH * progressTotals.xpSurahs.length +
      XP_PER_JUZ * progressTotals.xpJuz.length;
  }
  function levelFor(xp) {
    var cur = LEVELS[0], next = null;
    LEVELS.forEach(function (l) {
      if (xp >= l.xp) { cur = l; }
      else if (!next) { next = l; }
    });
    return {
      name: cur.name,
      xp: xp,
      base: cur.xp,
      next: next,
      xpToNext: next ? next.xp - xp : 0,
      // Progress through the current level (0..1); Qari is full.
      progress: next ? (xp - cur.xp) / (next.xp - cur.xp) : 1
    };
  }

  /* ---------- Daily quest: 30 verses or 1 juz (QuranCast's quest) ----
     The quest is the day's goal, shown on the streak card and on the
     Today screen. Verses are ayahs covered by lessons completed today
     (a second take of the same ayahs still counts — it is recitation
     volume, and it is labelled as such). A juz finished today also
     completes the quest. The quest is a stretch goal, NOT a gate on
     the streak: a completed lesson still banks the streak day (the
     original rule). Gating the streak behind 30 verses would make the
     3/7/30-day badges unreachable at Beginner level (5 ayahs a day),
     so the quest stays aspirational — finishing it always banks the
     day anyway, because it takes completed lessons to get there. */
  var QUEST_VERSES = 30;
  function versesToday(today) {
    var n = 0;
    lessonLog.forEach(function (e) {
      if (e.date === today) { n += (e.to - e.from + 1); }
    });
    return n;
  }
  function questStatus(today) {
    var verses = versesToday(today);
    var juzDone = false;
    progressTotals.xpJuz.forEach(function (e) { if (e.date === today) { juzDone = true; } });
    return {
      verses: verses,
      target: QUEST_VERSES,
      juzDone: juzDone,
      done: verses >= QUEST_VERSES || juzDone
    };
  }

  /* ---------- Per-lesson tally (the lesson grade) ---------- */
  // Tallied per ayah as the user leaves it; a retry overwrites that
  // ayah's tally, so the grade is always the latest take of each ayah.
  function tallyLessonAyah() {
    if (!live || liveDiag) { return; }
    if (!live.lessonStats) { live.lessonStats = { perAyah: {} }; }
    var heard = 0;
    live.words.forEach(function (w) {
      if (w.state === "good" || w.state === "fixed" || w.state === "dismissed") { heard++; }
    });
    live.lessonStats.perAyah[live.idx] = { heard: heard, total: live.words.length };
  }
  function lessonTotals() {
    var heard = 0, total = 0;
    if (live && live.lessonStats) {
      Object.keys(live.lessonStats.perAyah).forEach(function (k) {
        var e = live.lessonStats.perAyah[k];
        heard += e.heard;
        total += e.total;
      });
    }
    return { heard: heard, total: total };
  }

  /* ---------- Rendering (v4c sections) ---------- */

  /* v5 helpers: safe DOM writes (some ids live on only one tab). */
  function setTxt(id, txt) { var e = el(id); if (e) { e.textContent = txt; } }
  function setFill(id, pct) { var e = el(id); if (e) { e.style.width = Math.round(pct) + "%"; } }
  var RING_C = 2 * Math.PI * 26; // 64px ring, r=26
  function setRing(fillId, numId, done, total) {
    var f = el(fillId), n = el(numId);
    var frac = total > 0 ? Math.min(1, done / total) : 0;
    if (f) {
      f.style.strokeDasharray = RING_C.toFixed(1);
      f.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(1);
    }
    if (n) { n.textContent = String(done); }
  }

  /* v5 Today header (spec §4.1): flame + streak left, XP + level
     right. No card, no dots row (the 7-day chart lives on Progress). */
  function renderStreakCard() {
    var today = todayStr();
    var st = streakStats(today);
    setTxt("streakNum", String(st.current));
    setTxt("streakLabel", st.current === 1 ? "day streak" : "days streak");
    setTxt("streakBest", "Best: " + st.best + " day" + (st.best === 1 ? "" : "s"));
    var lv = levelFor(xpTotal());
    setTxt("todayXpTotal", lv.xp.toLocaleString("en-US") + " XP");
    setTxt("todayXpLevel", lv.next
      ? lv.name + " \u00B7 " + lv.xpToNext.toLocaleString("en-US") + " XP to " + lv.next.name
      : lv.name + " \u00B7 the highest level");
    setFill("todayXpBarFill", lv.progress * 100);
    var q = questStatus(today);
    setTxt("streakQuest", q.done
      ? "Daily quest done \u2713 — " + (q.juzDone ? "1 juz finished today." : q.verses + " verses today.")
      : "Daily quest: " + q.verses + " / " + q.target + " verses");
  }
  function renderDueSection() {
    var sec = el("dueSection");
    if (!sec) { return; }
    var today = todayStr();
    var due = getDueItems(today);
    sec.hidden = due.length === 0;
    el("dueCount").textContent = String(due.length);
    setTxt("dueOldest", due.length ? rangeLabel(due[0]) : "");
    var list = el("dueList");
    list.innerHTML = "";
    due.forEach(function (d) {
      var item = document.createElement("div");
      item.className = "due-item";
      var info = document.createElement("div");
      info.className = "due-item-info";
      var t = document.createElement("div");
      t.className = "due-item-title";
      t.textContent = rangeLabel(d);
      var dt = document.createElement("div");
      var overdueDays = daysBetween(d.due, today);
      dt.className = "due-item-date" + (overdueDays > 0 ? " is-overdue" : "");
      dt.textContent = overdueDays === 0 ? "Due today"
        : overdueDays === 1 ? "Overdue by 1 day"
        : "Overdue by " + overdueDays + " days";
      info.appendChild(t);
      info.appendChild(dt);
      var btn = document.createElement("button");
      btn.className = "due-item-start";
      btn.type = "button";
      btn.textContent = "Review \u2192";
      (function (key) {
        btn.addEventListener("click", function () { startDueReview(key); });
      })(sm2Key(d.surah, d.from, d.to));
      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }
  function renderAnalytics() {
    var a = weeklyAnalytics();
    var today = todayStr();
    var st = streakStats(today);
    setTxt("statWordsWeek", a.lessonsWeek ? String(a.wordsWeek) : "\u2014");
    setTxt("statLessonsWeek", a.lessonsWeek ? String(a.lessonsWeek) : "\u2014");
    setTxt("statAccuracyWeek", a.accuracy === null ? "\u2014" : a.accuracy + "%");
    setTxt("statDueCount", String(a.dueCount));
    setTxt("statsNote", a.lessonsWeek
      ? "Last 7 days \u00B7 Streak: " + st.current + " day" + (st.current === 1 ? "" : "s") +
        " (best " + st.best + ") \u00B7 Next review: " +
        (a.dueCount ? a.dueCount + " due now" :
          a.nextDue ? fmtShortDate(a.nextDue) : "nothing scheduled") + "."
      : "Nothing yet \u2014 finish a lesson and your week shows here.");
    // XP + level.
    var lv = levelFor(xpTotal());
    setTxt("xpTotal", lv.xp.toLocaleString("en-US") + " XP");
    setTxt("xpLevel", lv.name);
    setFill("xpBarFill", lv.progress * 100);
    setTxt("xpNext", lv.next
      ? lv.xpToNext.toLocaleString("en-US") + " XP to " + lv.next.name
      : "Qari \u2014 the highest level");
    // Daily quest (ring + title + sub, spec §4.2 / §9.2).
    var q = questStatus(today);
    setTxt("questTitle", q.done ? "Quest done \u2713" : "30 verses or 1 juz");
    setTxt("questSub", q.done ? "30 verses. See you tomorrow."
      : "Verses = ayahs covered by lessons you finish today.");
    setTxt("questText", q.juzDone ? "1 juz finished today" : q.verses + " verses today");
    setFill("questBarFill", Math.min(100, q.verses / q.target * 100));
    setTxt("questProgress", q.juzDone
      ? "1 juz finished today"
      : q.verses + " / " + q.target + " verses today");
    setRing("questRingFill", "questRingNum", Math.min(q.verses, q.target), q.target);
    // Spec §4.2: the ring's number is the fraction ("12 / 30"), not the count.
    setTxt("questRingNum", q.verses + " / " + q.target);
    var qc = el("questCard");
    if (qc) { qc.classList.toggle("is-done", q.done); }
    renderWeekChart();
    renderParentView();
  }

  /* v5: 7-day analytics bar chart — one bar per day, height = words
     heard that day, from real lessons only. Empty days are empty bars. */
  function renderWeekChart() {
    var chart = el("weekChart");
    if (!chart || !quranData) { return; }
    var today = todayStr();
    var perDay = {};
    lessonLog.forEach(function (e) { perDay[e.date] = (perDay[e.date] || 0) + e.heard; });
    var days = [];
    for (var i = 6; i >= 0; i--) { days.push(addDaysStr(today, -i)); }
    var max = 0;
    days.forEach(function (d) { if ((perDay[d] || 0) > max) { max = perDay[d]; } });
    var letters = ["S", "M", "T", "W", "T", "F", "S"];
    var html = "";
    days.forEach(function (d, k) {
      var v = perDay[d] || 0;
      var h = max ? Math.max(v ? 8 : 2, Math.round(v / max * 72)) : 2;
      html += '<span class="week-bar-col"><span class="week-bar' + (v ? "" : " is-empty") + '" style="height:' + h + 'px" title="' +
        fmtShortDate(d) + ": " + v + ' words"></span><span class="week-bar-label">' +
        letters[parseLocalDate(d).getDay()] + "</span></span>";
    });
    chart.innerHTML = html;
  }

  /* v5 parent view (spec §7.5): this device's real practice only. Every
     sentence is built from real data; a sentence with no data behind it
     is omitted, never faked. */
  function renderParentView() {
    var body = el("parentBody");
    if (!body) { return; }
    var today = todayStr();
    var weekStart = addDaysStr(today, -6);
    var daysSet = {}, newAyahs = 0, heard = 0, total = 0, workingOn = null;
    lessonLog.forEach(function (e) {
      if (e.date >= weekStart && e.date <= today) {
        daysSet[e.date] = true;
        newAyahs += (e.to - e.from + 1);
        heard += e.heard;
        total += e.total;
        if (!workingOn) {
          var sr = getSurah(e.surah);
          workingOn = sr ? sr.englishName : null;
        }
      }
    });
    var days = Object.keys(daysSet).length;
    var st = streakStats(today);
    var due = getDueItems(today);
    var nextDue = getNextDueDate(today);
    var parts = [];
    if (days > 0) {
      parts.push("This week: " + days + " day" + (days === 1 ? "" : "s") + ", " +
        newAyahs + " new ayah" + (newAyahs === 1 ? "" : "s") +
        (total > 0 ? ", " + Math.round(heard / total * 100) + "% heard" : "") + ".");
    }
    if (st.current > 0) { parts.push("Streak: " + st.current + " day" + (st.current === 1 ? "" : "s") + "."); }
    if (workingOn) { parts.push("Working on: " + workingOn + "."); }
    if (due.length) {
      var d0 = due[0];
      var sr0 = getSurah(d0.surah);
      parts.push("Due next: " + (sr0 ? sr0.englishName : "") + " review " +
        (d0.due === today ? "today" : d0.due === addDaysStr(today, 1) ? "tomorrow" : fmtShortDate(d0.due)) + ".");
    } else if (nextDue) {
      parts.push("Due next: review " + (nextDue === addDaysStr(today, 1) ? "tomorrow" : fmtShortDate(nextDue)) + ".");
    }
    body.textContent = parts.length
      ? parts.join(" ")
      : "No practice yet \u2014 nothing to show. When someone recites on this device, their week shows up here.";
  }

  function renderBadges() {
    var grid = el("badgeGrid");
    if (!grid) { return; }
    grid.innerHTML = "";
    computeBadges().forEach(function (b) {
      var card = document.createElement("div");
      card.className = "badge-card" + (b.earned ? " is-earned" : "");
      var icon = document.createElement("div");
      icon.className = "badge-icon";
      icon.textContent = b.icon;
      var name = document.createElement("div");
      name.className = "badge-name";
      name.textContent = b.name;
      var req = document.createElement("div");
      req.className = "badge-req";
      req.textContent = b.earned ? "Earned \u2713" : b.req;
      card.appendChild(icon);
      card.appendChild(name);
      card.appendChild(req);
      grid.appendChild(card);
    });
  }
  function startDueReview(key) {
    var r = sm2[key];
    if (!r) { return false; }
    var ok = openLive(r.surah, r.from, r.to, { tier: "manzil" });
    if (ok) { saveLastPosition(); }
    return ok;
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

  /* Manzil: revision of older memorized juz, 1/4 to 1 juz. v4c: due SM-2
     reviews come FIRST — the most overdue lesson is today's Manzil
     (other than today's Sabaq range, which is new work, not review).
     With nothing due, it rotates daily through the juz that have
     completed lessons (other than the Sabaq juz); the daily slice is the
     level length of ayahs from the start of that juz. Null when no older
     juz exists yet. */
  function manzilRange() {
    var sb = sabaqRange();
    if (!sb) { return null; }
    var n = LESSON_LEVELS[lessonLevel].ayahs;
    var due = getDueItems(todayStr());
    for (var di = 0; di < due.length; di++) {
      var d = due[di];
      if (d.surah === sb.surah && d.from === sb.from && d.to === sb.to) { continue; }
      return { surah: d.surah, from: d.from, to: d.to, juz: juzFor(d.surah, d.from),
               due: true, dueDate: d.due };
    }
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

  /* v5: set the Sabaq picker (the "Choose" sheet writes through here,
     and placement applies its start through here). */
  function setLessonPicker(surahNum, from, to) {
    var surah = getSurah(surahNum);
    if (!surah) { return false; }
    var surahSel = el("lessonSurahSelect");
    if (surahSel) { surahSel.value = String(surahNum); }
    el("lessonFrom").value = from;
    el("lessonTo").value = Math.min(to, surah.ayahs.length);
    lessonPickerInit = true;
    renderLesson();
    return true;
  }

  /* v5: time stepper — 30 / 45 / 60 / 90 / 120 minutes. */
  function cycleTime(dir) {
    var steps = [30, 45, 60, 90, 120];
    var i = steps.indexOf(state.minutes);
    if (i < 0) { i = 1; }
    i = Math.max(0, Math.min(steps.length - 1, i + dir));
    state.minutes = steps[i];
    saveState();
    updateSplit();
    renderLesson();
  }

  /* Is this tier's range already finished today (Hifz rule: only a
     finished lesson counts)? Drives the "Done" state on the tier card. */
  function tierDoneToday(r) {
    if (!r) { return false; }
    var today = todayStr();
    for (var i = 0; i < lessonLog.length; i++) {
      var e = lessonLog[i];
      if (e.date === today && e.surah === r.surah && e.from === r.from && e.to === r.to) { return true; }
    }
    return false;
  }
  function tierRingFor(r, fillId, numId) {
    if (!r) { setRing(fillId, numId, 0, 1); return; }
    var heard = 0, total = 0;
    for (var i = 0; i < lessonLog.length; i++) {
      var e = lessonLog[i];
      if (e.surah === r.surah && e.from === r.from && e.to === r.to) {
        heard = e.heard; total = e.total; break;
      }
    }
    setRing(fillId, numId, heard, total || 1);
  }
  function markTierDone(cardId, btnId, done) {
    var card = el(cardId), btn = el(btnId);
    if (card) { card.classList.toggle("is-done", !!done); }
    if (btn) {
      btn.disabled = !!done;
      btn.textContent = done ? "Done \u2713"
        : (btnId === "tierSabaqStart" ? "Start Sabaq \u2192"
          : btnId === "tierSabqiStart" ? "Start Sabqi \u2192" : "Start Manzil \u2192");
    }
  }

  /* v5 Today (spec §4): header + quest + due strip + beginner card +
     three tier cards + compact settings row. */
  function renderToday() {
    renderLesson();
  }
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
    updateSplit();

    // The three tiers, every day: Sabaq (new) + Sabqi (recent) + Manzil (old).
    var split = SPLITS[state.minutes];
    var sb = sabaqRange();
    var sq = sabqiRange();
    var mz = manzilRange();
    if (sb) {
      var nAy = sb.to - sb.from + 1;
      el("tierSabaqTitle").textContent = rangeLabel(sb);
      el("tierSabaqSub").textContent = nAy + " new ayah" + (nAy > 1 ? "s" : "") + " · " + split[0] + " min";
      tierRingFor(sb, "tierRingSabaqFill", "tierRingSabaqNum");
      el("tierSabaqStart").hidden = false;
      markTierDone("tierSabaq", "tierSabaqStart", tierDoneToday(sb));
    }
    if (sq) {
      var nSq = sq.to - sq.from + 1;
      el("tierSabqiTitle").textContent = rangeLabel(sq);
      var recent = completedLessons[0];
      var yesterday = addDaysStr(todayStr(), -1);
      var isYesterday = false;
      lessonLog.forEach(function (e) {
        if (e.date === yesterday && e.surah === sq.surah && e.from === sq.from && e.to === sq.to) { isYesterday = true; }
      });
      el("tierSabqiSub").textContent = isYesterday
        ? "Yesterday's lesson · " + split[1] + " min"
        : nSq + " ayah" + (nSq > 1 ? "s" : "") + " · " + split[1] + " min";
      tierRingFor(sq, "tierRingSabqiFill", "tierRingSabqiNum");
      el("tierSabqiStart").hidden = false;
      markTierDone("tierSabqi", "tierSabqiStart", tierDoneToday(sq));
    } else {
      el("tierSabqiTitle").textContent = "No recent lesson yet";
      el("tierSabqiSub").textContent = "Finish your first lesson — your revision will show here.";
      setRing("tierRingSabqiFill", "tierRingSabqiNum", 0, 1);
      markTierDone("tierSabqi", "tierSabqiStart", false);
      el("tierSabqiStart").disabled = true;
      el("tierSabqiStart").hidden = true;
    }
    if (mz) {
      var nMz = mz.to - mz.from + 1;
      if (mz.due) {
        el("tierManzilTitle").textContent = rangeLabel(mz);
        var overdueDays = daysBetween(mz.dueDate, todayStr());
        el("tierManzilSub").textContent = (overdueDays === 0 ? "Due today" : overdueDays === 1 ? "Overdue by 1 day" : "Overdue by " + overdueDays + " days") +
          " · " + split[2] + " min";
      } else {
        el("tierManzilTitle").textContent = "Juz " + mz.juz + " · " + rangeLabel(mz);
        el("tierManzilSub").textContent = nMz + " ayah" + (nMz > 1 ? "s" : "") + " · " + split[2] + " min";
      }
      tierRingFor(mz, "tierRingManzilFill", "tierRingManzilNum");
      el("tierManzilStart").hidden = false;
      markTierDone("tierManzil", "tierManzilStart", tierDoneToday(mz));
    } else {
      el("tierManzilTitle").textContent = "No older revision yet";
      el("tierManzilSub").textContent = "Once you finish lessons in another juz, it will rotate here.";
      setRing("tierRingManzilFill", "tierRingManzilNum", 0, 1);
      markTierDone("tierManzil", "tierManzilStart", false);
      el("tierManzilStart").disabled = true;
      el("tierManzilStart").hidden = true;
    }
    var rnote = el("lessonNote");
    if (rnote) { rnote.hidden = true; }
    renderBeginnerCard();
    renderStreakCard();
    renderDueSection();
    renderAnalytics();
  }

  /* v5 Progress (spec §7): journey map + XP + badges + analytics +
     parent view + words to fix. */
  function renderProgress() {
    if (!quranData) { return; }
    buildJuzGrid();
    renderAnalytics();
    renderBadges();
    renderLiveHistory();
    var pf = el("pathFinishedLine");
    if (pf) { pf.hidden = !(beginnerState && beginnerState.graduated); }
  }

  /* v5 beginner card on Today (spec §4.6) — only for placed beginners. */
  function renderBeginnerCard() {
    var card = el("beginnerCard");
    if (!card) { return; }
    var show = placement && placement.track === "beginner" &&
      beginnerState && !beginnerState.graduated && quranData;
    card.hidden = !show;
    if (!show) { return; }
    var st = BEGINNER_STAGES[beginnerState.currentStage - 1];
    if (!st) { card.hidden = true; return; }
    var surah = getSurah(st.surah);
    el("beginnerCardTitle").textContent = "Stage " + st.n + " · " + st.name;
    var nAy = st.to - st.from + 1;
    el("beginnerCardSub").textContent = "Practice: " + (surah ? surah.englishName : "") +
      " " + st.from + "–" + st.to + " · " + nAy + " ayah" + (nAy > 1 ? "s" : "");
    el("beginnerCardBtn").textContent = "Continue Stage " + st.n + " →";
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

  /* v5: "Words to fix" lives on the recap and on Progress (spec §2.3),
     not on the lesson stage. Renders into both lists from the same
     liveMistakes store. */
  function renderLiveHistory() {
    var html = "";
    var openCount = 0;
    liveMistakes.forEach(function (m) {
      if (m.status === "open") { openCount++; }
      var statusText = m.status === "open" ? "Needs work" : (m.status === "fixed" ? "Fixed \u2713" : "Dismissed");
      html += '<button class="live-mistake' + (m.status === "fixed" ? " is-fixed" : "") +
        (m.status === "dismissed" ? " is-dismissed" : "") + '" type="button" data-mistake="' + m.id + '">' +
        '<span class="live-mistake-ref">' + m.ref + '</span>' +
        '<span class="live-mistake-words"><strong>' + m.correct + '</strong> — you said <em>' + (m.heard || "—") + '</em></span>' +
        '<span class="live-mistake-status ' + m.status + '">' + statusText + '</span>' +
        '<span class="live-mistake-x" data-dismiss="' + m.id + '" aria-label="Dismiss">✕</span>' +
        "</button>";
    });
    // The recap list is owned by showRecap (this lesson's still-open
    // words only); the full history lives on Progress alone.
    [["progressFixList", "progressFixNone"]].forEach(function (pair) {
      var box = el(pair[0]), note = el(pair[1]);
      if (!box) { return; }
      box.innerHTML = html;
      if (note) { note.hidden = liveMistakes.length !== 0; }
      forEach(box.querySelectorAll("[data-mistake]"), function (b) {
        b.addEventListener("click", function (ev) {
          var dis = ev.target && ev.target.getAttribute ? ev.target.getAttribute("data-dismiss") : null;
          if (dis) { ev.stopPropagation(); dismissLiveMistake(dis); return; }
          var m = findLiveMistake(b.getAttribute("data-mistake"));
          if (!m) { return; }
          if (live && live.surah === m.surah) {
            var idx = -1;
            live.ayahs.forEach(function (a, k) { if (a.numberInSurah === m.ayah) { idx = k; } });
            if (idx >= 0) { hideRecap(); liveGoTo(idx); openLiveSheet(m.wordIndex); return; }
          }
          openLive(m.surah, m.ayah, m.ayah);
          openLiveSheet(m.wordIndex);
        });
      });
    });
    var note = el("liveHistoryNote");
    if (note) { note.hidden = liveMistakes.length !== 0; }
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
    hideRecap();
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
             tier: (opts && opts.tier) || null,
             returnTo: (opts && opts.returnTo) || "today",
             beginnerStage: (opts && opts.beginnerStage) || null,
             chain: (opts && opts.chain) || null,
             chainIdx: (opts && typeof opts.chainIdx === "number") ? opts.chainIdx : 0,
             lessonStartTs: Date.now() };
    // v4c: per-ayah heard/total for the lesson grade, plus the
    // once-only guards for lesson / diagnostic completion.
    live.lessonStats = { perAyah: {} };
    live.lessonRecorded = false;
    live.diagRecorded = false;
    live.chainStats = live.chain ? { heard: 0, total: 0 } : null;
    liveResetTake();
    hideRecap();
    el("liveSummary").hidden = true;
    el("liveHeardLine").hidden = true;
    el("liveInterimLine").hidden = true;
    el("liveStatus").textContent = "";
    el("liveStatus").classList.remove("practice-error");
    syncQiraatToggle();
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

  /* v5 recap (spec §5.2): replaces the stage when the lesson ends. */
  var DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function fmtDueDate(dateStr) {
    var d = parseLocalDate(dateStr);
    return DAYS_SHORT[d.getDay()] + ", " + MONTHS_SHORT[d.getMonth()] + " " + d.getDate();
  }
  function hideRecap() {
    var c = el("recapCard");
    if (c) { c.hidden = true; }
    var scr = el("screen-live");
    if (scr) { scr.classList.remove("show-recap"); }
  }
  function countUpXp(elm, finalNum) {
    // Counts 0 -> final over ~600ms (§1.5); the final text is set at the
    // end (and immediately as a fallback if animation is unavailable).
    if (!elm) { return; }
    elm.textContent = "+" + finalNum + " XP";
    if (!window.requestAnimationFrame) { return; }
    var start = null;
    function step(ts) {
      if (start === null) { start = ts; }
      var k = Math.min(1, (ts - start) / 600);
      elm.textContent = "+" + Math.round(finalNum * k) + " XP";
      if (k < 1) { window.requestAnimationFrame(step); }
    }
    window.requestAnimationFrame(step);
  }
  function showRecap(data) {
    // data: {title, xp, xpExtra[], wordsHeard, wordsTotal, fixed,
    //        dismissed, openMistakes[], streak, dueStr, diag}
    var scr = el("screen-live");
    if (scr) { scr.classList.add("show-recap"); }
    el("recapTitle").textContent = data.title;
    var noteEl = el("recapNote");
    if (noteEl) {
      noteEl.hidden = !data.note;
      noteEl.textContent = data.note || "";
    }
    countUpXp(el("recapXp"), data.xp || 0);
    var extra = el("recapXpExtra");
    if (extra) {
      if (data.xpExtra && data.xpExtra.length) {
        extra.hidden = false;
        extra.textContent = data.xpExtra.join(" · ");
      } else { extra.hidden = true; extra.textContent = ""; }
    }
    el("recapWords").textContent = "Heard " + data.wordsHeard + " of " + data.wordsTotal + " words";
    el("recapMistakes").textContent = data.fixed + " fixed · " + data.dismissed + " dismissed";
    var list = el("recapFixList");
    var none = el("recapFixNone");
    if (data.openMistakes && data.openMistakes.length) {
      var html = "";
      data.openMistakes.forEach(function (m) {
        html += '<button class="live-mistake" type="button" data-mistake="' + m.id + '">' +
          '<span class="live-mistake-ref">' + m.ref + '</span>' +
          '<span class="live-mistake-words"><strong>' + m.correct + '</strong> — you said <em>' + (m.heard || "—") + '</em></span>' +
          "</button>";
      });
      list.innerHTML = html;
      if (none) { none.hidden = true; }
      forEach(list.querySelectorAll("[data-mistake]"), function (b) {
        b.addEventListener("click", function () {
          var m = findLiveMistake(b.getAttribute("data-mistake"));
          if (!m) { return; }
          hideRecap();
          if (live && live.surah === m.surah) {
            var idx = -1;
            live.ayahs.forEach(function (a, k) { if (a.numberInSurah === m.ayah) { idx = k; } });
            if (idx >= 0) { liveGoTo(idx); openLiveSheet(m.wordIndex); return; }
          }
          openLive(m.surah, m.ayah, m.ayah);
          openLiveSheet(m.wordIndex);
        });
      });
    } else {
      list.innerHTML = "";
      if (none) { none.hidden = false; }
    }
    el("recapStreak").textContent = "\uD83D\uDD25 " + data.streak + " day" + (data.streak === 1 ? "" : "s");
    // A diagnostic banks nothing, so there is no next review to show.
    var dueEl = el("recapDue");
    if (dueEl) {
      dueEl.hidden = !!data.diag;
      if (!data.diag) { dueEl.textContent = "Next review: " + data.dueStr; }
    }
    // A diagnostic's report replaces the fix list: showing "No words to
    // fix." above a report that says "Skipped: 1" contradicts itself.
    if (data.diag) {
      var fixTitle = el("recapFixTitle");
      if (fixTitle) { fixTitle.hidden = true; }
      if (list) { list.hidden = true; }
      if (none) { none.hidden = true; }
    }
    var diag = el("recapDiagReport");
    if (diag) {
      if (data.diag) {
        diag.hidden = false;
        // The recap title already says "Your report" — no second heading.
        var dt = el("recapDiagTitle");
        if (dt) { dt.hidden = true; }
        el("recapDiagLine").textContent = data.diag;
      } else { diag.hidden = true; }
    }
    var card = el("recapCard");
    if (card) { card.hidden = false; card.scrollIntoView({ behavior: "smooth", block: "start" }); }
    renderLiveHistory();
  }
  function lessonMistakeCounts() {
    var fixed = 0, dismissed = 0, open = [];
    var since = live ? live.lessonStartTs : 0;
    liveMistakes.forEach(function (m) {
      if ((m.ts || 0) < since) { return; }
      if (m.status === "fixed") { fixed++; }
      else if (m.status === "dismissed") { dismissed++; }
      else if (m.status === "open") { open.push(m); }
    });
    return { fixed: fixed, dismissed: dismissed, open: open };
  }
  function closeLive() {
    stopLiveListening();
    hideRecap();
    var dest = (live && live.returnTo === "read") ? "read" : "today";
    showScreen(dest);
  }
  function nextLessonAfterRecap() {
    if (!live) { showScreen("today"); return; }
    // Beginner chain: next range of the same stage.
    if (live.chain && live.chainIdx < live.chain.ranges.length - 1) {
      var nxt = live.chain.ranges[live.chainIdx + 1];
      var prevStats = live.chainStats || { heard: 0, total: 0 };
      var ok = openLive(nxt.surah, nxt.from, nxt.to,
        { tier: "beginner", beginnerStage: live.beginnerStage,
          chain: live.chain, chainIdx: live.chainIdx + 1 });
      if (ok && live) { live.chainStats = prevStats; }
      return;
    }
    // Beginner stage: next stage (or retry this one if not passed).
    if (live.beginnerStage) {
      var st = beginnerState;
      var next = st && st.passed.indexOf(live.beginnerStage) >= 0
        ? live.beginnerStage + 1 : live.beginnerStage;
      // Stage 29 is Graduation, not a lesson: finishing the path goes
      // to the beginner screen, where the graduation card shows.
      if (next >= 29) { showScreen("beginner"); return; }
      startBeginnerStage(next);
      return;
    }
    if (liveDiag) { showScreen("today"); return; }
    // Next tier not done today, else the next Sabaq range.
    var tiers = ["sabaq", "sabqi", "manzil"];
    for (var i = 0; i < tiers.length; i++) {
      var r = tiers[i] === "sabqi" ? sabqiRange() : tiers[i] === "manzil" ? manzilRange() : sabaqRange();
      if (r && !(r.surah === live.surah && r.from === live.from && r.to === live.to) && !tierDoneToday(r)) {
        startLesson(tiers[i]);
        return;
      }
    }
    var surah = getSurah(live.surah);
    var nextFrom = live.to + 1;
    if (surah && nextFrom <= surah.ayahs.length) {
      openLive(live.surah, nextFrom, Math.min(nextFrom + LESSON_LEVELS[lessonLevel].ayahs - 1, surah.ayahs.length), { tier: "sabaq" });
      return;
    }
    var nextSurah = getSurah(live.surah + 1);
    if (nextSurah) {
      openLive(nextSurah.number, 1, Math.min(LESSON_LEVELS[lessonLevel].ayahs, nextSurah.ayahs.length), { tier: "sabaq" });
      return;
    }
    showScreen("today");
  }

  function liveNext() {
    if (!live) { return; }
    if (liveHold && liveHasOpenMistakes()) {
      el("liveHoldNote").hidden = false;
      return;
    }
    if (liveDiag) { tallyLiveAyah(); }
    else { tallyLessonAyah(); }
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
    if (!liveDiag) { tallyLessonAyah(); }
    var result = scoreRecitation(words, heardWords);
    var open = live.words.filter(function (w) { return w.state === "bad"; }).length;
    var heard = liveScore();
    if (!isLast) {
      // Per-ayah Done: the small summary under the stage (unchanged).
      var title = result.score === 100 ? "Beautiful — every word heard"
        : (result.score >= 80 ? "Good work!" : "Almost — a few words to fix");
      el("liveSummaryTitle").textContent = title;
      el("liveSummaryLine").textContent = "Score " + result.score + "% · Heard " + heard + " of " + words.length + " words" +
        (open ? " · " + open + " word" + (open === 1 ? "" : "s") + " to fix" : " · nothing to fix") +
        (result.extras.length ? " · Extra heard: " + result.extras.join(" ") : "");
      el("liveDiagReport").hidden = true;
      el("liveSummaryNextBtn").hidden = false;
      el("liveSummary").hidden = false;
      el("liveSummary").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // Last ayah: the session ends — the recap replaces the stage (v5).
    var st = streakStats(todayStr());
    if (liveDiag) {
      tallyLiveAyah();
      recordDiagnosticCompletion();
      var rep = diagReportText();
      var diagLine = "Mistakes: " + rep.pct + "% · Substituted: " + liveDiagStats.substituted +
        " · Skipped: " + liveDiagStats.skipped + " · Extra: " + liveDiagStats.extra +
        " (" + rep.mistakes + " of " + rep.total + " words)";
      var diagAcc = liveDiagStats.total ? Math.round(liveDiagStats.heard / liveDiagStats.total * 100) : 0;
      // Beginner stage 28 is a diagnostic: pass at >=80% words heard.
      if (live.beginnerStage === 28 && diagAcc >= 80) { passBeginnerStage(28); }
      showRecap({
        title: "Your report", xp: 0, xpExtra: [],
        wordsHeard: liveDiagStats.heard, wordsTotal: liveDiagStats.total,
        fixed: 0, dismissed: 0, openMistakes: [],
        streak: st.current, dueStr: "this was a test — nothing banked",
        diag: diagLine + " · " + placementBandFor(diagAcc).label,
        note: (live.beginnerStage === 28 && diagAcc < 80) ? "Not yet — listen again and try." : null
      });
      return;
    }
    // Finishing the last ayah of a lesson completes the lesson — the
    // Sabqi / Manzil tiers read this. Hifz rule: nothing counts until
    // the session is finished — Done on the last ayah IS the finish, so
    // a half-done lesson (closed or abandoned mid-range) banks nothing,
    // and the guard below means a second Done tap can never bank the
    // same lesson twice.
    var xpBefore = xpTotal();
    if (!live.lessonRecorded) {
      live.lessonRecorded = true;
      recordCompletedLesson(live.surah, live.from, live.to, lessonTotals());
    }
    var xpAfter = xpTotal();
    var xpExtra = [];
    var today = todayStr();
    progressTotals.xpSurahs.forEach(function (e) {
      if (e.surah === live.surah && e.date === today) { xpExtra.push("+500 XP — surah finished"); }
    });
    var seenJuz = {};
    for (var a = live.from; a <= live.to; a++) {
      var jj = juzFor(live.surah, a);
      if (!jj || seenJuz[jj]) { continue; }
      seenJuz[jj] = true;
      progressTotals.xpJuz.forEach(function (e) {
        if (e.juz === jj && e.date === today) { xpExtra.push("+5,000 XP — juz finished"); }
      });
    }
    var totals = lessonTotals();
    var counts = lessonMistakeCounts();
    var rec = sm2[sm2Key(live.surah, live.from, live.to)];
    var dueStr = "tomorrow";
    if (rec && rec.due) {
      dueStr = rec.due === addDaysStr(today, 1) ? "tomorrow" : fmtDueDate(rec.due);
    }
    var pct = totals.total ? Math.round(totals.heard / totals.total * 100) : 0;
    // Beginner stage: fold this range into the chain tally (if any) and
    // evaluate the stage pass at the end of the stage.
    var stageNote = null;
    if (live.beginnerStage) {
      if (live.chainStats) {
        live.chainStats.heard += totals.heard;
        live.chainStats.total += totals.total;
      }
      var isChainEnd = !live.chain || live.chainIdx >= live.chain.ranges.length - 1;
      if (isChainEnd) {
        var acc = live.chainStats
          ? (live.chainStats.total ? Math.round(live.chainStats.heard / live.chainStats.total * 100) : 0)
          : pct;
        if (acc >= 70) { passBeginnerStage(live.beginnerStage); }
        else { stageNote = "Not yet — listen again and try."; }
      }
    }
    showRecap({
      title: pct === 100 ? "Lesson done" : "Lesson done — keep going",
      xp: xpAfter - xpBefore, xpExtra: xpExtra,
      wordsHeard: totals.heard, wordsTotal: totals.total,
      fixed: counts.fixed, dismissed: counts.dismissed, openMistakes: counts.open,
      streak: streakStats(today).current, dueStr: dueStr, diag: null, note: stageNote
    });
  }

  function liveTryAgain() {
    if (!live) { return; }
    // Retry after a finished lesson (recap showing) is a fresh take:
    // the lesson may bank again, exactly as re-opening the range would.
    if (el("recapCard") && !el("recapCard").hidden) {
      hideRecap();
      live.lessonRecorded = false;
    }
    // A word that was wrong gets a real second chance: said right in the
    // new take it shows as fixed, not just good.
    live.words.forEach(function (w) {
      w.state = (w.state === "bad") ? "retry" : "pending";
      w.heard = "";
    });
    // The re-take replaces this ayah's lesson tally (v4c).
    if (live.lessonStats) { delete live.lessonStats.perAyah[live.idx]; }
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
    if (sheetContext === "placement") {
      closeLiveSheet();
      sheetContext = "live";
      placementSheetWord = -1;
      placementWords.forEach(function (w) { if (w.state !== "dismissed") { w.state = "pending"; } });
      renderPlacementPassage();
      togglePlacementMic();
      return;
    }
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
    if (sheetContext === "placement" && placementSheetWord >= 0) {
      var pw = placementWords[placementSheetWord];
      if (pw) { pw.state = "dismissed"; }
      closeLiveSheet();
      sheetContext = "live";
      placementSheetWord = -1;
      renderPlacementPassage();
      var expected = placementExpectedWords();
      var heardWords = placementHeardText.trim() ? placementHeardText.trim().split(/\s+/) : [];
      var r = scoreRecitation(expected, heardWords);
      var heard = 0;
      placementWords.forEach(function (w) { if (w.state === "good" || w.state === "dismissed") { heard++; } });
      var acc = placementWords.length ? Math.round(heard / placementWords.length * 100) : r.score;
      showPlacementResult(acc);
      return;
    }
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

  /* ================= v5: placement front door (spec §3) ============
     First run only: the app listens to Fatiha 1:1–1:4 (13 words) or,
     on "Too hard", Ikhlas 112:1–4 (19 words), and places the student.
     Same Groq ear, same 2.5 s slices, same LCS scoring, no prompt.
     Bands: 90–100% -> memorization from An-Naba 78:1; 70–89% ->
     memorization from Al-Ikhlas 112:1; 50–69% -> beginner Stage 8;
     below 50% -> beginner Stage 1; "I can't read Arabic yet" ->
     beginner Stage 1 with no score. Stored in sabaq-v5-placement. */
  var placement = null; // {passage, accuracy, track, startSurah, startAyah, beginnerStage, date}
  var placementWords = []; // [{text, state, heard}] for the current passage
  var placementHeardText = "";
  var placementListening = false;
  var placementRecorder = null;
  var placementStream = null;
  var placementChunks = [];
  var placementSending = false;
  var placementTakeSeq = 0;
  var placementTimer = null;
  var sheetContext = "live"; // "live" | "placement" — which flow owns the correction sheet

  function placementBandFor(acc) {
    if (acc >= 90) { return { track: "memorization", startSurah: 78, startAyah: 1, beginnerStage: null, label: "Start with Juz 30" }; }
    if (acc >= 70) { return { track: "memorization", startSurah: 112, startAyah: 1, beginnerStage: null, label: "Start with the short surahs" }; }
    if (acc >= 50) { return { track: "beginner", startSurah: 106, startAyah: 1, beginnerStage: 8, label: "Start with simple sentences" }; }
    return { track: "beginner", startSurah: 112, startAyah: 1, beginnerStage: 1, label: "Start from the beginning — the alphabet first" };
  }
  function placementPassageDef() {
    return placement && placement.passage === "ikhlas"
      ? { key: "ikhlas", name: "Ikhlas", surah: 112, from: 1, to: 4, ref: "Al-Ikhlas 112:1–4" }
      : { key: "fatiha", name: "Fatiha", surah: 1, from: 1, to: 4, ref: "Al-Fatiha 1:1–1:4" };
  }
  function placementExpectedWords() {
    var def = placementPassageDef();
    var out = [];
    for (var a = def.from; a <= def.to; a++) {
      var surah = getSurah(def.surah);
      var text = surah && surah.ayahs[a - 1] ? surah.ayahs[a - 1].text : "";
      captionWordsForAyah(def.surah, a, text).forEach(function (w) { out.push(w.text); });
    }
    return out;
  }
  function savePlacement() {
    try {
      if (placement) { localStorage.setItem("sabaq-v5-placement", JSON.stringify(placement)); }
      else { localStorage.removeItem("sabaq-v5-placement"); }
    } catch (e) {}
  }
  function loadPlacement() {
    try {
      var raw = localStorage.getItem("sabaq-v5-placement");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && (saved.track === "memorization" || saved.track === "beginner")) { placement = saved; }
    } catch (e) {}
  }
  function renderPlacementPassage() {
    var box = el("placementPassage");
    var ref = el("placementPassageRef");
    if (!box) { return; }
    var def = placementPassageDef();
    if (ref) { ref.textContent = def.ref; }
    var html = "";
    placementWords.forEach(function (w, i) {
      var cls = "placement-word";
      if (w.state === "good") { cls += " is-good"; }
      else if (w.state === "bad") { cls += " is-bad"; }
      html += '<span class="' + cls + '" data-word="' + i + '" role="button" tabindex="0">' + escHtml(w.text) + "</span>";
    });
    box.innerHTML = html;
    forEach(box.querySelectorAll("[data-word]"), function (sp) {
      sp.addEventListener("click", function () {
        var i = parseInt(sp.getAttribute("data-word"), 10);
        if (placementWords[i] && placementWords[i].state === "bad") { openPlacementSheet(i); }
      });
    });
  }
  function openPlacement() {
    if (!placement) { placement = { passage: "fatiha", accuracy: null, track: null, startSurah: null, startAyah: null, beginnerStage: null, date: null }; }
    if (!placement.passage) { placement.passage = "fatiha"; }
    placementWords = placementExpectedWords().map(function (t) {
      return { text: t, state: "pending", heard: "" };
    });
    placementHeardText = "";
    var res = el("placementResult");
    if (res) { res.hidden = true; }
    setTxt("placementStatus", "");
    el("placementStatus").classList.remove("practice-error");
    el("placementListeningLine").hidden = true;
    setPlacementMicUI(false);
    renderPlacementPassage();
    showScreen("placement");
  }
  function setPlacementMicUI(listening) {
    var b = el("placementMicBtn");
    if (!b) { return; }
    b.classList.toggle("is-listening", listening);
    el("placementMicText").textContent = listening ? "Tap to stop" : "Tap and recite";
    el("placementListeningLine").hidden = !listening;
  }
  function placementError(msg) {
    var st = el("placementStatus");
    st.textContent = msg;
    st.classList.add("practice-error");
  }
  function applyPlacementTranscript(text) {
    placementHeardText = text || "";
    var expected = placementExpectedWords();
    var heardWords = placementHeardText.trim() ? placementHeardText.trim().split(/\s+/) : [];
    var r = scoreRecitation(expected, heardWords);
    var matched = {};
    r.matched.forEach(function (i) { matched[i] = true; });
    placementWords.forEach(function (w, i) {
      if (w.state === "dismissed") { return; }
      w.state = matched[i] ? "good" : "bad";
    });
    renderPlacementPassage();
    showPlacementResult(r.score);
  }
  function showPlacementResult(acc) {
    var def = placementPassageDef();
    var band = placementBandFor(acc);
    placement.accuracy = acc;
    placement.track = band.track;
    placement.startSurah = band.startSurah;
    placement.startAyah = band.startAyah;
    placement.beginnerStage = band.beginnerStage;
    placement.date = todayStr();
    savePlacement();
    var text;
    if (acc >= 90) { text = "You read " + def.name + " at " + acc + "%. Start with Juz 30."; }
    else if (acc >= 70) { text = "You read " + def.name + " at " + acc + "%. Start with the short surahs."; }
    else if (acc >= 50) { text = "You read " + def.name + " at " + acc + "%. Start with simple sentences."; }
    else { text = "Let's start from the beginning — the alphabet first."; }
    el("placementResultText").textContent = text;
    el("placementResult").hidden = false;
    el("placementResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function placementNoRead() {
    stopPlacementListening();
    placement = { passage: "none", accuracy: null, track: "beginner",
                  startSurah: 112, startAyah: 1, beginnerStage: 1, date: todayStr() };
    savePlacement();
    el("placementResultText").textContent = "No problem. We start with the alphabet.";
    el("placementResult").hidden = false;
  }
  function applyPlacement() {
    if (!placement) { return false; }
    if (placement.track === "beginner") {
      if (!beginnerState) { loadBeginner(); }
      beginnerState.currentStage = placement.beginnerStage || 1;
      beginnerState.graduated = false;
      saveBeginner();
      renderBeginnerCard();
    } else if (placement.track === "memorization") {
      setLessonPicker(placement.startSurah || 78, placement.startAyah || 1,
        (placement.startAyah || 1) + LESSON_LEVELS[lessonLevel].ayahs - 1);
    }
    showScreen("today");
    return true;
  }
  function stopPlacementListening() {
    if (placementTimer) { clearTimeout(placementTimer); placementTimer = null; }
    if (placementRecorder && placementRecorder.state !== "inactive") {
      try { placementRecorder.stop(); } catch (e) {}
    }
    placementListening = false;
    setPlacementMicUI(false);
  }
  function sendPlacementSlice(isFinal) {
    if (!placementChunks.length) {
      if (isFinal) { applyPlacementTranscript(""); }
      return;
    }
    if (placementSending) { return; }
    var seq = placementTakeSeq;
    var type = (placementChunks[0] && placementChunks[0].type) || "audio/webm";
    var blob = new Blob(placementChunks, { type: type });
    placementChunks = [];
    if (!blob.size) { if (isFinal) { applyPlacementTranscript(""); } return; }
    placementSending = true;
    var form = new FormData();
    form.append("file", blob, "placement.webm");
    form.append("language", "ar");
    fetch(SABAQ_EAR_URL, { method: "POST", body: form }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (out) {
      placementSending = false;
      if (placementTakeSeq === seq) {
        if (out.ok && out.data && typeof out.data.text === "string") {
          applyPlacementTranscript(out.data.text);
        } else {
          placementError("The ear didn't answer. Try again — your place is saved.");
        }
      }
    }).catch(function () {
      placementSending = false;
      placementError("Listening needs internet. You can still start — tap 'I can't read Arabic yet' and we will place you by hand later.");
    });
  }
  function togglePlacementMic() {
    if (placementListening) { stopPlacementListening(); return; }
    if (!SABAQ_EAR_URL) {
      placementError("Listening needs internet. You can still start — tap 'I can't read Arabic yet' and we will place you by hand later.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      placementError("The mic needs permission. Tap the mic again and allow it — or tap 'I can't read Arabic yet' to skip.");
      return;
    }
    el("placementStatus").classList.remove("practice-error");
    el("placementStatus").textContent = "Getting the mic ready…";
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = "";
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].forEach(function (m) {
        if (!mime && window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) { mime = m; }
      });
      placementChunks = [];
      placementStream = stream;
      try {
        placementRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        placementError("Recording could not start — tap the mic to try again.");
        return;
      }
      placementRecorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) { placementChunks.push(ev.data); sendPlacementSlice(false); }
      };
      placementRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        sendPlacementSlice(true);
      };
      placementRecorder.start(2500);
      placementTakeSeq++;
      placementListening = true;
      setPlacementMicUI(true);
      placementTimer = setTimeout(function () { stopPlacementListening(); }, 30000);
    }).catch(function () {
      placementError("The mic needs permission. Tap the mic again and allow it — or tap 'I can't read Arabic yet' to skip.");
    });
  }
  /* Correction sheet, placement context: Retry re-takes the passage,
     Dismiss marks the word heard and recomputes the result. */
  var placementSheetWord = -1;
  function openPlacementSheet(i) {
    var w = placementWords[i];
    if (!w) { return; }
    sheetContext = "placement";
    placementSheetWord = i;
    liveSheetWord = -1;
    el("liveSheetTitle").textContent = w.text;
    el("liveSheetHeard").textContent = "You said: " + (w.heard ? w.heard : "—");
    el("liveSheetCorrect").textContent = "Correct: " + w.text;
    var info = el("liveSheetWordInfo");
    if (info) { info.hidden = true; }
    el("liveSheetDismiss").style.display = "";
    el("liveSheet").hidden = false;
  }

  /* ================= v5: beginner path — 29 stages, 3 levels (spec §8)
     Passages verified against data/quran.json (see BUILD-NOTE-v5.md):
     no substitutions were needed. Stage 25's six disconnected-letter
     ayahs and stage 9's two passages run as a chain of live ranges;
     stage 28 is a diagnostic (pass at >=80%); all other stages pass
     at >=70% words heard. */
  var BEGINNER_STAGES = [
    { n: 1, name: "Arabic Alphabet", level: 1, surah: 112, from: 1, to: 4 },
    { n: 2, name: "Basic Sounds", level: 1, surah: 108, from: 1, to: 3 },
    { n: 3, name: "Short Vowels", level: 1, surah: 103, from: 1, to: 3 },
    { n: 4, name: "Long Vowels", level: 1, surah: 110, from: 1, to: 3 },
    { n: 5, name: "Tanween", level: 1, surah: 105, from: 1, to: 5 },
    { n: 6, name: "Sukoon", level: 1, surah: 94, from: 1, to: 8 },
    { n: 7, name: "Shaddah", level: 1, surah: 93, from: 1, to: 11 },
    { n: 8, name: "Basic Words", level: 1, surah: 106, from: 1, to: 4 },
    { n: 9, name: "Simple Sentences", level: 1, surah: 103, from: 1, to: 3,
      chain: [{ surah: 103, from: 1, to: 3 }, { surah: 108, from: 1, to: 3 }] },
    { n: 10, name: "Isti'adha", level: 2, surah: 16, from: 98, to: 98 },
    { n: 11, name: "Basmalah Rules", level: 2, surah: 1, from: 1, to: 1 },
    { n: 12, name: "Madd Types", level: 2, surah: 95, from: 1, to: 8 },
    { n: 13, name: "Noon / Meem Sakinah", level: 2, surah: 99, from: 1, to: 8 },
    { n: 14, name: "Laam Rules", level: 2, surah: 91, from: 1, to: 15 },
    { n: 15, name: "Stopping Rules", level: 2, surah: 94, from: 1, to: 8 },
    { n: 16, name: "Waqf Symbols", level: 2, surah: 101, from: 1, to: 11 },
    { n: 17, name: "Joining Verses", level: 2, surah: 102, from: 1, to: 8 },
    { n: 18, name: "Revision Checkpoint", level: 2, surah: 111, from: 1, to: 5 },
    { n: 19, name: "Qalqalah", level: 3, surah: 97, from: 1, to: 5 },
    { n: 20, name: "Tafkheem", level: 3, surah: 85, from: 1, to: 22 },
    { n: 21, name: "Tarqeeq", level: 3, surah: 96, from: 1, to: 19 },
    { n: 22, name: "Ra Rules", level: 3, surah: 100, from: 1, to: 11 },
    { n: 23, name: "Hamzah Types", level: 3, surah: 104, from: 1, to: 9 },
    { n: 24, name: "Advanced Madd", level: 3, surah: 87, from: 1, to: 19 },
    { n: 25, name: "Connected Letters", level: 3, surah: 2, from: 1, to: 1,
      chain: [{ surah: 2, from: 1, to: 1 }, { surah: 3, from: 1, to: 1 },
              { surah: 29, from: 1, to: 1 }, { surah: 30, from: 1, to: 1 },
              { surah: 31, from: 1, to: 1 }, { surah: 32, from: 1, to: 1 }] },
    { n: 26, name: "Full Surah Practice", level: 3, surah: 67, from: 1, to: 30 },
    { n: 27, name: "Tajweed Mastery", level: 3, surah: 89, from: 1, to: 30 },
    { n: 28, name: "Final Assessment", level: 3, surah: 67, from: 1, to: 30 },
    { n: 29, name: "Graduation", level: 3, surah: null, from: null, to: null }
  ];
  var beginnerState = null; // {currentStage, passed[], attempts{}, graduated, graduationSeen}
  function loadBeginner() {
    beginnerState = { currentStage: 1, passed: [], attempts: {}, graduated: false, graduationSeen: false };
    try {
      var raw = localStorage.getItem("sabaq-v5-beginner");
      if (!raw) { return; }
      var saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        if (typeof saved.currentStage === "number" && saved.currentStage >= 1 && saved.currentStage <= 29) {
          beginnerState.currentStage = saved.currentStage;
        }
        if (Array.isArray(saved.passed)) {
          beginnerState.passed = saved.passed.filter(function (n) { return typeof n === "number" && n >= 1 && n <= 28; });
        }
        if (saved.attempts && typeof saved.attempts === "object") { beginnerState.attempts = saved.attempts; }
        if (saved.graduated === true) { beginnerState.graduated = true; }
        if (saved.graduationSeen === true) { beginnerState.graduationSeen = true; }
      }
    } catch (e) {}
  }
  function saveBeginner() {
    try { localStorage.setItem("sabaq-v5-beginner", JSON.stringify(beginnerState)); } catch (e) {}
  }
  function stageUnlocked(n) {
    if (n === 1) { return true; }
    return beginnerState.passed.indexOf(n - 1) >= 0;
  }
  function stagePassageLabel(st) {
    if (!st.surah) { return ""; }
    var surah = getSurah(st.surah);
    var nAy = st.to - st.from + 1;
    return "Practice: " + (surah ? surah.englishName : "") + " " + st.from + "–" + st.to +
      " · " + nAy + " ayah" + (nAy > 1 ? "s" : "");
  }
  function renderBeginnerPath() {
    var box = el("beginnerLevels");
    if (!box || !quranData) { return; }
    if (!beginnerState) { loadBeginner(); }
    var levels = ["Level 1 · Foundation", "Level 2 · Intermediate", "Level 3 · Advanced"];
    var html = "";
    levels.forEach(function (lname, li) {
      html += '<h2 class="beginner-level-title">' + lname + "</h2>";
      BEGINNER_STAGES.forEach(function (st) {
        if (st.level !== li + 1) { return; }
        var passed = beginnerState.passed.indexOf(st.n) >= 0;
        var unlocked = st.n === 29 ? beginnerState.graduated : stageUnlocked(st.n);
        var isCurrent = st.n === beginnerState.currentStage && !passed;
        var cls = "stage-card" + (passed ? " is-passed" : "") + (isCurrent ? " is-current" : "") + (!unlocked ? " is-locked" : "");
        html += '<div class="' + cls + '" data-stage="' + st.n + '">' +
          '<p class="stage-kicker">Stage ' + st.n + '</p>' +
          '<p class="stage-title">Stage ' + st.n + ' · ' + st.name + '</p>' +
          '<p class="stage-sub">' + (st.n === 29 ? "You finished the path." : stagePassageLabel(st)) + '</p>';
        if (st.n === 29) {
          if (beginnerState.graduated && !beginnerState.graduationSeen) {
            // The graduation card below carries the CTA — do not repeat it.
            html += '<span class="stage-state">Passed ✓</span>';
          } else {
            html += '<button class="primary-btn stage-btn" type="button" data-stage-start="29"' + (beginnerState.graduated ? "" : " disabled") + '>Start memorizing →</button>';
          }
        } else if (passed) {
          html += '<span class="stage-state">Passed ✓</span>' +
            '<button class="ghost-btn stage-btn" type="button" data-stage-start="' + st.n + '">Review Stage ' + st.n + ' →</button>';
        } else if (unlocked) {
          html += '<button class="primary-btn stage-btn" type="button" data-stage-start="' + st.n + '">' +
            (isCurrent ? "Continue Stage " + st.n + " →" : "Start Stage " + st.n + " →") + "</button>";
        } else {
          html += '<span class="stage-state">Finish Stage ' + (st.n - 1) + ' first</span>';
        }
        html += "</div>";
      });
    });
    box.innerHTML = html;
    forEach(box.querySelectorAll("[data-stage-start]"), function (b) {
      b.addEventListener("click", function () {
        var n = parseInt(b.getAttribute("data-stage-start"), 10);
        if (n === 29) { applyGraduation(); return; }
        startBeginnerStage(n);
      });
    });
    var grad = el("graduationCard");
    if (grad) { grad.hidden = !(beginnerState.graduated && !beginnerState.graduationSeen); }
  }
  function startBeginnerStage(n) {
    var st = BEGINNER_STAGES[n - 1];
    if (!st || !st.surah) { return false; }
    if (!stageUnlocked(n)) { return false; }
    if (!beginnerState) { loadBeginner(); }
    beginnerState.attempts[n] = (beginnerState.attempts[n] || 0) + 1;
    beginnerState.currentStage = n;
    saveBeginner();
    setCapMode("beginner");
    if (n === 28) {
      var ok = openLive(st.surah, st.from, st.to, { tier: "beginner", beginnerStage: 28, diagnostic: true });
      if (ok) { setCapMode("diagnostic"); }
      return ok;
    }
    if (st.chain) {
      var first = st.chain[0];
      return openLive(first.surah, first.from, first.to,
        { tier: "beginner", beginnerStage: n, chain: { ranges: st.chain }, chainIdx: 0 });
    }
    return openLive(st.surah, st.from, st.to, { tier: "beginner", beginnerStage: n });
  }
  function passBeginnerStage(n) {
    if (!beginnerState) { loadBeginner(); }
    if (beginnerState.passed.indexOf(n) < 0) { beginnerState.passed.push(n); }
    if (n === 28) {
      beginnerState.graduated = true;
      beginnerState.currentStage = 29;
    } else if (beginnerState.currentStage <= n) {
      beginnerState.currentStage = Math.min(n + 1, 29);
    }
    saveBeginner();
    renderBeginnerPath();
    renderBeginnerCard();
  }
  function applyGraduation() {
    if (!beginnerState) { loadBeginner(); }
    beginnerState.graduationSeen = true;
    saveBeginner();
    if (!placement) { placement = { passage: "none", accuracy: null, track: "memorization", startSurah: 78, startAyah: 1, beginnerStage: null, date: todayStr() }; }
    placement.track = "memorization";
    placement.startSurah = 78;
    placement.startAyah = 1;
    placement.beginnerStage = null;
    savePlacement();
    setLessonPicker(78, 1, 5);
    renderBeginnerCard();
    showScreen("today");
  }

  /* ---------- Qira'at (Hafs / Warsh) — one setter for sheet + stage ---------- */
  function setQiraat(q) {
    if (q !== "hafs" && q !== "warsh") { return; }
    state.qiraat = q;
    saveState();
    updatePill();
    syncQiraatToggle();
    var wn = el("warshNote");
    if (wn) { wn.hidden = q !== "warsh"; }
  }
  function syncQiraatToggle() {
    forEach(document.querySelectorAll("[data-qiraat-mini]"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-qiraat-mini") === state.qiraat);
    });
    markSelected("[data-qiraat]", "data-qiraat", state.qiraat || "");
  }

  /* ---------- Wire up (v2 + v3) ---------- */

  function init() {
    loadState();
    loadPrefs();
    loadAccount();
    loadPlacement();
    loadBeginner();
    planKind = "surah"; // v5: the plan picker is gone; the "Choose" sheet picks a surah
    renderAccount();
    wireAudio();

    forEach(document.querySelectorAll("[data-goto]"), function (b) {
      b.addEventListener("click", function () {
        showScreen(b.getAttribute("data-goto"));
      });
    });

    /* --- sheets: click the backdrop to close --- */
    forEach(document.querySelectorAll(".sheet-overlay"), function (ov) {
      ov.addEventListener("click", function (ev) {
        if (ev.target === ov) { ov.hidden = true; }
      });
    });

    /* --- Qira'at: top-bar pill opens the sheet; stage mini-toggle too --- */
    el("qiraatPill").addEventListener("click", function () { openSheet("qiraatSheet"); });
    el("qiraatSheetClose").addEventListener("click", function () { closeSheet("qiraatSheet"); });
    forEach(document.querySelectorAll("[data-qiraat]"), function (b) {
      b.addEventListener("click", function () {
        setQiraat(b.getAttribute("data-qiraat"));
        closeSheet("qiraatSheet");
      });
    });
    forEach(document.querySelectorAll("[data-qiraat-mini]"), function (b) {
      b.addEventListener("click", function () { setQiraat(b.getAttribute("data-qiraat-mini")); });
    });

    /* --- intro + placement front door --- */
    el("introGuestBtn").addEventListener("click", function () {
      continueAsGuest();
      if (placement && placement.track) { showScreen("today"); }
      else { openPlacement(); }
    });
    el("placementMicBtn").addEventListener("click", togglePlacementMic);
    el("placementShorterBtn").addEventListener("click", function () {
      if (!placement) { placement = { passage: "fatiha" }; }
      placement.passage = "ikhlas";
      placementWords = placementExpectedWords().map(function (t) {
        return { text: t, state: "pending", heard: "" };
      });
      placementHeardText = "";
      el("placementResult").hidden = true;
      setTxt("placementStatus", "");
      renderPlacementPassage();
    });
    el("placementNoReadBtn").addEventListener("click", placementNoRead);
    el("placementStartBtn").addEventListener("click", applyPlacement);

    /* --- Today --- */
    el("tierSabaqStart").addEventListener("click", function () { startLesson("sabaq"); });
    el("tierSabqiStart").addEventListener("click", function () { startLesson("sabqi"); });
    el("tierManzilStart").addEventListener("click", function () { startLesson("manzil"); });
    el("lessonDiagnosticBtn").addEventListener("click", lessonDiagnostic);
    el("timeMinus").addEventListener("click", function () { cycleTime(-1); });
    el("timePlus").addEventListener("click", function () { cycleTime(1); });
    el("chooseLink").addEventListener("click", function () { openSheet("chooseSheet"); });
    el("chooseSheetClose").addEventListener("click", function () { closeSheet("chooseSheet"); });
    el("chooseApplyBtn").addEventListener("click", function () {
      var surahNum = parseInt(el("lessonSurahSelect").value, 10) || 1;
      var from = parseInt(el("lessonFrom").value, 10) || 1;
      var to = parseInt(el("lessonTo").value, 10) || from;
      setLessonPicker(surahNum, from, to);
      closeSheet("chooseSheet");
    });
    el("beginnerCardBtn").addEventListener("click", function () {
      if (beginnerState) { startBeginnerStage(beginnerState.currentStage); }
    });
    el("beginnerPathLink").addEventListener("click", function () { showScreen("beginner"); });
    el("dueReviewBtn").addEventListener("click", function () {
      var due = getDueItems(todayStr());
      if (due.length) { startDueReview(sm2Key(due[0].surah, due[0].from, due[0].to)); }
    });
    forEach(document.querySelectorAll("[data-level]"), function (b) {
      b.addEventListener("click", function () { setLessonLevel(b.getAttribute("data-level")); });
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
      if (surah) {
        el("lessonTo").value = Math.min(from + LESSON_LEVELS[lessonLevel].ayahs - 1, surah.ayahs.length);
      }
      renderLesson();
    });
    el("lessonTo").addEventListener("change", function () { renderLesson(); });

    /* --- Mushaf --- */
    el("surahSearch").addEventListener("input", function () {
      renderSurahList(el("surahSearch").value);
    });
    el("reciterSearch").addEventListener("input", function () {
      renderReciterList(el("reciterSearch").value);
    });
    el("toolbarPlay").addEventListener("click", function () {
      if (player.playing) {
        pauseAudio();
        el("toolbarPlay").textContent = "\u25B6 Play";
      } else if (player.ayahIndex >= 0 && player.surah === state.currentSurah) {
        playAyah(player.surah, player.ayahIndex, { continuous: true, fallbackReciterId: player.fallbackReciterId });
        el("toolbarPlay").textContent = "\u23F8 Pause";
      } else {
        playAyah(state.currentSurah, 0, { continuous: true });
        el("toolbarPlay").textContent = "\u23F8 Pause";
      }
    });
    el("toolbarReciter").addEventListener("click", function () { openSheet("reciterSheet"); });
    el("toolbarFont").addEventListener("click", cycleReadFont);
    el("toolbarSettings").addEventListener("click", function () { openSheet("readSettingsSheet"); });
    el("reciterSheetClose").addEventListener("click", function () { closeSheet("reciterSheet"); });
    el("readSettingsClose").addEventListener("click", function () { closeSheet("readSettingsSheet"); });
    el("settingsReciterBtn").addEventListener("click", function () {
      closeSheet("readSettingsSheet");
      openSheet("reciterSheet");
    });
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
    el("learnThisSurahBtn").addEventListener("click", function () {
      setLessonPicker(state.currentSurah, 1, LESSON_LEVELS[lessonLevel].ayahs);
      showScreen("today");
    });
    el("wordSheetClose").addEventListener("click", function () { closeSheet("wordSheet"); });
    el("wordSheetPractice").addEventListener("click", function () {
      if (!wordSheetAyah) { return; }
      closeSheet("wordSheet");
      openLive(wordSheetAyah.surah, wordSheetAyah.ayah, wordSheetAyah.ayah, { returnTo: "read" });
      setCapMode("beginner");
    });

    /* --- Progress --- */
    el("retakePlacementBtn").addEventListener("click", openPlacement);
    el("progressClearFixBtn").addEventListener("click", function () {
      liveMistakes = [];
      saveLiveMistakes();
      renderLiveHistory();
    });
    el("graduationStartBtn").addEventListener("click", applyGraduation);

    /* --- live feedback mode --- */
    el("liveFeedbackBtn").addEventListener("click", function () {
      var surah = getSurah(state.currentSurah);
      setCapMode("beginner");
      openLive(state.currentSurah, 1, Math.min(5, surah ? surah.ayahs.length : 5), { returnTo: "read" });
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
    el("liveChangeSurah").addEventListener("click", function () { showScreen("mushaf"); });
    el("liveHoldToggle").addEventListener("click", function () { setLiveHold(!liveHold); });
    el("liveCloseX").addEventListener("click", closeLive);
    el("recapNextBtn").addEventListener("click", nextLessonAfterRecap);
    el("recapBackBtn").addEventListener("click", function () {
      stopLiveListening();
      showScreen("today");
    });
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

    /* --- v4: captions / lesson / progress stores --- */
    loadCapPrefs();
    loadLessonLevel();
    loadCompletedLessons();
    loadSM2();
    loadStreakDays();
    loadLessonLog();
    loadTotals();
    loadJuzCoverage();
    loadSurahCoverage();
    setCapMode(capMode);
    setCapFont(capFont);
    if (state.qiraat) { syncQiraatToggle(); }
    updatePill();
    updateSplit();
    forEach(document.querySelectorAll("[data-capmode]"), function (b) {
      b.addEventListener("click", function () { setCapMode(b.getAttribute("data-capmode")); });
    });
    forEach(document.querySelectorAll("[data-capfont]"), function (b) {
      b.addEventListener("click", function () { setCapFont(b.getAttribute("data-capfont")); });
    });
    el("liveTeacherBtn").addEventListener("click", playTeacher);

    // Returning user (placement stored) skips the front door (spec 2).
    if (placement && placement.track) { showScreen("today"); }
    else { showScreen("intro"); animateBasmala(); }
    loadData();
  }

  /* Test hook (used by the headless verification only). */
  window.SabaqTest = {
    normalizeArabic: normalizeArabic,
    scoreRecitation: scoreRecitation,
    bank: VERSE_BANK,
    // Groq ear hooks (test-only; the key never lives in the app)
    groqConfigured: function () { return !!SABAQ_EAR_URL; },
    groqAvailable: groqAvailable,
    whichEarWouldUse: function () { return groqAvailable() ? EAR_GROQ : EAR_BROWSER; },
    getEarInUse: function () { return earInUse; },
    setEarUrl: function (url) { SABAQ_EAR_URL = url || ""; },
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
    openSurahs: function () { showScreen("mushaf"); },
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
    setChosenSurah: function (num) {
      var surah = getSurah(num);
      if (!surah) { return false; }
      state.chosenSurah = num;
      saveState();
      return setLessonPicker(num, 1, LESSON_LEVELS[lessonLevel].ayahs);
    },
    getTaskTitles: function () {
      return {
        sabaq: el("tierSabaqTitle") ? el("tierSabaqTitle").textContent : "",
        sabqi: el("tierSabqiTitle") ? el("tierSabqiTitle").textContent : "",
        manzil: el("tierManzilTitle") ? el("tierManzilTitle").textContent : ""
      };
    },
    openJuz: openJuz,
    getJuzStart: function (n) { return juzStarts[n] || null; },
    getViewportMeta: function () {
      var m = document.querySelector('meta[name="viewport"]');
      return m ? m.getAttribute("content") : "";
    },
    getLiveState: function () {
      if (!live) { return null; }
      return {
        surah: live.surah, from: live.from, to: live.to, idx: live.idx,
        ayahRef: live.ayahs[live.idx].ref, total: live.ayahs.length,
        listening: liveListening, hold: liveHold, tier: live.tier,
        beginnerStage: live.beginnerStage || null
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
    // v4c hooks: SM-2, streak, badges, analytics, XP, quest (test-only).
    setToday: function (d) { testToday = d || null; },
    clearToday: function () { testToday = null; },
    getToday: function () { return todayStr(); },
    gradeForAccuracy: gradeForAccuracy,
    getSM2: function () {
      return Object.keys(sm2).map(function (k) { return sm2[k]; });
    },
    seedSM2: function (list) {
      sm2 = {};
      (list || []).forEach(function (r) {
        if (r && typeof r.surah === "number" && typeof r.from === "number") {
          sm2[sm2Key(r.surah, r.from, r.to)] = {
            surah: r.surah, from: r.from, to: r.to,
            ef: typeof r.ef === "number" ? r.ef : 2.5,
            interval: r.interval || 0, reps: r.reps || 0,
            due: r.due || todayStr(), grade: r.grade || null, ts: r.ts || 0
          };
        }
      });
      saveSM2();
      renderLesson();
    },
    clearSM2: function () { sm2 = {}; saveSM2(); renderLesson(); },
    getStreak: function () { return streakStats(todayStr()); },
    getWeekDots: function () { return weekDots(todayStr()); },
    seedDays: function (days) {
      streakDays = (days || []).slice().sort();
      saveStreakDays();
      renderStreakCard();
    },
    getDays: function () { return streakDays.slice(); },
    getBadges: computeBadges,
    getAnalytics: weeklyAnalytics,
    getDueItems: function () { return getDueItems(todayStr()); },
    getNextDueDate: function () { return getNextDueDate(todayStr()); },
    getLessonLog: function () { return lessonLog.slice(); },
    seedLessonLog: function (list) {
      lessonLog = (list || []).slice(0, 100);
      saveLessonLog();
      renderLesson();
    },
    getTotals: function () {
      return { wordsHeard: progressTotals.wordsHeard, lessons: progressTotals.lessons,
               diagnostics: progressTotals.diagnostics.slice(),
               xpSurahs: progressTotals.xpSurahs.slice(),
               xpJuz: progressTotals.xpJuz.slice() };
    },
    seedTotals: function (t) {
      progressTotals = {
        wordsHeard: (t && t.wordsHeard) || 0,
        lessons: (t && t.lessons) || 0,
        diagnostics: (t && t.diagnostics) || [],
        xpSurahs: (t && t.xpSurahs) || [],
        xpJuz: (t && t.xpJuz) || []
      };
      saveTotals();
      renderLesson();
    },
    getXp: function () { return { total: xpTotal(), level: levelFor(xpTotal()) }; },
    getQuest: function () { return questStatus(todayStr()); },
    getJuzCoverage: function () { return juzCoverage; },
    getSurahCoverage: function () { return surahCoverage; },
    seedCoverage: function (juzMap, surahMap) {
      juzCoverage = juzMap || {};
      surahCoverage = surahMap || {};
      saveJuzCoverage();
      saveSurahCoverage();
      renderLesson();
    },
    getJuzAyahRefs: function (j) {
      var out = [];
      if (!quranData) { return out; }
      quranData.surahs.forEach(function (s) {
        s.ayahs.forEach(function (a) { if (a.juz === j) { out.push(s.number + ":" + a.numberInSurah); } });
      });
      return out;
    },
    startDueReview: startDueReview,
    clearAllProgress: function () {
      sm2 = {}; saveSM2();
      streakDays = []; saveStreakDays();
      lessonLog = []; saveLessonLog();
      progressTotals = { wordsHeard: 0, lessons: 0, diagnostics: [], xpSurahs: [], xpJuz: [] };
      saveTotals();
      juzCoverage = {}; saveJuzCoverage();
      surahCoverage = {}; saveSurahCoverage();
      completedLessons = []; saveCompletedLessons();
      testToday = null;
      renderLesson();
      renderStreakCard();
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
    // v5 hooks: placement, beginner path, recap, Progress, Mushaf flow.
    getPlacement: function () { return placement ? JSON.parse(JSON.stringify(placement)) : null; },
    openPlacement: openPlacement,
    applyPlacementTranscript: applyPlacementTranscript,
    getPlacementWords: function () {
      return placementWords.map(function (w) { return { text: w.text, state: w.state }; });
    },
    setPlacementPassage: function (key) {
      if (!placement) { placement = { passage: "fatiha" }; }
      placement.passage = key === "ikhlas" ? "ikhlas" : "fatiha";
      placementWords = placementExpectedWords().map(function (t) {
        return { text: t, state: "pending", heard: "" };
      });
      renderPlacementPassage();
    },
    placementNoRead: placementNoRead,
    applyPlacement: applyPlacement,
    placementBandFor: placementBandFor,
    getBeginner: function () { return beginnerState ? JSON.parse(JSON.stringify(beginnerState)) : null; },
    getBeginnerStages: function () { return BEGINNER_STAGES; },
    startBeginnerStage: startBeginnerStage,
    passBeginnerStage: passBeginnerStage,
    applyGraduation: applyGraduation,
    getRecap: function () {
      var c = el("recapCard");
      var fix = [];
      forEach(document.querySelectorAll("#recapFixList .live-mistake"), function (n) {
        fix.push(n.textContent);
      });
      return {
        hidden: c ? c.hidden : true,
        visible: c ? !c.hidden : false,
        fixList: fix,
        title: el("recapTitle") ? el("recapTitle").textContent : "",
        xp: el("recapXp") ? el("recapXp").textContent : "",
        xpExtra: el("recapXpExtra") ? el("recapXpExtra").textContent : "",
        words: el("recapWords") ? el("recapWords").textContent : "",
        mistakes: el("recapMistakes") ? el("recapMistakes").textContent : "",
        streak: el("recapStreak") ? el("recapStreak").textContent : "",
        due: el("recapDue") ? el("recapDue").textContent : "",
        diagHidden: el("recapDiagReport") ? el("recapDiagReport").hidden : true,
        diagLine: el("recapDiagLine") ? el("recapDiagLine").textContent : "",
        note: el("recapNote") ? el("recapNote").textContent : ""
      };
    },
    closeLive: closeLive,
    nextLessonAfterRecap: nextLessonAfterRecap,
    getParentView: function () { return el("parentBody") ? el("parentBody").textContent : ""; },
    getWeekChart: function () {
      var out = [];
      forEach(document.querySelectorAll("#weekChart .week-bar"), function (b) {
        out.push({ h: b.style.height, title: b.getAttribute("title") });
      });
      return out;
    },
    getJuzTile: function (n) {
      var t = document.querySelector('.juz-tile[data-juz="' + n + '"]');
      if (!t) { return null; }
      return { cls: t.className, fill: t.getAttribute("data-fill"), text: t.textContent };
    },
    getJuzMapLine: function () { return el("juzMapLine") ? el("juzMapLine").textContent : ""; },
    openWordSheet: openWordSheet,
    getWordSheet: function () {
      return {
        hidden: el("wordSheet") ? el("wordSheet").hidden : true,
        ar: el("wordSheetAr") ? el("wordSheetAr").textContent : "",
        gloss: el("wordSheetGloss") ? el("wordSheetGloss").textContent : "",
        pills: el("wordSheetPills") ? el("wordSheetPills").textContent : ""
      };
    },
    getFlowAyahs: function () {
      var out = [];
      forEach(document.querySelectorAll(".flow-ayah"), function (a) {
        out.push({ ayah: a.getAttribute("data-ayah"), text: a.textContent });
      });
      return out;
    },
    getBismillahState: function () {
      var b = el("readBismillah");
      var first = document.querySelector(".flow-ayah");
      return {
        bismillahHidden: b ? b.hidden : null,
        firstAyahText: first ? first.textContent : ""
      };
    },
    setQiraat: setQiraat,
    getQiraat: function () { return state.qiraat; },
    getReadFont: function () { return readFont; },
    cycleReadFont: cycleReadFont,
    renderToday: renderToday,
    renderProgress: renderProgress,
    getTierState: function () {
      return {
        sabaq: { title: el("tierSabaqTitle").textContent, sub: el("tierSabaqSub").textContent,
                 disabled: el("tierSabaqStart").disabled, hidden: el("tierSabaqStart").hidden },
        sabqi: { title: el("tierSabqiTitle").textContent, sub: el("tierSabqiSub").textContent,
                 disabled: el("tierSabqiStart").disabled, hidden: el("tierSabqiStart").hidden },
        manzil: { title: el("tierManzilTitle").textContent, sub: el("tierManzilSub").textContent,
                  disabled: el("tierManzilStart").disabled, hidden: el("tierManzilStart").hidden }
      };
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
