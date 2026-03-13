const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7452;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(__dirname));

const USERS = ['Russell','Mommy','Daddy','Margaret','Caroline','Ball','Grandmother'];

const QF_MATCHUPS = [
  ['DR','KOR'],
  ['USA','CAN'],
  ['ITA','PR'],
  ['JPN','VEN'],
];

const DEFAULT_SCORING = {
  correctQF: 5, correctSF: 10, correctF: 15,
  winnerDiffQF: 1, winnerDiffSF: 1, winnerDiffF: 2,
  loserDiffQF: 1, loserDiffSF: 1, loserDiffF: 2,
  totalRunsDiff: 0.5, totalHRDiff: 1, correctMVP: 15
};

// ===== Data helpers =====
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ picks: {}, results: {}, scoring: DEFAULT_SCORING }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error loading data:', err);
    return { picks: {}, results: {}, scoring: DEFAULT_SCORING };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== Scoring computation =====
function getTeamsForSlot(slot, data) {
  if (slot.startsWith('qf')) {
    const idx = parseInt(slot[2]);
    return QF_MATCHUPS[idx];
  }
  if (slot === 'sf0') return [data.qf0 || null, data.qf3 || null];
  if (slot === 'sf1') return [data.qf1 || null, data.qf2 || null];
  if (slot === 'f0')  return [data.sf0 || null, data.sf1 || null];
  return [null, null];
}

function computeScore(userPicks, results, scoring) {
  let score = 0;

  const games = [
    { key: 'qf0', r: 'QF' }, { key: 'qf1', r: 'QF' },
    { key: 'qf2', r: 'QF' }, { key: 'qf3', r: 'QF' },
    { key: 'sf0', r: 'SF' }, { key: 'sf1', r: 'SF' },
    { key: 'f0',  r: 'F'  },
  ];

  let actualRuns = 0;

  for (const g of games) {
    const actualWinner = results[g.key];
    
    // Accumulate total actual runs if scores are set
    const aA = Number(results[g.key + '_scoreA']);
    const aB = Number(results[g.key + '_scoreB']);
    if (!isNaN(aA)) actualRuns += aA;
    if (!isNaN(aB)) actualRuns += aB;

    if (!actualWinner) continue; // Only process games that have been played

    // Correct winner bonus
    if (userPicks[g.key] === actualWinner) {
      score += Number(scoring['correct' + g.r]) || 0;
    }

    // Score accuracy — only if same matchup
    const actualTeams = getTeamsForSlot(g.key, results);
    const userTeams = getTeamsForSlot(g.key, userPicks);
    const teamsMatch = actualTeams[0] && actualTeams[1] &&
                       actualTeams[0] === userTeams[0] && actualTeams[1] === userTeams[1];

    if (teamsMatch) {
      const uA = Number(userPicks[g.key + '_scoreA']);
      const uB = Number(userPicks[g.key + '_scoreB']);

      // If both actual scores are set, and user entered scores (or if user didn't enter QF/SF scores this just skips)
      if (!isNaN(aA) && !isNaN(aB) && !isNaN(uA) && !isNaN(uB)) {
        // which position is winner?
        const winIsA = actualWinner === actualTeams[0];
        const actualWinScore  = winIsA ? aA : aB;
        const actualLoseScore = winIsA ? aB : aA;
        const userWinScore    = winIsA ? uA : uB;
        const userLoseScore   = winIsA ? uB : uA;

        score -= Math.abs(userWinScore - actualWinScore) * (Number(scoring['winnerDiff' + g.r]) || 0);
        score -= Math.abs(userLoseScore - actualLoseScore) * (Number(scoring['loserDiff' + g.r]) || 0);
      }
    }
  }

  // Tiebreakers only apply if tournament is over (Championship won)
  const isTournamentOver = !!results.f0;
  if (isTournamentOver) {
    const userRuns = Number(userPicks.tbRuns);
    if (!isNaN(userRuns)) score -= Math.abs(userRuns - actualRuns) * (Number(scoring.totalRunsDiff) || 0);

    const actualHR = Number(results.actualTotalHR);
    const userHR = Number(userPicks.tbHR);
    if (!isNaN(actualHR) && !isNaN(userHR)) score -= Math.abs(userHR - actualHR) * (Number(scoring.totalHRDiff) || 0);
  }

  // MVP Bonus should apply independently whenever the admin sets it
  const actualMVP = results.actualMVP;
  const userMVP = userPicks.tbMVP;
  if (actualMVP && userMVP && actualMVP.toLowerCase() === userMVP.toLowerCase()) {
    score += Number(scoring.correctMVP) || 0;
  }

  return Math.round(score * 100) / 100;
}

// ===== Routes =====
app.get('/api/picks/:user', (req, res) => {
  const data = loadData();
  res.json(data.picks[req.params.user] || {});
});

app.put('/api/picks/:user', (req, res) => {
  const data = loadData();
  data.picks[req.params.user] = req.body;
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/results', (req, res) => {
  const data = loadData();
  res.json(data.results || {});
});

app.put('/api/results', (req, res) => {
  const data = loadData();
  data.results = req.body;
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/scoring', (req, res) => {
  const data = loadData();
  res.json(data.scoring || DEFAULT_SCORING);
});

app.put('/api/scoring', (req, res) => {
  const data = loadData();
  data.scoring = req.body;
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const data = loadData();
  const results = data.results || {};
  const scoring = data.scoring || DEFAULT_SCORING;
  const scores = USERS.map(name => ({
    name,
    score: computeScore(data.picks[name] || {}, results, scoring),
    hasPicks: Object.keys(data.picks[name] || {}).length > 0
  }));
  res.json(scores);
});

app.listen(PORT, () => {
  console.log(`WBC Bracket server running at http://localhost:${PORT}`);
});
