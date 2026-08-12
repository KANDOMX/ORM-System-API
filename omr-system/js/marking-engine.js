/**
 * OMR MARKING SYSTEM — CALCULATING ENGINE
 * -----------------------------------------
 * Pure JS, no dependencies. Drop this <script> into the frontend
 * (or import as a module) to score subjects and combine results
 * without waiting on the Apps Script round trip.
 *
 * Mirrors the scoring logic in Code.gs so client-side previews
 * match what gets stored server-side.
 */

const MarkingEngine = (function () {

  /** Validate a marking key against questionCount before it can be locked. */
  function validateMarkingKey(questionCount, keyArray, validOptions) {
    validOptions = validOptions || ['A','B','C','D'];
    const errors = [];
    const seen = new Set();

    keyArray.forEach(k => {
      if (seen.has(k.questionNo)) errors.push(`Duplicate question number: ${k.questionNo}`);
      seen.add(k.questionNo);
      if (!validOptions.includes(k.correctOption)) {
        errors.push(`Invalid option "${k.correctOption}" for Q${k.questionNo}`);
      }
    });
    for (let q = 1; q <= questionCount; q++) {
      if (!seen.has(q)) errors.push(`Missing question number: ${q}`);
    }
    if (keyArray.length !== questionCount) {
      errors.push(`Key has ${keyArray.length} entries, expected ${questionCount}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Score one learner's card for one subject.
   * detectedAnswers: [{ q, detected, state }]
   * markingKey: [{ questionNo, correctOption }]
   * Returns null-safe result; 'ABS' detected marks the whole subject as not-sat.
   */
  function scoreSubject(detectedAnswers, markingKey, marksPerQuestion, questionCount) {
    const keyMap = {};
    markingKey.forEach(k => keyMap[k.questionNo] = k.correctOption);
    const marks = marksPerQuestion || 1;
    const maxScore = questionCount * marks;

    let score = 0;
    let sat = false;
    let blanks = 0, multiples = 0, uncertain = 0;

    detectedAnswers.forEach(a => {
      if (a.detected === 'ABS') return; // absent, exclude from scoring entirely
      sat = true;
      if (a.state === 'BLANK') blanks++;
      else if (a.state === 'MULTIPLE') multiples++;
      else if (a.state === 'UNCERTAIN') uncertain++;

      if (a.detected && a.detected === keyMap[a.q]) score += marks;
    });

    const percentage = maxScore ? (score / maxScore) * 100 : 0;

    return {
      score, maxScore,
      percentage: Number(percentage.toFixed(2)),
      grade: gradeFromPercentage(percentage),
      sat, blanks, multiples, uncertain
    };
  }

  /** Combine multiple subject results into a learner's totals. */
  function combineSubjects(subjectResults) {
    // subjectResults: [{ subjectId, score, maxScore, sat }]
    const satResults = subjectResults.filter(s => s.sat);
    const total = satResults.reduce((a, s) => a + s.score, 0);
    const maxTotal = satResults.reduce((a, s) => a + s.maxScore, 0);
    const average = maxTotal ? (total / maxTotal) * 100 : 0;

    return {
      total, maxTotal,
      average: Number(average.toFixed(2)),
      grade: gradeFromPercentage(average),
      subjectsSat: satResults.length,
      subjectsTotal: subjectResults.length
    };
  }

  /** Default grade bands — override by passing custom bands if the school uses different cutoffs. */
  function gradeFromPercentage(pct, bands) {
    bands = bands || [
      { min: 80, grade: 'A' },
      { min: 70, grade: 'B' },
      { min: 60, grade: 'C' },
      { min: 50, grade: 'D' },
      { min: 0,  grade: 'F' }
    ];
    for (const b of bands) if (pct >= b.min) return b.grade;
    return 'F';
  }

  /** Rank a list of learner totals into positions. Ties share a position (competition ranking). */
  function computePositions(learnerResults) {
    // learnerResults: [{ learnerId, average }]
    const sorted = [...learnerResults].sort((a, b) => b.average - a.average);
    let lastAvg = null, lastPos = 0;
    return sorted.map((r, i) => {
      const pos = (r.average === lastAvg) ? lastPos : i + 1;
      lastAvg = r.average; lastPos = pos;
      return { ...r, position: pos };
    });
  }

  /** Build the full multi-subject results table for an exam. */
  function buildFinalResultsTable(learners, subjectResultsByLearner, examSubjects) {
    // subjectResultsByLearner: { learnerId: [{examSubjectId, score, maxScore, sat}] }
    const rows = learners.map(learner => {
      const subs = subjectResultsByLearner[learner.learnerId] || [];
      const combined = combineSubjects(subs);
      const bySubject = {};
      examSubjects.forEach(es => {
        const s = subs.find(x => x.examSubjectId === es.examSubjectId);
        bySubject[es.examSubjectId] = s
          ? (s.sat ? `${s.score}/${s.maxScore}` : 'ABS')
          : '—';
      });
      return {
        learnerId: learner.learnerId,
        name: learner.name,
        ...bySubject,
        total: combined.total,
        maxTotal: combined.maxTotal,
        average: combined.average,
        grade: combined.grade
      };
    });
    const withPositions = computePositions(rows.map(r => ({ ...r, average: r.average })));
    return withPositions;
  }

  return {
    validateMarkingKey,
    scoreSubject,
    combineSubjects,
    gradeFromPercentage,
    computePositions,
    buildFinalResultsTable
  };
})();

// Node/module export if used outside the browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MarkingEngine;
}
