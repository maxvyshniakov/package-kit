// Strictly-typed Lanefather `failure_evidence` v1 builder (dependency-free).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const WORKTREE_PATH_RE = /\/(?:Users|home|private|var|tmp)[^\s:'"<>|)]*?\/\.claude\/worktrees\/[^/\s:'"<>|)]+/g;
const TMP_PATH_RE = /\/(?:private\/)?(?:tmp|var\/folders\/[^\s:'"<>|)]+\/T)\/[^\s:'"<>|)]+/g;
const VERIFY_RUN_RE = /package-kit-verification\/run-[A-Za-z0-9_-]+/g;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CLOCK_TIME_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const LOOPBACK_PORT_RE = /((?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)):\d+/g;
const NAMED_PORT_RE = /\b(port)\s+\d{4,5}\b/gi;
const SUBSECOND_DUR_RE = /\b\d+(?:\.\d+)?\s*(?:ms|µs|us|ns)\b/g;
const PAREN_SEC_DUR_RE = /\(\s*\d+(?:\.\d+)?\s*s\s*\)/g;
const IN_SEC_DUR_RE = /\b(in)\s+\d+(?:\.\d+)?s\b/gi;
const DECIMAL_SEC_DUR_RE = /\b\d+\.\d+s\b/g;
const PID_RE = /\b(pid)([=:\s]+)\d+\b/gi;
const HEX_ADDR_RE = /\b0x[0-9a-fA-F]{8,}\b/g;

const DECORATIVE_LINE_RE = /^[⎯─═\-_=~*•·]+$/;
const SECTION_STOP_RE = /^(?:Test Files\b|Tests\b|Start at\b|Duration\b|Snapshots\b|checks:|ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b)/;
const ERROR_LINE_RE = /\b(?:error|fail(?:ed|ure)?|exception|assert(?:ion)?|expected|received|actual|cannot|unexpected|invalid|missing|refused|denied|mismatch|not found|typeerror|referenceerror|syntaxerror|rangeerror)\b|TS\d{4}:|^→\s/i;
const PURE_TIMING_LINE_RE = /^(?:Done|Ran|Finished)\s+in\s+<DUR>\.?$/i;

const MAX_DETAIL_LINES = 12;
const MAX_FALLBACK_LINES = 100;
const MAX_HEADLINE_CHARS = 120;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '').replace(/\r/g, '');
}

function safeRealpath(target) {
  if (!target) return null;
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function buildPathReplacements(root) {
  const tmpDir = os.tmpdir();
  const candidates = [
    [safeRealpath(root), '<REPO>'],
    [root, '<REPO>'],
    [safeRealpath(tmpDir), '<TMP>'],
    [tmpDir, '<TMP>'],
  ];
  const seen = new Set();
  const list = [];
  for (const [raw, token] of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const cleaned = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    list.push([cleaned, token]);
  }
  list.sort((a, b) => b[0].length - a[0].length);
  return list;
}

export function normalizeLogLine(line, { root, pathReplacements } = {}) {
  let text = stripAnsi(line);
  const replacements = pathReplacements ?? buildPathReplacements(root);
  for (const [prefix, token] of replacements) {
    if (text.includes(prefix)) text = text.replaceAll(prefix, token);
  }
  text = text
    .replace(WORKTREE_PATH_RE, '<REPO>')
    .replace(VERIFY_RUN_RE, 'package-kit-verification/run-<ID>')
    .replace(TMP_PATH_RE, '<TMP>')
    .replace(ISO_TIMESTAMP_RE, '<TIMESTAMP>')
    .replace(CLOCK_TIME_RE, '<TIME>')
    .replace(LOOPBACK_PORT_RE, '$1:<PORT>')
    .replace(NAMED_PORT_RE, '$1 <PORT>')
    .replace(SUBSECOND_DUR_RE, '<DUR>')
    .replace(PAREN_SEC_DUR_RE, '(<DUR>)')
    .replace(IN_SEC_DUR_RE, '$1 <DUR>')
    .replace(DECIMAL_SEC_DUR_RE, '<DUR>')
    .replace(PID_RE, '$1$2<PID>')
    .replace(HEX_ADDR_RE, '<HEX>');
  return text.trim().replace(/\s+/g, ' ');
}

function cleanCaseId(raw) {
  return raw
    .replace(/(?:\s*\(?<DUR>\)?)+\s*$/g, '')
    .replace(/\s+\[\s*\d+\/\d+\s*\]\s*$/g, '')
    .trim();
}

function formatSignature(lines, headline) {
  const nonEmpty = lines.filter(Boolean);
  const hash = createHash('sha256').update(nonEmpty.join('\n')).digest('hex').slice(0, 16);
  const summary = (headline || nonEmpty[0] || 'failed').slice(0, MAX_HEADLINE_CHARS).trim();
  return `sha256:${hash} ${summary}`;
}

function collectDetailLines(lines, startIndex, isBoundary) {
  const details = [];
  let consecutiveBlank = 0;
  for (let index = startIndex; index < lines.length && details.length < MAX_DETAIL_LINES; index += 1) {
    const line = lines[index];
    if (!line) {
      consecutiveBlank += 1;
      if (details.length > 0 && consecutiveBlank >= 2) break;
      continue;
    }
    consecutiveBlank = 0;
    if (DECORATIVE_LINE_RE.test(line)) {
      if (details.length > 0) break;
      continue;
    }
    if (SECTION_STOP_RE.test(line) || isBoundary(line)) break;
    details.push(line);
  }
  return details;
}

function addCase(caseMap, rawId, details) {
  const id = cleanCaseId(rawId);
  if (!id) return;
  const existing = caseMap.get(id) ?? [];
  for (const line of details) {
    if (line && !existing.includes(line)) existing.push(line);
  }
  caseMap.set(id, existing);
}

function extractVitestSummaryCases(lines) {
  const isBoundary = line => /^FAIL\s+/.test(line);
  const caseMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const suiteMatch = /^FAIL\s+(.+?\s+>\s+.+)$/.exec(line);
    const fileMatch = !suiteMatch ? /^FAIL\s+(.+?)\s+\[\s*.+?\s*\]$/.exec(line) : null;
    const match = suiteMatch || fileMatch;
    if (!match) continue;
    const details = collectDetailLines(lines, index + 1, isBoundary);
    addCase(caseMap, match[1], details.length ? details : [line]);
  }
  return caseMap;
}

function extractPackageKitChecksCases(lines) {
  const sectionByCheck = new Map();
  let currentCheck = null;
  for (const line of lines) {
    const header = /^==\s+(.+?):\s+/.exec(line);
    if (header) {
      currentCheck = header[1].trim();
      if (!sectionByCheck.has(currentCheck)) sectionByCheck.set(currentCheck, []);
      continue;
    }
    if (line === 'checks:') {
      currentCheck = null;
      continue;
    }
    if (currentCheck && line && !DECORATIVE_LINE_RE.test(line)) {
      sectionByCheck.get(currentCheck).push(line);
    }
  }
  const caseMap = new Map();
  for (const line of lines) {
    const failMatch = /^FAIL\s+(.+?)\s+\((?:exit\s+\d+|SIG[A-Z0-9]+),\s*<DUR>\)$/.exec(line);
    if (!failMatch) continue;
    const name = failMatch[1].trim();
    const sectionLines = (sectionByCheck.get(name) ?? []).filter(l => !PURE_TIMING_LINE_RE.test(l));
    const details = sectionLines.length ? boundLines(sectionLines) : [line];
    addCase(caseMap, name, details);
  }
  return caseMap;
}

function extractRunnerLineCases(lines) {
  const matchLine = line => {
    const playwright = /^✘\s+\d+\s+(.+)$/.exec(line);
    if (playwright) return playwright[1];
    const nodeTest = /^✖\s+(.+)$/.exec(line);
    if (nodeTest && !/^failing tests:?$/i.test(nodeTest[1].trim())) return nodeTest[1];
    const vitestInline = /^[×✕]\s+(.+)$/.exec(line);
    if (vitestInline && !/^failing tests:?$/i.test(vitestInline[1].trim())) return vitestInline[1];
    const tap = /^not ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (tap) return tap[1];
    return null;
  };
  const isBoundary = line => matchLine(line) !== null;
  const caseMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const rawId = matchLine(lines[index]);
    if (!rawId) continue;
    const details = collectDetailLines(lines, index + 1, isBoundary);
    addCase(caseMap, rawId, details.length ? details : [lines[index]]);
  }
  return caseMap;
}

function boundLines(lines) {
  if (lines.length <= MAX_FALLBACK_LINES) return lines;
  const half = Math.floor(MAX_FALLBACK_LINES / 2);
  return [...lines.slice(0, half), ...lines.slice(-half)];
}

function mapToCases(caseMap) {
  const cases = [];
  for (const [id, details] of caseMap.entries()) {
    const headline = details.find(line => ERROR_LINE_RE.test(line)) ?? details[0] ?? id;
    cases.push({ id, signature: formatSignature(details.length ? details : [id], headline) });
  }
  return cases;
}

export function extractFailureCases(logText, { checkId, root } = {}) {
  const pathReplacements = buildPathReplacements(root);
  const rawLines = String(logText ?? '').split('\n');
  const lines = rawLines.map(line => normalizeLogLine(line, { root, pathReplacements }));

  const vitestCases = extractVitestSummaryCases(lines);
  if (vitestCases.size > 0) return mapToCases(vitestCases);

  const checksCases = extractPackageKitChecksCases(lines);
  if (checksCases.size > 0) return mapToCases(checksCases);

  const runnerCases = extractRunnerLineCases(lines);
  if (runnerCases.size > 0) return mapToCases(runnerCases);

  const nonEmpty = lines.filter(line => line && !DECORATIVE_LINE_RE.test(line));
  if (!nonEmpty.length) return [];

  const meaningful = nonEmpty.filter(line => !PURE_TIMING_LINE_RE.test(line));
  const pool = meaningful.length ? meaningful : nonEmpty;
  const bounded = boundLines(pool);
  const headline = pool.find(line => ERROR_LINE_RE.test(line)) ?? pool[0];
  const id = String(checkId || '').trim() || 'check';
  return [{ id, signature: formatSignature(bounded, headline) }];
}

export function buildFailureContext(checkId, {
  nodeMajor = process.versions.node.split('.')[0],
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return `package-kit/v1/node-${nodeMajor}/${platform}/${arch}/${checkId}`;
}

export function buildFailureEvidence({
  checkId,
  logText,
  root,
  timedOut = false,
  interrupted = false,
  environmentFailed = false,
  nodeMajor,
  platform,
  arch,
}) {
  const context = buildFailureContext(checkId, { nodeMajor, platform, arch });
  if (timedOut || interrupted || environmentFailed) {
    return { version: 1, comparable: false, context, cases: [] };
  }
  const cases = extractFailureCases(logText, { checkId, root });
  if (!cases.length) {
    return { version: 1, comparable: false, context, cases: [] };
  }
  return { version: 1, comparable: true, context, cases };
}
