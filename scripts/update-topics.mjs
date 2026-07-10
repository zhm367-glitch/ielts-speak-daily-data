import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(ROOT, 'topics.json');

const SOURCES = [
  { name: 'Examword IELTS Speaking Exam Questions', url: 'https://www.examword.com/ielts-practice/speaking-exam-question' },
  { name: 'NextStep IELTS Recent Speaking Questions', url: 'https://nextstepielts.com/ielts-speaking-recent-questions/' }
];

const SEED_QUESTIONS = [
  { question: 'Do you prefer to study in the mornings or the afternoons?', materialKey: 'study-time' },
  { question: 'What do you do when you feel bored?', materialKey: 'boredom' },
  { question: 'What is one app you cannot live without?', materialKey: 'useful-app' },
  { question: 'What is the most recent thing you recycled?', materialKey: 'recycling' },
  { question: 'Do you prefer typing or handwriting?', materialKey: 'typing-handwriting' }
].map(item => ({
  ...item,
  sourceName: '本地考生回忆题初始整理',
  sourceUrl: 'https://www.examword.com/ielts-practice/speaking-exam-question'
}));

function materialKey(question) {
  const rules = [
    ['study-time', /(?:study.*(?:morning|afternoon)|(?:morning|afternoon).*study)/i],
    ['boredom', /\b(?:bored|boring|boredom)\b/i],
    ['useful-app', /\b(?:app|application)\b/i],
    ['recycling', /\b(?:recycl\w*|rubbish|waste sorting)\b/i],
    ['typing-handwriting', /\b(?:typing|handwriting|write by hand)\b/i]
  ];
  return rules.find(([, expression]) => expression.test(question))?.[0] || null;
}

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

function extractQuestions(html, source) {
  const text = cleanHtml(html);
  const matches = text.matchAll(/((?:Do|Did|Does|Are|Is|Have|Has|Would|Will|What|When|Where|Why|How|Who|Which|Should|Can|Could)[^?]{8,160}\?)/g);
  const found = [];
  for (const match of matches) {
    const question = match[1].trim();
    const key = materialKey(question);
    found.push({
      id: createHash('sha1').update(`${source.url}:${question}`).digest('hex').slice(0, 12),
      question,
      materialKey: key,
      sourceName: source.name,
      sourceUrl: source.url
    });
  }
  return found;
}

async function fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(source.url, {
      headers: { 'user-agent': 'IELTS-Speak-Daily-Topic-Updater/1.0 (+https://github.com/zhm367-glitch/ielts-speak-daily-data)' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractQuestions(await response.text(), source);
  } finally {
    clearTimeout(timer);
  }
}

function uniqueQuestions(questions) {
  const seen = new Set();
  return questions.filter(item => {
    const key = item.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fingerprint(questions) {
  return JSON.stringify(questions.map(({ id, question, materialKey, sourceUrl }) => ({ id, question, materialKey, sourceUrl })));
}

async function loadPrevious() {
  if (!existsSync(OUTPUT)) return null;
  try { return JSON.parse(await readFile(OUTPUT, 'utf8')); }
  catch { return null; }
}

const previous = await loadPrevious();
const settled = await Promise.allSettled(SOURCES.map(fetchSource));
const fetched = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
const fresh = uniqueQuestions(fetched);
const previousQuestions = Array.isArray(previous?.questions) ? previous.questions : [];
const fallback = SEED_QUESTIONS.flatMap(seed => {
  const key = seed.materialKey;
  const current = fresh.filter(item => item.materialKey === key);
  if (current.length) return [];
  const previousForKey = previousQuestions.filter(item => item.materialKey === key);
  return previousForKey.length ? previousForKey : [seed];
});
const trainingTopicQuestions = uniqueQuestions([
  ...fresh.filter(item => item.materialKey),
  ...fallback
]);
const selected = uniqueQuestions([
  ...fresh.slice(0, 50),
  ...trainingTopicQuestions
]).slice(0, 60);
const now = new Date().toISOString();
const changed = fingerprint(selected) !== fingerprint(previousQuestions);
const payload = {
  schemaVersion: 1,
  sourceType: 'candidate-recall-unofficial',
  updatedAt: changed || !previous?.updatedAt ? now : previous.updatedAt,
  lastCheckedAt: now,
  sources: SOURCES,
  questions: selected
};

await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
const failed = settled.filter(result => result.status === 'rejected').length;
console.log(JSON.stringify({ checkedAt: now, changed, questions: selected.length, failedSources: failed }));
