(function () {
  // ---------- Tabs ----------
  let classListInterval = null;
  document.querySelectorAll('nav.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

      if (btn.dataset.tab === 'classlist') {
        refreshClassList();
        if (classListInterval) clearInterval(classListInterval);
        classListInterval = setInterval(refreshClassList, 6000);
      } else if (classListInterval) {
        clearInterval(classListInterval);
        classListInterval = null;
      }
    });
  });

  // ---------- App state ----------
  const state = {
    examId: null,
    examSubjectId: null,
    templateCfg: null,
    questionCount: 60,
    img: null,
    orientCanvas: null,
    corners: [],
    warped: null,
    bubbleMap: [],
    detections: [],
    learnerId: null,
    learnerKnown: false,
    cardId: null,
    batchQueue: [],
    batchIndex: 0,
    subjectTemplateMap: {} // examSubjectId -> template key, kept client-side
  };

  // ---------- Session persistence ----------
  const PERSIST_KEY = 'omr_session_v2';

  function persistSession() {
    const toSave = {
      examId: state.examId,
      examSubjectId: state.examSubjectId,
      questionCount: state.questionCount,
      templateCfg: state.templateCfg,
      subjectTemplateMap: state.subjectTemplateMap,
      examIdField: val('examId'), examNameField: val('examName'), examGradeField: val('examGrade'),
      subjectIdField: val('subjectId'), templateSelectField: val('templateSelect'),
      qCountField: val('qCount'), marksPerQField: val('marksPerQ'),
      keyInputField: val('keyInput'), learnerIdField: val('learnerIdInput')
    };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(toSave));
  }
  function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
  function setVal(id, v) { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; }

  function restoreSession() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || 'null'); } catch { saved = null; }
    if (!saved) return;
    state.examId = saved.examId || null;
    state.examSubjectId = saved.examSubjectId || null;
    state.questionCount = saved.questionCount || 60;
    state.templateCfg = saved.templateCfg || state.templateCfg;
    state.subjectTemplateMap = saved.subjectTemplateMap || {};

    setVal('examId', saved.examIdField); setVal('examName', saved.examNameField); setVal('examGrade', saved.examGradeField);
    setVal('subjectId', saved.subjectIdField); setVal('templateSelect', saved.templateSelectField);
    setVal('qCount', saved.qCountField); setVal('marksPerQ', saved.marksPerQField);
    setVal('keyInput', saved.keyInputField); setVal('learnerIdInput', saved.learnerIdField);

    if (state.examSubjectId) document.getElementById('currentExamSubjectId').textContent = state.examSubjectId;
    if (state.examId) refreshActiveSubjectSelect();
  }

  document.querySelectorAll('#tab-setup input, #tab-setup select, #tab-key textarea')
    .forEach(el => el.addEventListener('change', persistSession));

  // ---------- API config ----------
  if (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.APPS_SCRIPT_URL && !APP_CONFIG.APPS_SCRIPT_URL.startsWith('PASTE_')) {
    ApiClient.configure(APP_CONFIG.APPS_SCRIPT_URL);
    document.getElementById('apiStatus').innerHTML = '<span class="status-ok">Connected</span>';
    document.getElementById('apiStatusPill').classList.add('ok');
  } else {
    document.getElementById('apiStatus').innerHTML =
      '<span class="status-bad">Not configured — admin must set APPS_SCRIPT_URL in js/config.js</span>';
    document.getElementById('apiStatusPill').classList.add('bad');
  }

  // ---------- Exam ----------
  document.getElementById('createExamBtn').addEventListener('click', async () => {
    const examId = val('examId').trim(), name = val('examName').trim(), grade = val('examGrade').trim();
    if (!examId) return setStatus('examStatus', 'Exam ID is required', false);
    const res = await ApiClient.call('createExam', { examId, name, grade });
    state.examId = examId;
    setStatus('examStatus', res.queued ? 'Saved offline — will sync' : `Exam saved: ${res.examId}`, true);
    persistSession();
    refreshActiveSubjectSelect();
  });

  // ---------- Exam Subject ----------
  document.getElementById('templateSelect').addEventListener('change', () => applyTemplateDefaults(false));
  restoreSession();
  applyTemplateDefaults(true);

  function applyTemplateDefaults(preserveQCount) {
    const key = val('templateSelect') || 'ECZ_60';
    const tmpl = OMREngine.TEMPLATES[key];
    if (!preserveQCount) setVal('qCount', tmpl.questionCount);
    const merged = JSON.parse(JSON.stringify(tmpl));
    merged.questionCount = parseInt(val('qCount'), 10) || tmpl.questionCount;
    state.templateCfg = merged;
    persistSession();
  }

  document.getElementById('saveExamSubjectBtn').addEventListener('click', async () => {
    if (!state.examId) return setStatus('examSubjectStatus', 'Save the exam first', false);
    const subjectId = val('subjectId').trim();
    const questionCount = parseInt(val('qCount'), 10);
    const marksPerQuestion = parseInt(val('marksPerQ'), 10) || 1;
    const templateKey = val('templateSelect') || 'ECZ_60';
    if (!subjectId) return setStatus('examSubjectStatus', 'Subject ID is required', false);

    state.templateCfg.questionCount = questionCount;
    state.questionCount = questionCount;
    const examSubjectId = `${state.examId}_${subjectId}`;

    const res = await ApiClient.call('saveExamSubject', {
      examSubjectId, examId: state.examId, subjectId, questionCount, marksPerQuestion,
      answerOptions: state.templateCfg.optionLabels.join(',')
    });
    state.examSubjectId = examSubjectId;
    state.subjectTemplateMap[examSubjectId] = templateKey;
    document.getElementById('currentExamSubjectId').textContent = examSubjectId;
    setStatus('examSubjectStatus', res.queued ? 'Saved offline — will sync' : 'Exam subject saved', true);
    buildCalibFields();
    persistSession();
    refreshActiveSubjectSelect();
  });

  // ---------- Active subject selector (Marking Key tab) ----------
  async function refreshActiveSubjectSelect() {
    const sel = document.getElementById('activeSubjectSelect');
    if (!state.examId) { sel.innerHTML = '<option>Save an exam first</option>'; return; }
    const res = await ApiClient.call('getExam', { examId: state.examId }, { noQueue: true }).catch(() => null);
    if (!res || !res.examSubjects) { sel.innerHTML = '<option>Could not load subjects</option>'; return; }
    sel.innerHTML = res.examSubjects.map(es =>
      `<option value="${es.examSubjectId}" data-qcount="${es.questionCount}" ${es.examSubjectId === state.examSubjectId ? 'selected' : ''}>${es.subjectId} (${es.questionCount}Q)</option>`
    ).join('');
    updateActiveSubjectStatus();
  }
  document.getElementById('activeSubjectSelect').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt) return;
    state.examSubjectId = opt.value;
    state.questionCount = parseInt(opt.dataset.qcount, 10);
    const tmplKey = state.subjectTemplateMap[state.examSubjectId] || 'ECZ_60';
    const tmpl = JSON.parse(JSON.stringify(OMREngine.TEMPLATES[tmplKey]));
    tmpl.questionCount = state.questionCount;
    state.templateCfg = tmpl;
    document.getElementById('currentExamSubjectId').textContent = state.examSubjectId;
    updateActiveSubjectStatus();
    buildCalibFields();
    persistSession();
  });
  function updateActiveSubjectStatus() {
    document.getElementById('activeSubjectStatus').innerHTML = state.examSubjectId
      ? `<span class="status-ok">Scanning will save against: ${state.examSubjectId}</span>`
      : '<span class="status-bad">No active subject selected</span>';
  }

  // ---------- Marking Key (multi-subject batch) ----------
  function parseMultiKeyInput(text) {
    const blocks = {};
    let current = null;
    text.split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('###')) {
        current = line.replace(/^###\s*/, '').trim();
        blocks[current] = [];
        return;
      }
      if (!current) return;
      const [qStr, opt] = line.split(',').map(s => s.trim());
      const q = parseInt(qStr, 10);
      if (q && opt) blocks[current].push({ questionNo: q, correctOption: opt.toUpperCase() });
    });
    return blocks;
  }

  document.getElementById('validateKeyBtn').addEventListener('click', async () => {
    if (!state.examId) return setStatus('keyStatus', 'Save an exam first', false);
    const blocks = parseMultiKeyInput(val('keyInput'));
    const examInfo = await ApiClient.call('getExam', { examId: state.examId }, { noQueue: true }).catch(() => null);
    if (!examInfo) return setStatus('keyStatus', 'Could not reach server to validate', false);
    const msgs = [];
    Object.entries(blocks).forEach(([subjectId, keys]) => {
      const es = examInfo.examSubjects.find(x => x.subjectId === subjectId);
      if (!es) { msgs.push(`${subjectId}: no matching exam subject — save it in Setup first`); return; }
      const result = MarkingEngine.validateMarkingKey(Number(es.questionCount), keys, (es.answerOptions || 'A,B,C,D').split(','));
      msgs.push(result.valid ? `${subjectId}: valid ✓` : `${subjectId}: ${result.errors[0]}`);
    });
    setStatus('keyStatus', msgs.join(' | ') || 'No ### subject blocks found', true);
  });

  document.getElementById('saveKeyBtn').addEventListener('click', async () => {
    if (!state.examId) return setStatus('keyStatus', 'Save an exam first', false);
    const blocks = parseMultiKeyInput(val('keyInput'));
    const examInfo = await ApiClient.call('getExam', { examId: state.examId }, { noQueue: true }).catch(() => null);
    if (!examInfo) return setStatus('keyStatus', 'Could not reach server', false);

    const results = [];
    for (const [subjectId, keys] of Object.entries(blocks)) {
      const es = examInfo.examSubjects.find(x => x.subjectId === subjectId);
      if (!es) { results.push(`${subjectId}: skipped (no exam subject)`); continue; }
      const saveRes = await ApiClient.call('saveMarkingKeyBatch', { examSubjectId: es.examSubjectId, keys });
      if (saveRes.error) { results.push(`${subjectId}: ${saveRes.error}`); continue; }
      const lockRes = await ApiClient.call('lockKey', { examSubjectId: es.examSubjectId, version: saveRes.version || 1 });
      results.push(`${subjectId}: saved + locked`);
    }
    setStatus('keyStatus', results.join(' | '), true);
    refreshActiveSubjectSelect();
    persistSession();
  });

  // ---------- Calibration fields ----------
  function buildCalibFields() {
    const wrap = document.getElementById('calibFields');
    const cfg = state.templateCfg;
    if (!cfg) return;
    if (cfg.layout === 'column-major-blocks') {
      wrap.innerHTML = fieldHtml('topMarginPct','Top %',cfg.topMarginPct)
        + fieldHtml('bottomMarginPct','Bottom %',cfg.bottomMarginPct)
        + fieldHtml('leftMarginPct','Left %',cfg.leftMarginPct)
        + fieldHtml('rightMarginPct','Right %',cfg.rightMarginPct)
        + fieldHtml('blockGapPct','Block gap %',cfg.blockGapPct)
        + fieldHtml('headerFracOfBlock','Header frac',cfg.headerFracOfBlock,0.01)
        + fieldHtml('blocks','Blocks',cfg.blocks)
        + fieldHtml('questionsPerBlock','Q per block',cfg.questionsPerBlock);
    } else {
      wrap.innerHTML = fieldHtml('topMarginPct','Top %',cfg.topMarginPct)
        + fieldHtml('bottomMarginPct','Bottom %',cfg.bottomMarginPct)
        + fieldHtml('leftMarginPct','Left %',cfg.leftMarginPct)
        + fieldHtml('rightMarginPct','Right %',cfg.rightMarginPct)
        + fieldHtml('columns','Columns',cfg.columns);
    }
    wrap.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => { state.templateCfg[inp.dataset.key] = parseFloat(inp.value); });
    });
  }
  function fieldHtml(key,label,val,step=1){
    return `<div><label>${label}</label><input type="number" step="${step}" data-key="${key}" value="${val}"></div>`;
  }

  // ---------- Learner lookup ----------
  const learnerIdInput = document.getElementById('learnerIdInput');
  const learnerNameWrap = document.getElementById('learnerNameWrap');
  const learnerNameInput = document.getElementById('learnerNameInput');

  learnerIdInput.addEventListener('change', lookupLearner);
  async function lookupLearner() {
    const id = learnerIdInput.value.trim();
    state.learnerId = id;
    if (!id) { learnerNameWrap.style.display = 'none'; return; }
    learnerNameWrap.style.display = 'block';
    document.getElementById('learnerLookupStatus').textContent = 'Looking up…';
    const res = await ApiClient.call('getLearnerById', { learnerId: id }, { noQueue: true }).catch(() => null);
    if (res && res.found) {
      learnerNameInput.value = res.learner.name;
      state.learnerKnown = true;
      document.getElementById('learnerLookupStatus').innerHTML = '<span class="status-ok">Known learner — name auto-filled</span>';
    } else {
      learnerNameInput.value = '';
      state.learnerKnown = false;
      document.getElementById('learnerLookupStatus').innerHTML =
        '<span class="status-bad">New learner — type their name, it will be registered when you save</span>';
    }
    persistSession();
  }

  // ---------- File input → batch queue ----------
  const cameraInput = document.getElementById('cameraInput');
  const galleryInput = document.getElementById('galleryInput');
  const pdfInput = document.getElementById('pdfInput');

  document.getElementById('takePhotoBtn').addEventListener('click', () => cameraInput.click());
  document.getElementById('chooseGalleryBtn').addEventListener('click', () => galleryInput.click());
  document.getElementById('choosePdfBtn').addEventListener('click', () => pdfInput.click());

  cameraInput.addEventListener('change', async (e) => {
    const urls = await filesToDataUrls(Array.from(e.target.files));
    startBatch(urls);
    e.target.value = '';
  });
  galleryInput.addEventListener('change', async (e) => {
    const urls = await filesToDataUrls(Array.from(e.target.files));
    startBatch(urls);
    e.target.value = '';
  });
  pdfInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    document.getElementById('batchStatus').textContent = 'Converting PDF pages…';
    const urls = await pdfToDataUrls(f);
    startBatch(urls);
    e.target.value = '';
  });

  function filesToDataUrls(files) {
    return Promise.all(files.map(f => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    })));
  }

  async function pdfToDataUrls(file) {
    if (typeof pdfjsLib === 'undefined') {
      setStatus('batchStatus', 'PDF library failed to load — check internet connection', false);
      return [];
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const urls = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      urls.push(canvas.toDataURL('image/jpeg', 0.92));
    }
    return urls;
  }

  function startBatch(dataUrls) {
    if (!dataUrls.length) return;
    state.batchQueue = dataUrls;
    state.batchIndex = 0;
    updateBatchStatus();
    loadCurrentBatchItem();
  }
  function updateBatchStatus() {
    const el = document.getElementById('batchStatus');
    if (state.batchQueue.length <= 1) { el.textContent = ''; return; }
    el.textContent = `Card ${state.batchIndex + 1} of ${state.batchQueue.length} in batch`;
  }
  function loadCurrentBatchItem() {
    const url = state.batchQueue[state.batchIndex];
    const img = new Image();
    img.onload = () => startOrientationStep(img);
    img.src = url;
  }

  document.getElementById('nextInBatchBtn').addEventListener('click', () => {
    state.batchIndex++;
    if (state.batchIndex >= state.batchQueue.length) {
      document.getElementById('batchStatus').textContent = 'Batch complete.';
      state.batchQueue = []; state.batchIndex = 0;
      return;
    }
    learnerIdInput.value = '';
    learnerNameInput.value = '';
    learnerNameWrap.style.display = 'none';
    document.getElementById('scanResultsCard').style.display = 'none';
    updateBatchStatus();
    loadCurrentBatchItem();
  });

  // ---------- Orientation ----------
  function startOrientationStep(img) {
    state.img = img;
    const guess = OMREngine.detectOrientation(img);
    document.getElementById('orientGuess').textContent =
      `Photo ratio ${guess.ratio.toFixed(2)} — ${guess.guess === 'none' ? 'looks upright' : 'looks rotated, auto-rotating'}`;
    const degrees = guess.guess === 'rotate90' ? 270 : 0;
    state.orientCanvas = degrees ? OMREngine.rotateImageToCanvas(img, degrees) : imgToCanvas(img);
    renderOrientPreview();
    document.getElementById('orientCard').style.display = 'block';
    document.getElementById('alignCard').style.display = 'none';
    document.getElementById('calibCard').style.display = 'none';
    document.getElementById('scanResultsCard').style.display = 'none';
    document.getElementById('nextInBatchBtn').style.display = 'none';
    document.getElementById('orientCard').scrollIntoView({ behavior: 'smooth' });
  }
  function imgToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }
  function renderOrientPreview() {
    const cv = document.getElementById('orientCanvas');
    const maxW = Math.min(window.innerWidth - 40, 700);
    const scale = Math.min(1, maxW / state.orientCanvas.width);
    cv.width = state.orientCanvas.width * scale;
    cv.height = state.orientCanvas.height * scale;
    cv.getContext('2d').drawImage(state.orientCanvas, 0, 0, cv.width, cv.height);
  }
  document.getElementById('rotateLeftBtn').addEventListener('click', () => {
    state.orientCanvas = OMREngine.rotateImageToCanvas(state.orientCanvas, 270);
    renderOrientPreview();
  });
  document.getElementById('rotateRightBtn').addEventListener('click', () => {
    state.orientCanvas = OMREngine.rotateImageToCanvas(state.orientCanvas, 90);
    renderOrientPreview();
  });
  document.getElementById('confirmOrientBtn').addEventListener('click', () => {
    document.getElementById('alignCard').style.display = 'block';
    setupSrcCanvas();
    document.getElementById('alignCard').scrollIntoView({ behavior: 'smooth' });
  });

  // ---------- Corner tapping ----------
  const srcCanvas = document.getElementById('srcCanvas');
  const srcCtx = srcCanvas.getContext('2d');
  let displayScale = 1;
  const stepLabels = ['Tap the TOP-LEFT corner', 'Tap the TOP-RIGHT corner', 'Tap the BOTTOM-RIGHT corner', 'Tap the BOTTOM-LEFT corner'];

  function setupSrcCanvas() {
    state.corners = [];
    document.getElementById('warpBtn').disabled = true;
    document.getElementById('stepLabel').textContent = stepLabels[0];
    const maxW = Math.min(window.innerWidth - 40, 1600);
    displayScale = Math.min(1, maxW / state.orientCanvas.width);
    srcCanvas.width = state.orientCanvas.width * displayScale;
    srcCanvas.height = state.orientCanvas.height * displayScale;
    redrawSrc();
  }
  function redrawSrc() {
    srcCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height);
    srcCtx.drawImage(state.orientCanvas, 0, 0, srcCanvas.width, srcCanvas.height);
    const labels = ['TL', 'TR', 'BR', 'BL'];
    state.corners.forEach((c, i) => {
      srcCtx.fillStyle = '#5b8cff';
      srcCtx.beginPath(); srcCtx.arc(c.x, c.y, 8, 0, Math.PI * 2); srcCtx.fill();
      srcCtx.fillStyle = '#fff'; srcCtx.font = 'bold 12px sans-serif';
      srcCtx.fillText(labels[i], c.x + 10, c.y - 10);
    });
    if (state.corners.length === 4) {
      srcCtx.strokeStyle = '#5b8cff'; srcCtx.lineWidth = 2;
      srcCtx.beginPath(); srcCtx.moveTo(state.corners[0].x, state.corners[0].y);
      for (let i = 1; i < 4; i++) srcCtx.lineTo(state.corners[i].x, state.corners[i].y);
      srcCtx.closePath(); srcCtx.stroke();
    }
  }
  function handleTap(clientX, clientY) {
    if (state.corners.length >= 4) return;
    const rect = srcCanvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (srcCanvas.width / rect.width);
    const y = (clientY - rect.top) * (srcCanvas.height / rect.height);
    state.corners.push({ x, y });
    redrawSrc();
    if (state.corners.length < 4) document.getElementById('stepLabel').textContent = stepLabels[state.corners.length];
    else { document.getElementById('stepLabel').textContent = 'All 4 corners set.'; document.getElementById('warpBtn').disabled = false; }
  }
  srcCanvas.addEventListener('click', (e) => handleTap(e.clientX, e.clientY));
  srcCanvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { e.preventDefault(); handleTap(e.touches[0].clientX, e.touches[0].clientY); }
  }, { passive: false });
  document.getElementById('resetCorners').addEventListener('click', setupSrcCanvas);

  // ---------- Warp + detect ----------
  document.getElementById('warpBtn').addEventListener('click', () => {
    const toFull = c => ({ x: c.x / displayScale, y: c.y / displayScale });
    const corners = state.corners.map(toFull);
    state.warped = OMREngine.warpToCanonical(state.orientCanvas, corners);
    const wc = document.getElementById('warpedCanvas');
    wc.width = OMREngine.CANON_W; wc.height = OMREngine.CANON_H;
    wc.getContext('2d').putImageData(state.warped.imageData, 0, 0);
    buildCalibFields();
    document.getElementById('calibCard').style.display = 'block';
    document.getElementById('calibCard').scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('detectBtn').addEventListener('click', () => {
    state.bubbleMap = OMREngine.buildGrid(state.templateCfg);
    const sensitivity = parseFloat(val('sensitivity'));
    state.detections = OMREngine.detectAnswers(state.warped.imageData, state.bubbleMap, sensitivity);

    const wc = document.getElementById('warpedCanvas');
    const ctx = wc.getContext('2d');
    ctx.putImageData(state.warped.imageData, 0, 0);
    state.bubbleMap.forEach(row => {
      const det = state.detections.find(d => d.q === row.q);
      row.options.forEach(o => {
        ctx.beginPath(); ctx.arc(o.cx, o.cy, 10, 0, Math.PI * 2);
        let color = 'rgba(255,255,255,0.3)';
        if (det.detected === o.opt) color = det.state === 'VALID' ? '#3ecf8e' : '#c084fc';
        if (det.state === 'MULTIPLE') color = '#ff5c72';
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      });
    });

    renderScanSummary();
    document.getElementById('scorePreview').textContent = 'Save the card to see the score.';
    document.getElementById('scanResultsCard').style.display = 'block';
    document.getElementById('scanResultsCard').scrollIntoView({ behavior: 'smooth' });
  });

  function renderScanSummary() {
    const counts = { VALID: 0, BLANK: 0, MULTIPLE: 0, UNCERTAIN: 0 };
    state.detections.forEach(d => counts[d.state]++);
    document.getElementById('scanSummary').innerHTML = Object.entries(counts)
      .map(([k, v]) => `<div><b class="state-${k}">${v}</b>${k}</div>`).join('');
  }

  document.getElementById('sendToVerifyBtn').addEventListener('click', () => {
    renderVerifyTable();
    document.querySelector('nav.tabs button[data-tab="verify"]').click();
  });

  document.getElementById('saveCardBtn').addEventListener('click', saveCurrentCard);

  async function saveCurrentCard() {
    if (!state.examSubjectId) return setStatus('saveCardStatus', 'Pick an active subject on the Marking Key tab first', false);
    const learnerId = learnerIdInput.value.trim();
    const learnerName = learnerNameInput.value.trim();
    if (!learnerId) return setStatus('saveCardStatus', 'Enter a Learner ID', false);

    if (!state.learnerKnown && learnerName) {
      await ApiClient.call('upsertLearner', { learnerId, name: learnerName, grade: val('examGrade') });
    }

    state.cardId = state.cardId || ('CARD' + Date.now());
    const regRes = await ApiClient.call('registerCardsBatch', {
      cards: [{ cardId: state.cardId, learnerId, examSubjectId: state.examSubjectId, status: 'scanned' }]
    });
    const saveRes = await ApiClient.call('saveDetectedAnswersBatch', {
      cardId: state.cardId,
      answers: state.detections.map(d => ({ q: d.q, detected: d.detected, state: d.state, confidence: d.confidence }))
    });
    const queued = regRes.queued || saveRes.queued;
    setStatus('saveCardStatus', queued ? 'Saved offline — score will follow once synced' : 'Card saved', true);

    if (!queued) {
      const scoreRes = await ApiClient.call('scoreCard', { cardId: state.cardId, examSubjectId: state.examSubjectId }, { noQueue: true }).catch(e => ({ error: e.message }));
      if (scoreRes.error) {
        document.getElementById('scorePreview').textContent = 'Could not score yet: ' + scoreRes.error;
      } else {
        document.getElementById('scorePreview').textContent =
          `${learnerName || learnerId}: ${scoreRes.score}/${scoreRes.maxScore} (${scoreRes.percentage}%) — Grade ${scoreRes.grade}`;
      }
    }

    if (state.batchQueue.length > 1 && state.batchIndex < state.batchQueue.length - 1) {
      document.getElementById('nextInBatchBtn').style.display = 'inline-flex';
    }
  }

  // ---------- Verify (flagged only) ----------
  function renderVerifyTable() {
    const body = document.getElementById('verifyBody');
    const optLabels = state.templateCfg.optionLabels;
    const flagged = state.detections.filter(d => d.state !== 'VALID');
    document.getElementById('verifyCount').textContent =
      `${flagged.length} of ${state.detections.length} questions need a look`;
    body.innerHTML = flagged.map(d => {
      const options = optLabels.map(o => `<option value="${o}" ${d.detected === o ? 'selected' : ''}>${o}</option>`).join('');
      return `<tr class="flagRow">
        <td>${d.q}</td><td>${d.detected || '—'}</td>
        <td class="state-${d.state}">${d.state}</td>
        <td>${(d.confidence * 100).toFixed(0)}%</td>
        <td><select class="ans" data-q="${d.q}"><option value="">ABS</option>${options}</select></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5">Nothing flagged — all answers were confident.</td></tr>';

    body.querySelectorAll('select.ans').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const q = parseInt(e.target.dataset.q, 10);
        const d = state.detections.find(x => x.q === q);
        d._corrected = e.target.value || 'ABS';
      });
    });
  }

  document.getElementById('applyVerificationBtn').addEventListener('click', async () => {
    const corrections = state.detections
      .filter(d => d._corrected !== undefined)
      .map(d => ({ cardId: state.cardId, q: d.q, original: d.detected, correctedTo: d._corrected }));
    corrections.forEach(c => {
      const d = state.detections.find(x => x.q === c.q);
      d.detected = c.correctedTo; d.state = 'VALID'; d.confidence = 1;
    });
    if (corrections.length) await ApiClient.call('saveVerificationCorrections', { corrections, user: 'tablet' });
    await saveCurrentCard();
    renderVerifyTable();
  });

  // ---------- Results ----------
  document.getElementById('generateResultsBtn').addEventListener('click', async () => {
    if (!state.examId) return setStatus('resultsStatus', 'No exam set', false);
    const res = await ApiClient.call('generateFinalResults', { examId: state.examId }, { noQueue: true }).catch(e => ({ error: e.message }));
    if (res.error) return setStatus('resultsStatus', res.error, false);
    setStatus('resultsStatus', `Generated: ${res.learners} learners across ${res.subjects} subject entries`, true);
    const exportRes = await ApiClient.call('exportResults', { examId: state.examId }, { noQueue: true }).catch(() => null);
    if (exportRes) renderResultsTable(exportRes.finalResults);
  });

  function renderResultsTable(rows) {
    if (!rows || !rows.length) { document.getElementById('resultsTableWrap').innerHTML = '<p class="hint">No results yet.</p>'; return; }
    const headers = Object.keys(rows[0]);
    const html = `<div class="table-scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
      rows.map(r => `<tr>${headers.map(h => `<td>${r[h]}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>';
    document.getElementById('resultsTableWrap').innerHTML = html;
  }

  document.getElementById('flushQueueBtn').addEventListener('click', async () => {
    const res = await ApiClient.flushQueue();
    updateQueueStatus();
    setStatus('resultsStatus', `Synced ${res.sent}, ${res.remaining} still pending`, res.remaining === 0);
  });
  function updateQueueStatus() {
    document.getElementById('queueStatus').textContent = `${ApiClient.queueLength()} item(s) pending sync`;
  }
  updateQueueStatus();
  setInterval(updateQueueStatus, 3000);

  // ---------- Class list (live) ----------
  async function refreshClassList() {
    if (!state.examId) { document.getElementById('classListWrap').innerHTML = '<p class="hint">Set up an exam first.</p>'; return; }
    const res = await ApiClient.call('getClassList', { examId: state.examId }, { noQueue: true }).catch(e => ({ error: e.message }));
    if (res.error) { document.getElementById('classListWrap').innerHTML = `<p class="hint status-bad">${res.error}</p>`; return; }
    if (!res.rows.length) { document.getElementById('classListWrap').innerHTML = '<p class="hint">No learners found for this grade yet.</p>'; return; }

    const subjectIds = res.examSubjects.map(es => es.subjectId);
    const headerCells = ['Learner', ...subjectIds, 'Total', 'Avg %', 'Pos'];
    const bodyRows = res.rows.map(r => {
      const subjCells = subjectIds.map(sid => {
        const s = r.subjects[sid];
        return s ? `${s.score}/${s.maxScore}` : '—';
      });
      return `<tr><td>${r.name || r.learnerId}</td>${subjCells.map(c => `<td>${c}</td>`).join('')}<td>${r.total ?? '—'}</td><td>${r.average ?? '—'}</td><td>${r.position ?? '—'}</td></tr>`;
    });
    document.getElementById('classListWrap').innerHTML =
      `<div class="table-scroll"><table><thead><tr>${headerCells.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${bodyRows.join('')}</tbody></table></div>`;
  }

  // ---------- Utility ----------
  function setStatus(elId, msg, ok) {
    document.getElementById(elId).innerHTML = `<span class="${ok ? 'status-ok' : 'status-bad'}">${msg}</span>`;
  }
})();
