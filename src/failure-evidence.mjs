// Strictly-typed Lanefather `failure_evidence` v1 builder (dependency-free).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const WORKTREE_PATH_RE = /\/(?:Users|home|private|var|tmp)[^\s,:'"<>|)]*\/(?:\.claude|\.git)\/worktrees\/[^/\s,:'"<>|)]+/g;
const TMP_PATH_RE = /\/(?:private\/)?(?:tmp|var\/folders\/[^/\s,:'"<>|)]+\/[^/\s,:'"<>|)]+\/T)\/[^/\s,:'"<>|)]+/g;
const VERIFY_RUN_RE = /package-kit-verification\/run-[A-Za-z0-9_-]+/g;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CLOCK_TIME_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const LOOPBACK_PORT_RE = /((?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)):\d+/g;
const NAMED_PORT_RE = /\b(port)\s+\d{4,5}\b/gi;
const SESSION_FLAG_RE = /(--session(?:=|\s+))([A-Za-z0-9._-]+)-\d+\b/g;
const LOAD_AVG_RE = /\bload\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\b/gi;
const SUBSECOND_DUR_RE = /\b\d+(?:\.\d+)?\s*(?:ms|µs|us|ns)\b/g;
const PAREN_SEC_DUR_RE = /\(\s*\d+(?:\.\d+)?\s*s\s*\)/g;
const IN_SEC_DUR_RE = /\b(in)\s+\d+(?:\.\d+)?s\b/gi;
const DECIMAL_SEC_DUR_RE = /\b\d+\.\d+s\b/g;
const PID_RE = /\b(pid)([=:\s]+)\d+\b/gi;
const HEX_ADDR_RE = /\b0x[0-9a-fA-F]{8,}\b/g;

const DECORATIVE_LINE_RE = /^[⎯─═\-_=~*•·]+$/;
const PASSING_BOUNDARY_RE = /^(?:[✓✔▶]\s+|ok\s+\d+(?:\s+-|\s*$)|PASS\s+\S+)/;
const SECTION_STOP_RE = /^(?:Test Files\b|Tests\b|Start at\b|Duration\b|Snapshots\b|checks:|ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|\d+\/\d+\s+checks as expected\b)/;
const BOILERPLATE_LINE_RE = /^(?:Test Files\b|Tests\b|Start at\b|Duration\b|Snapshots\b|checks:|checks failed:|ℹ\s+|RUN\s+v\d|\d+\/\d+\s+checks as expected\b|Failed Tests\b|test at\s+\S+:\d+:\d+$)/;
const ERROR_LINE_RE = /\b(?:error|fail(?:ed|ure)?|exception|assert(?:ion)?|expected|received|actual|cannot|unexpected|invalid|missing|refused|denied|mismatch|not found|typeerror|referenceerror|syntaxerror|rangeerror|unhandled|coverage\b.*\bthreshold|threshold\b.*\bnot met)\b|TS\d{4}:|^→\s/i;
const PURE_TIMING_LINE_RE = /^(?:Done|Ran|Finished)\s+in\s+<DUR>\.?$/i;

const PKG_KIT_CHECK_FAIL_RE = /^FAIL\s+(.+?)\s+\((?:exit\s+\d+|SIG[A-Z0-9]+),\s*\d+(?:\.\d+)?s\)$/;
const PKG_KIT_CHECK_OK_RE = /^ok\s+(.+?)\s+\(\d+(?:\.\d+)?s\)$/;
const SID_KIT_SHARD_FAIL_RE = /^FAIL\s+(\S+)\s+\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)$/;
const SID_KIT_SHARD_BOUNDARY_RE = /^(?:PASS|FAIL|EXPECTED FAIL|INTERMITTENT FAIL)\s+\S+\s+\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)$/;
const PLAYWRIGHT_NUMBERED_RE = /^\d+\)\s+(\[[^\]]+\]\s+›\s+.+|.+\.(?:spec|test)\.[cm]?[jt]sx?:\d+:\d+\s+›\s+.+)$/;

const VITEST_TESTS_FAILED_RE = /^Tests\s+(\d+)\s+failed\b/;
const NODE_TEST_FAILED_RE = /^ℹ\s+fail\s+(\d+)$/;

export const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_RAW_LINE_CHARS = 4096;
const MAX_HEADLINE_CHARS = 120;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '').replace(/\r/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeRealpath(target) {
  if (!target) return null;
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function buildPathMatchers(root) {
  const tmpDir = os.tmpdir();
  const dedupSorted = rawPaths => {
    const seen = new Set();
    const out = [];
    for (const raw of rawPaths) {
      if (!raw || typeof raw !== 'string') continue;
      const cleaned = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  };
  const repoMatchers = dedupSorted([safeRealpath(root), root]).map(
    prefix => new RegExp(`${escapeRegExp(prefix)}(?=$|[/:\\\\\\s,'"<>|);])`, 'g'),
  );
  const tmpPaths = dedupSorted([safeRealpath(tmpDir), tmpDir]);
  const tmpSubpathMatchers = tmpPaths.map(
    prefix => new RegExp(`${escapeRegExp(prefix)}\\/[^/\\s,:'"<>|)]+`, 'g'),
  );
  const tmpExactMatchers = tmpPaths.map(
    prefix => new RegExp(`${escapeRegExp(prefix)}(?=$|[/:\\\\\\s,'"<>|);])`, 'g'),
  );
  return { repoMatchers, tmpSubpathMatchers, tmpExactMatchers };
}

export function normalizeLogLine(line, { root, pathMatchers } = {}) {
  let text = stripAnsi(line);
  if (text.length > MAX_RAW_LINE_CHARS) {
    const overflowHash = createHash('sha256').update(text.slice(MAX_RAW_LINE_CHARS)).digest('hex').slice(0, 16);
    text = `${text.slice(0, MAX_RAW_LINE_CHARS)} [truncated:${overflowHash}]`;
  }
  const matchers = pathMatchers ?? buildPathMatchers(root);
  for (const re of matchers.repoMatchers) text = text.replace(re, '<REPO>');
  for (const re of matchers.tmpSubpathMatchers) text = text.replace(re, '<TMP>');
  for (const re of matchers.tmpExactMatchers) text = text.replace(re, '<TMP>');
  text = text
    .replace(WORKTREE_PATH_RE, '<REPO>')
    .replace(VERIFY_RUN_RE, 'package-kit-verification/run-<ID>')
    .replace(TMP_PATH_RE, '<TMP>')
    .replace(ISO_TIMESTAMP_RE, '<TIMESTAMP>')
    .replace(CLOCK_TIME_RE, '<TIME>')
    .replace(LOOPBACK_PORT_RE, '$1:<PORT>')
    .replace(NAMED_PORT_RE, '$1 <PORT>')
    .replace(SESSION_FLAG_RE, '$1$2-<ID>')
    .replace(LOAD_AVG_RE, 'load <LOAD>')
    .replace(SUBSECOND_DUR_RE, '<DUR>')
    .replace(PAREN_SEC_DUR_RE, '(<DUR>)')
    .replace(IN_SEC_DUR_RE, '$1 <DUR>')
    .replace(DECIMAL_SEC_DUR_RE, '<DUR>')
    .replace(PID_RE, '$1$2<PID>')
    .replace(HEX_ADDR_RE, '<HEX>');
  return text.trim().replace(/\s+/g, ' ');
}

function cleanCaseId(raw) {
  let id = String(raw ?? '').trim();
  let changed = true;
  while (changed && id.length > 0) {
    changed = false;
    if (id.endsWith('(<DUR>)')) {
      id = id.slice(0, -'(<DUR>)'.length).trimEnd();
      changed = true;
    } else if (id.endsWith('<DUR>')) {
      id = id.slice(0, -'<DUR>'.length).trimEnd();
      changed = true;
    } else {
      const bracketMatch = /\s+\[\s*\d+\/\d+\s*\]$/.exec(id);
      if (bracketMatch) {
        id = id.slice(0, bracketMatch.index).trimEnd();
        changed = true;
      }
    }
  }
  return id.trim();
}

function formatSignature(lines, headline) {
  const nonEmpty = lines.filter(Boolean);
  const hash = createHash('sha256').update(nonEmpty.join('\n')).digest('hex').slice(0, 16);
  const summary = (headline || nonEmpty[0] || 'failed').slice(0, MAX_HEADLINE_CHARS).trim();
  return `sha256:${hash} ${summary}`;
}

function collectDetailLines(lines, startIndex, isBoundary, attributed) {
  const details = [];
  let consecutiveBlank = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      consecutiveBlank += 1;
      if (details.length > 0 && consecutiveBlank >= 2) break;
      continue;
    }
    consecutiveBlank = 0;
    if (DECORATIVE_LINE_RE.test(line)) {
      attributed.add(index);
      if (details.length > 0) break;
      continue;
    }
    if (PASSING_BOUNDARY_RE.test(line) || SECTION_STOP_RE.test(line) || isBoundary(line, index)) break;
    attributed.add(index);
    details.push(line);
  }
  return details;
}

function addCaseBlock(caseMap, rawId, details) {
  const id = cleanCaseId(rawId);
  if (!id) return;
  const block = details.filter(Boolean);
  const existing = caseMap.get(id) ?? [];
  existing.push(block);
  caseMap.set(id, existing);
}

function extractPackageKitChecksCases(rawTrimmed, lines, attributed) {
  const sectionByCheck = new Map();
  let currentCheck = null;
  const headerIndices = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const raw = rawTrimmed[index];
    const line = lines[index];
    const header = /^==\s+(.+?):\s+/.exec(raw);
    if (header) {
      currentCheck = header[1].trim();
      if (!sectionByCheck.has(currentCheck)) sectionByCheck.set(currentCheck, []);
      if (!headerIndices.has(currentCheck)) headerIndices.set(currentCheck, []);
      headerIndices.get(currentCheck).push(index);
      continue;
    }
    if (raw === 'checks:') {
      currentCheck = null;
      continue;
    }
    if (currentCheck) {
      sectionByCheck.get(currentCheck).push({ index, line });
    }
  }
  const caseMap = new Map();
  let sawSummary = false;
  for (let index = 0; index < rawTrimmed.length; index += 1) {
    const raw = rawTrimmed[index];
    const failMatch = PKG_KIT_CHECK_FAIL_RE.exec(raw);
    if (failMatch) {
      sawSummary = true;
      attributed.add(index);
      const name = failMatch[1].trim();
      for (const hIdx of headerIndices.get(name) ?? []) attributed.add(hIdx);
      const section = sectionByCheck.get(name) ?? [];
      const details = [];
      for (const entry of section) {
        attributed.add(entry.index);
        if (entry.line && !DECORATIVE_LINE_RE.test(entry.line) && !PURE_TIMING_LINE_RE.test(entry.line)) {
          details.push(entry.line);
        }
      }
      addCaseBlock(caseMap, name, details.length ? details : [lines[index]]);
      continue;
    }
    const okMatch = PKG_KIT_CHECK_OK_RE.exec(raw);
    if (okMatch) {
      attributed.add(index);
      const name = okMatch[1].trim();
      for (const hIdx of headerIndices.get(name) ?? []) attributed.add(hIdx);
      for (const entry of sectionByCheck.get(name) ?? []) attributed.add(entry.index);
    }
  }
  return sawSummary ? caseMap : new Map();
}

function extractSidKitShardCases(rawTrimmed, lines, attributed) {
  const caseMap = new Map();
  for (let index = 0; index < rawTrimmed.length; index += 1) {
    const raw = rawTrimmed[index];
    const failMatch = SID_KIT_SHARD_FAIL_RE.exec(raw);
    if (failMatch) {
      attributed.add(index);
      const details = [];
      for (let next = index + 1; next < rawTrimmed.length; next += 1) {
        const nextRaw = rawTrimmed[next];
        if (SID_KIT_SHARD_BOUNDARY_RE.test(nextRaw) || /^\d+\/\d+\s+checks as expected\b/.test(nextRaw)) break;
        attributed.add(next);
        if (lines[next] && !DECORATIVE_LINE_RE.test(lines[next]) && !PURE_TIMING_LINE_RE.test(lines[next])) {
          details.push(lines[next]);
        }
      }
      addCaseBlock(caseMap, failMatch[1], details.length ? details : [lines[index]]);
    } else if (SID_KIT_SHARD_BOUNDARY_RE.test(raw)) {
      attributed.add(index);
      for (let next = index + 1; next < rawTrimmed.length; next += 1) {
        const nextRaw = rawTrimmed[next];
        if (SID_KIT_SHARD_BOUNDARY_RE.test(nextRaw) || /^\d+\/\d+\s+checks as expected\b/.test(nextRaw)) break;
        attributed.add(next);
      }
    }
  }
  return caseMap;
}

function extractVitestSummaryCases(lines, attributed) {
  const isBoundary = line => /^FAIL\s+/.test(line);
  const caseMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    if (attributed.has(index)) continue;
    const line = lines[index];
    const suiteMatch = /^FAIL\s+(.+?\s+>\s+.+)$/.exec(line);
    const fileMatch = !suiteMatch ? /^FAIL\s+(.+?)\s+\[([^\]]+)\]$/.exec(line) : null;
    const match = suiteMatch || fileMatch;
    if (!match) continue;
    attributed.add(index);
    const details = collectDetailLines(lines, index + 1, isBoundary, attributed);
    addCaseBlock(caseMap, match[1], details.length ? details : [line]);
  }
  return caseMap;
}

function extractRunnerLineCases(lines, attributed, existingCaseMap) {
  const matchLine = line => {
    const playwright = /^✘\s+\d+\s+(.+)$/.exec(line);
    if (playwright) return playwright[1];
    const pwNumbered = PLAYWRIGHT_NUMBERED_RE.exec(line);
    if (pwNumbered) return pwNumbered[1];
    const nodeTest = /^✖\s+(.+)$/.exec(line);
    if (nodeTest && !/^failing tests:?$/i.test(nodeTest[1].trim())) return nodeTest[1];
    const vitestInline = /^[×✕]\s+(.+)$/.exec(line);
    if (vitestInline && !/^failing tests:?$/i.test(vitestInline[1].trim())) return vitestInline[1];
    const tap = /^not ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (tap) return tap[1];
    return null;
  };
  const isBoundary = (line, idx) => attributed.has(idx) || matchLine(line) !== null || /^FAIL\s+/.test(line);
  for (let index = 0; index < lines.length; index += 1) {
    if (attributed.has(index)) continue;
    const rawId = matchLine(lines[index]);
    if (!rawId) continue;
    attributed.add(index);
    const details = collectDetailLines(lines, index + 1, isBoundary, attributed);
    // Avoid duplicating Vitest inline `× Suite > test` when `FAIL file > Suite > test` already captured it.
    const cleaned = cleanCaseId(rawId);
    const coveredBySummary = [...existingCaseMap.keys()].some(
      key => key === cleaned || key.endsWith(` > ${cleaned}`),
    );
    if (coveredBySummary && (!details.length || (details.length === 1 && details[0] === lines[index]))) {
      continue;
    }
    addCaseBlock(existingCaseMap, rawId, details.length ? details : [lines[index]]);
  }
}

function reportedRunnerFailCount(lines) {
  let reported = 0;
  for (const line of lines) {
    const vitest = VITEST_TESTS_FAILED_RE.exec(line);
    if (vitest) reported = Math.max(reported, Number(vitest[1]));
    const nodeTest = NODE_TEST_FAILED_RE.exec(line);
    if (nodeTest) reported = Math.max(reported, Number(nodeTest[1]));
  }
  return reported;
}

function mapToCases(caseMap) {
  const cases = [];
  for (const [id, blocks] of caseMap.entries()) {
    // Deduplicate identical blocks and sort canonically when multiple occurrences share an ID.
    const uniqueBlocks = [];
    const seenKeys = new Set();
    for (const block of blocks) {
      const key = block.join('\n');
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      uniqueBlocks.push({ key, lines: block });
    }
    if (uniqueBlocks.length > 1) {
      uniqueBlocks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    const merged = uniqueBlocks.flatMap(entry => entry.lines);
    const headline = merged.find(line => ERROR_LINE_RE.test(line)) ?? merged[0] ?? id;
    cases.push({ id, signature: formatSignature(merged.length ? merged : [id], headline) });
  }
  return cases;
}

function collectResidualErrorLines(lines, attributed) {
  const residual = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (attributed.has(index)) continue;
    const line = lines[index];
    if (!line || DECORATIVE_LINE_RE.test(line) || PURE_TIMING_LINE_RE.test(line)) continue;
    if (PASSING_BOUNDARY_RE.test(line) || BOILERPLATE_LINE_RE.test(line)) continue;
    if (ERROR_LINE_RE.test(line) || /^FAIL\b/.test(line)) {
      residual.push(line);
    }
  }
  return residual;
}

export function extractFailureCases(logText, { checkId, root } = {}) {
  const pathMatchers = buildPathMatchers(root);
  const rawLines = String(logText ?? '').split('\n');
  const rawTrimmed = rawLines.map(line => stripAnsi(line).trim());
  const lines = rawLines.map(line => normalizeLogLine(line, { root, pathMatchers }));
  const attributed = new Set();

  // Outer wrappers first (package-kit checks, sid-kit browser-check shards) so inner test output
  // stays scoped to its owning sub-check and never short-circuits sibling sub-check failures.
  let caseMap = extractPackageKitChecksCases(rawTrimmed, lines, attributed);
  if (caseMap.size === 0) {
    caseMap = extractSidKitShardCases(rawTrimmed, lines, attributed);
  }
  const usedOuterWrapper = caseMap.size > 0;

  if (!usedOuterWrapper) {
    caseMap = extractVitestSummaryCases(lines, attributed);
    extractRunnerLineCases(lines, attributed, caseMap);
  }

  if (caseMap.size > 0) {
    const cases = mapToCases(caseMap);
    const residual = collectResidualErrorLines(lines, attributed);
    if (residual.length > 0) {
      const residualId = `${String(checkId || '').trim() || 'check'}#residual`;
      const headline = residual.find(line => ERROR_LINE_RE.test(line)) ?? residual[0];
      cases.push({ id: residualId, signature: formatSignature(residual, headline) });
    }
    return {
      cases,
      incomplete: !usedOuterWrapper && reportedRunnerFailCount(lines) > caseMap.size,
    };
  }

  const nonEmpty = lines.filter(line => line && !DECORATIVE_LINE_RE.test(line));
  if (!nonEmpty.length) return { cases: [], incomplete: false };

  const meaningful = nonEmpty.filter(line => !PURE_TIMING_LINE_RE.test(line));
  const pool = meaningful.length ? meaningful : nonEmpty;
  const headline = pool.find(line => ERROR_LINE_RE.test(line)) ?? pool[0];
  const id = String(checkId || '').trim() || 'check';
  return { cases: [{ id, signature: formatSignature(pool, headline) }], incomplete: false };
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
  signal = null,
  environmentFailed = false,
  nodeMajor,
  platform,
  arch,
}) {
  const context = buildFailureContext(checkId, { nodeMajor, platform, arch });
  if (timedOut || interrupted || Boolean(signal) || environmentFailed) {
    return { version: 1, comparable: false, context, cases: [] };
  }
  const { cases, incomplete } = extractFailureCases(logText, { checkId, root });
  if (!cases.length || incomplete) {
    return { version: 1, comparable: false, context, cases: [] };
  }
  return { version: 1, comparable: true, context, cases };
}

export function buildFailureEvidenceFromFile({
  checkId,
  logPath,
  root,
  timedOut = false,
  interrupted = false,
  signal = null,
  environmentFailed = false,
  maxBytes = MAX_LOG_BYTES,
  nodeMajor,
  platform,
  arch,
}) {
  const context = buildFailureContext(checkId, { nodeMajor, platform, arch });
  if (timedOut || interrupted || Boolean(signal) || environmentFailed) {
    return { version: 1, comparable: false, context, cases: [] };
  }
  try {
    const stats = fs.statSync(logPath);
    if (stats.size > maxBytes) {
      return { version: 1, comparable: false, context, cases: [] };
    }
    return buildFailureEvidence({
      checkId,
      logText: fs.readFileSync(logPath, 'utf8'),
      root,
      timedOut,
      interrupted,
      signal,
      environmentFailed,
      nodeMajor,
      platform,
      arch,
    });
  } catch {
    return { version: 1, comparable: false, context, cases: [] };
  }
}
