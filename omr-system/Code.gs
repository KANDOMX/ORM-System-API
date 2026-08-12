/**
 * OMR MARKING SYSTEM — GOOGLE APPS SCRIPT API
 * ---------------------------------------------------
 * Setup:
 * 1. In your Google Sheet: Extensions > Apps Script
 * 2. Delete any starter code, paste this whole file in.
 * 3. Run `initializeSheets` once (select it in the toolbar dropdown, click Run).
 *    - First run will ask for authorization — approve it.
 *    - This creates all 11 tabs with the correct headers.
 * 4. Deploy > New deployment > type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Copy the Web app URL — that's your free API endpoint.
 * 5. In the frontend, POST JSON like:
 *    { "action": "saveExamSubject", "payload": {...} }
 *    to that URL.
 *
 * All writes are batched (arrays), per the quota rules in the spec.
 *
 * SETUP CHECKLIST (do this once, as the admin — end users never touch this):
 * 1. Extensions > Apps Script in your Sheet, paste this file in.
 * 2. Set SPREADSHEET_ID below to your Sheet's ID.
 * 3. Run `initializeSheets` once (creates all 11 tabs).
 * 4. Deploy > New deployment > Web app, Execute as Me, Access Anyone.
 * 5. Copy the URL ending in /exec, paste it into js/config.js as
 *    APPS_SCRIPT_URL — that's the only other place a URL needs to go.
 *    End users of the app never see either of these values.
 */
const SPREADSHEET_ID = '18Ww-Fi0kP_j69Vjikax1m-0808p3CjoeV-n8BoJN33I';

function getSS() {
  if (SPREADSHEET_ID && SPREADSHEET_ID !== 'PASTE_YOUR_SHEET_ID_HERE') {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('No SPREADSHEET_ID set and no active spreadsheet found. ' +
      'Paste your Sheet ID into SPREADSHEET_ID at the top of Code.gs.');
  }
  return active;
}

const SHEET_DEFS = {
  Learners:        ['learnerId','name','grade','status','notes','createdAt'],
  Exams:           ['examId','name','term','year','grade','status','createdAt'],
  Subjects:        ['subjectId','name'],
  ExamSubjects:    ['examSubjectId','examId','subjectId','questionCount','marksPerQuestion','answerOptions','createdAt'],
  MarkingKeys:      ['examSubjectId','questionNo','correctOption','version','locked','updatedAt'],
  AnswerCards:      ['cardId','learnerId','examSubjectId','fileRef','status','uploadedAt'],
  DetectedAnswers:  ['cardId','questionNo','detectedOption','state','confidence','updatedAt'],
  SubjectResults:   ['learnerId','examSubjectId','score','maxScore','percentage','grade','updatedAt'],
  FinalResults:     ['examId','learnerId','total','maxTotal','average','grade','position','updatedAt'],
  VerificationLog:  ['cardId','questionNo','originalDetected','correctedTo','user','timestamp'],
  Settings:         ['key','value']
};

function initializeSheets() {
  const ss = getSS();
  Object.keys(SHEET_DEFS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEET_DEFS[name];
    sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  Logger.log('Sheets initialized.');
}

// ---------- HTTP entry points ----------

function doGet(e) {
  try {
    const action = e.parameter.action;
    const payload = e.parameter.payload ? JSON.parse(e.parameter.payload) : {};
    return respond(route(action, payload));
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return respond(route(body.action, body.payload || {}));
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(action, payload) {
  const actions = {
    getExam, getLearners, createExam, saveExamSubject,
    saveMarkingKeyBatch, lockKey, registerCardsBatch,
    saveDetectedAnswersBatch, saveVerificationCorrections,
    getSubjectResults, generateFinalResults, exportResults,
    getLearnerById, upsertLearner, scoreCard, getClassList
  };
  if (!actions[action]) throw new Error('Unknown action: ' + action);
  return actions[action](payload);
}

// ---------- Sheet helpers ----------

function sheet(name) {
  const sh = getSS().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name + ' — run initializeSheets first.');
  return sh;
}

function readRows(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1)
    .filter(r => r.join('') !== '')
    .map(r => Object.fromEntries(headers.map((h,i) => [h, r[i]])));
}

function appendRows(name, rows) {
  if (!rows.length) return;
  const sh = sheet(name);
  const headers = SHEET_DEFS[name];
  const values = rows.map(row => headers.map(h => row[h] !== undefined ? row[h] : ''));
  sh.getRange(sh.getLastRow()+1, 1, values.length, headers.length).setValues(values);
}

function upsertRows(name, keyFields, rows) {
  const sh = sheet(name);
  const headers = SHEET_DEFS[name];
  const data = sh.getDataRange().getValues();
  const keyIdx = keyFields.map(k => headers.indexOf(k));
  const toAppend = [];

  rows.forEach(row => {
    let foundRow = -1;
    for (let r = 1; r < data.length; r++) {
      const matches = keyIdx.every((ci, i) => String(data[r][ci]) === String(row[keyFields[i]]));
      if (matches) { foundRow = r; break; }
    }
    const values = headers.map(h => row[h] !== undefined ? row[h] : '');
    if (foundRow >= 0) {
      sh.getRange(foundRow+1, 1, 1, headers.length).setValues([values]);
      data[foundRow] = values;
    } else {
      toAppend.push(values);
      data.push(values);
    }
  });
  if (toAppend.length) {
    sh.getRange(sh.getLastRow()+1, 1, toAppend.length, headers.length).setValues(toAppend);
  }
}

function nowIso() { return new Date().toISOString(); }

// ---------- API actions ----------

function getExam({ examId }) {
  const exam = readRows('Exams').find(e => e.examId === examId);
  const examSubjects = readRows('ExamSubjects').filter(es => es.examId === examId);
  return { exam, examSubjects };
}

function getLearners({ grade }) {
  const all = readRows('Learners');
  return grade ? all.filter(l => String(l.grade) === String(grade)) : all;
}

function createExam(payload) {
  const examId = payload.examId || ('EX' + Date.now());
  appendRows('Exams', [{ ...payload, examId, createdAt: nowIso() }]);
  return { examId };
}

function saveExamSubject(payload) {
  if (!payload.questionCount || payload.questionCount < 1) {
    throw new Error('questionCount is required and must be >= 1');
  }
  const examSubjectId = payload.examSubjectId || (payload.examId + '_' + payload.subjectId);
  upsertRows('ExamSubjects', ['examSubjectId'], [{
    ...payload, examSubjectId, createdAt: nowIso()
  }]);
  return { examSubjectId };
}

function saveMarkingKeyBatch({ examSubjectId, keys }) {
  const es = readRows('ExamSubjects').find(x => x.examSubjectId === examSubjectId);
  if (!es) throw new Error('Unknown examSubjectId: ' + examSubjectId);

  const expected = Number(es.questionCount);
  const validOptions = String(es.answerOptions || 'A,B,C,D').split(',').map(s=>s.trim());

  if (keys.length !== expected) {
    throw new Error(`Key has ${keys.length} entries, expected ${expected}`);
  }
  const seen = new Set();
  keys.forEach(k => {
    if (seen.has(k.questionNo)) throw new Error('Duplicate question number: ' + k.questionNo);
    seen.add(k.questionNo);
    if (!validOptions.includes(k.correctOption)) {
      throw new Error(`Invalid option "${k.correctOption}" for Q${k.questionNo}`);
    }
  });
  for (let q = 1; q <= expected; q++) {
    if (!seen.has(q)) throw new Error('Missing question number: ' + q);
  }

  const existing = readRows('MarkingKeys').filter(k => k.examSubjectId === examSubjectId);
  const version = existing.length ? Math.max(...existing.map(k => Number(k.version)||1)) + 1 : 1;

  const rows = keys.map(k => ({
    examSubjectId, questionNo: k.questionNo, correctOption: k.correctOption,
    version, locked: false, updatedAt: nowIso()
  }));
  appendRows('MarkingKeys', rows);
  return { examSubjectId, version, count: rows.length };
}

function lockKey({ examSubjectId, version }) {
  const sh = sheet('MarkingKeys');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const esIdx = headers.indexOf('examSubjectId');
  const vIdx = headers.indexOf('version');
  const lockIdx = headers.indexOf('locked');
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (data[r][esIdx] === examSubjectId && Number(data[r][vIdx]) === Number(version)) {
      sh.getRange(r+1, lockIdx+1).setValue(true);
      count++;
    }
  }
  return { locked: count };
}

function registerCardsBatch({ cards }) {
  const rows = cards.map(c => ({
    cardId: c.cardId || ('CARD' + Date.now() + Math.floor(Math.random()*1000)),
    learnerId: c.learnerId, examSubjectId: c.examSubjectId,
    fileRef: c.fileRef || '', status: c.status || 'uploaded',
    uploadedAt: nowIso()
  }));
  appendRows('AnswerCards', rows);
  return { registered: rows.length, cardIds: rows.map(r=>r.cardId) };
}

function saveDetectedAnswersBatch({ cardId, answers }) {
  const rows = answers.map(a => ({
    cardId, questionNo: a.q, detectedOption: a.detected || '',
    state: a.state, confidence: a.confidence, updatedAt: nowIso()
  }));
  // Replace any existing rows for this card, then append fresh ones
  const sh = sheet('DetectedAnswers');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const cardIdx = headers.indexOf('cardId');
  const keepRows = data.slice(1).filter(r => r[cardIdx] !== cardId);
  sh.clearContents();
  sh.getRange(1,1,1,headers.length).setValues([headers]);
  if (keepRows.length) sh.getRange(2,1,keepRows.length,headers.length).setValues(keepRows);
  appendRows('DetectedAnswers', rows);
  return { saved: rows.length };
}

function saveVerificationCorrections({ corrections, user }) {
  const rows = corrections.map(c => ({
    cardId: c.cardId, questionNo: c.q, originalDetected: c.original,
    correctedTo: c.correctedTo, user: user || 'unknown', timestamp: nowIso()
  }));
  appendRows('VerificationLog', rows);

  // apply corrections into DetectedAnswers
  const sh = sheet('DetectedAnswers');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const cardIdx = headers.indexOf('cardId');
  const qIdx = headers.indexOf('questionNo');
  const detIdx = headers.indexOf('detectedOption');
  const stateIdx = headers.indexOf('state');
  corrections.forEach(c => {
    for (let r = 1; r < data.length; r++) {
      if (data[r][cardIdx] === c.cardId && Number(data[r][qIdx]) === Number(c.q)) {
        sh.getRange(r+1, detIdx+1).setValue(c.correctedTo);
        sh.getRange(r+1, stateIdx+1).setValue('VALID');
        break;
      }
    }
  });
  return { corrected: rows.length };
}

function getSubjectResults({ examSubjectId }) {
  return readRows('SubjectResults').filter(r => r.examSubjectId === examSubjectId);
}

/**
 * Computes and stores SubjectResults + FinalResults for an exam.
 * Marking logic lives in marking-engine.js — this mirrors it in Apps Script
 * so results can be generated server-side too.
 */
function generateFinalResults({ examId }) {
  const examSubjects = readRows('ExamSubjects').filter(es => es.examId === examId);
  const keys = readRows('MarkingKeys');
  const cards = readRows('AnswerCards');
  const detected = readRows('DetectedAnswers');
  const detByCard = {};
  detected.forEach(d => {
    (detByCard[d.cardId] = detByCard[d.cardId] || []).push(d);
  });

  const subjectResultRows = [];
  const learnerSubjectScores = {}; // learnerId -> [{examSubjectId, score, maxScore}]

  examSubjects.forEach(es => {
    const keyMap = {};
    keys.filter(k => k.examSubjectId === es.examSubjectId && k.locked)
        .forEach(k => keyMap[k.questionNo] = k.correctOption);

    const subjectCards = cards.filter(c => c.examSubjectId === es.examSubjectId);
    subjectCards.forEach(card => {
      const answers = detByCard[card.cardId] || [];
      let score = 0;
      const marks = Number(es.marksPerQuestion) || 1;
      const maxScore = Number(es.questionCount) * marks;
      let sat = false;
      answers.forEach(a => {
        if (a.detectedOption === 'ABS') return; // absent marker, not scored
        sat = true;
        if (a.detectedOption && a.detectedOption === keyMap[a.questionNo]) score += marks;
      });
      const percentage = maxScore ? (score/maxScore*100) : 0;
      subjectResultRows.push({
        learnerId: card.learnerId, examSubjectId: es.examSubjectId,
        score, maxScore, percentage: percentage.toFixed(2),
        grade: gradeFromPercentage(percentage), updatedAt: nowIso()
      });
      if (!learnerSubjectScores[card.learnerId]) learnerSubjectScores[card.learnerId] = [];
      learnerSubjectScores[card.learnerId].push({ score, maxScore, sat });
    });
  });

  upsertRows('SubjectResults', ['learnerId','examSubjectId'], subjectResultRows);

  const finalRows = Object.entries(learnerSubjectScores).map(([learnerId, subs]) => {
    const sat = subs.filter(s => s.sat);
    const total = sat.reduce((a,s)=>a+s.score, 0);
    const maxTotal = sat.reduce((a,s)=>a+s.maxScore, 0);
    const average = maxTotal ? (total/maxTotal*100) : 0;
    return { examId, learnerId, total, maxTotal, average: average.toFixed(2),
             grade: gradeFromPercentage(average), position: 0, updatedAt: nowIso() };
  });
  finalRows.sort((a,b) => b.average - a.average);
  finalRows.forEach((r,i) => r.position = i+1);

  upsertRows('FinalResults', ['examId','learnerId'], finalRows);
  return { subjects: subjectResultRows.length, learners: finalRows.length };
}

function gradeFromPercentage(pct) {
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

function exportResults({ examId }) {
  return {
    finalResults: readRows('FinalResults').filter(r => r.examId === examId),
    subjectResults: readRows('SubjectResults')
  };
}

// ---------- Learner lookup / auto-fill ----------

/** Look up a single learner by ID — used to auto-fill name during scanning. */
function getLearnerById({ learnerId }) {
  const learner = readRows('Learners').find(l => String(l.learnerId) === String(learnerId));
  return { found: !!learner, learner: learner || null };
}

/** Create or update a learner record — used when a scanned ID isn't known yet. */
function upsertLearner(payload) {
  if (!payload.learnerId || !payload.name) throw new Error('learnerId and name are required');
  upsertRows('Learners', ['learnerId'], [{
    learnerId: payload.learnerId,
    name: payload.name,
    grade: payload.grade || '',
    status: payload.status || 'active',
    notes: payload.notes || '',
    createdAt: nowIso()
  }]);
  return { learnerId: payload.learnerId };
}

// ---------- Instant single-card scoring ----------

/**
 * Scores ONE card immediately against its (locked) marking key and
 * stores the result in SubjectResults. Used right after a card is
 * saved, so the teacher sees a score instantly instead of waiting
 * for a batch "Generate Results" run.
 */
function scoreCard({ cardId, examSubjectId }) {
  const es = readRows('ExamSubjects').find(x => x.examSubjectId === examSubjectId);
  if (!es) throw new Error('Unknown examSubjectId: ' + examSubjectId);

  const card = readRows('AnswerCards').find(c => c.cardId === cardId);
  if (!card) throw new Error('Unknown cardId: ' + cardId);

  const keyRows = readRows('MarkingKeys').filter(k => k.examSubjectId === examSubjectId && k.locked);
  if (!keyRows.length) throw new Error('Marking key for this subject is not locked yet — cannot score.');
  const keyMap = {};
  keyRows.forEach(k => keyMap[k.questionNo] = k.correctOption);

  const answers = readRows('DetectedAnswers').filter(a => a.cardId === cardId);
  const marks = Number(es.marksPerQuestion) || 1;
  const maxScore = Number(es.questionCount) * marks;

  let score = 0, sat = false;
  answers.forEach(a => {
    if (a.detectedOption === 'ABS') return;
    sat = true;
    if (a.detectedOption && a.detectedOption === keyMap[a.questionNo]) score += marks;
  });
  const percentage = maxScore ? (score / maxScore * 100) : 0;
  const grade = gradeFromPercentage(percentage);

  upsertRows('SubjectResults', ['learnerId', 'examSubjectId'], [{
    learnerId: card.learnerId, examSubjectId,
    score, maxScore, percentage: percentage.toFixed(2), grade, updatedAt: nowIso()
  }]);

  return { learnerId: card.learnerId, score, maxScore, percentage: Number(percentage.toFixed(2)), grade, sat };
}

// ---------- Live class list ----------

/**
 * Returns every learner in the exam's grade, joined against every
 * configured subject's SubjectResults so far. Reads live — no need
 * to run generateFinalResults first; totals just won't be finalized
 * or positioned until that's run.
 */
function getClassList({ examId }) {
  const exam = readRows('Exams').find(e => e.examId === examId);
  if (!exam) throw new Error('Unknown examId: ' + examId);

  const learners = readRows('Learners').filter(l => String(l.grade) === String(exam.grade));
  const examSubjects = readRows('ExamSubjects').filter(es => es.examId === examId);
  const subjectResults = readRows('SubjectResults');
  const finalResults = readRows('FinalResults').filter(r => r.examId === examId);

  const rows = learners.map(learner => {
    const subjects = {};
    examSubjects.forEach(es => {
      const r = subjectResults.find(sr => sr.learnerId === learner.learnerId && sr.examSubjectId === es.examSubjectId);
      subjects[es.subjectId] = r ? { score: r.score, maxScore: r.maxScore, grade: r.grade } : null;
    });
    const final = finalResults.find(f => f.learnerId === learner.learnerId);
    return {
      learnerId: learner.learnerId, name: learner.name,
      subjects,
      total: final ? final.total : null,
      average: final ? final.average : null,
      position: final ? final.position : null
    };
  });

  return { examSubjects, rows };
}

