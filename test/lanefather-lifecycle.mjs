// Local acceptance against the real installed Lanefather and a private Git/Store.
// No project lane records, remotes or installed commands are changed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { kitRoot, tempRepository } from './fixtures.mjs';
import { syncHooks } from '../src/hooks.mjs';

const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lifecycle-'));
let repo, server;
const run = (file, args, cwd, env, { allowFail = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', data => { text += data; });
  child.stderr.on('data', data => { text += data; });
  child.on('error', reject);
  child.on('close', status => (status === 0 || allowFail) ? resolve({ status, text }) : reject(new Error(`${file} ${args.join(' ')}: ${status}\n${text}`)));
});
try {
  await run('bun', ['pm', 'pack', '--destination', archive], kitRoot, process.env);
  const tar = fs.readFileSync(path.join(archive, fs.readdirSync(archive).find(name => name.endsWith('.tgz'))));
  server = http.createServer((request, response) => response.end(tar));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  repo = tempRepository({
    'package.json': { name: 'generic-lane-consumer', type: 'module', devDependencies: {
      '@maxvyshniakov/package-kit': `http://127.0.0.1:${server.address().port}/package-kit.tgz`,
    } },
    '.gitignore': 'node_modules/\n.claude/\n',
    'README.md': 'original fixture\n',
    '.lanefather.toml': `project="arbitrary-consumer"\nstate_dir=${JSON.stringify(path.join(archive, 'lanes'))}\n[checks]\nverify=".githooks/lane-check"\nslot_env="PACKAGE_KIT_SLOT"\n`,
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'arbitrary command',command:['-e',"console.log('validated')"]}]}};`,
  }, { git: true });
  const env = { ...repo.env };
  for (const key of Object.keys(env)) if (/^(LANEFATHER_|STRAYLIGHT_)/.test(key)) delete env[key];
  env.LANEFATHER_CAP = '3'; env.LANEFATHER_LOAD15 = '0'; env.LANEFATHER_DISK_FREE_GB = '500';
  await run('bun', ['install'], repo.root, env);
  const saved = console.log;
  try { console.log = () => {}; syncHooks(repo.root); } finally { console.log = saved; }
  repo.git('add', '.'); repo.git('commit', '-qm', 'fixture adapter configured');
  const integration = path.join(repo.root, '.claude/worktrees/integration');
  repo.git('worktree', 'add', '-b', 'integrate/fixture', integration, 'HEAD');
  const { text: output } = await run('lanefather', ['start', 'fixture-adapter', '--ticket', 'none', '--base', 'integrate/fixture',
    '--claims', 'README.md', '--create'], repo.root, env);
  const state = path.join(archive, 'lanes');
  const recordFile = path.join(state, 'fixture-adapter.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.ok(output.includes('fixture-adapter'));
  fs.writeFileSync(path.join(record.worktree, 'README.md'), 'updated fixture\n');
  repo.git('-C', record.worktree, 'add', 'README.md');
  repo.git('-C', record.worktree, 'commit', '-qm', 'document fixture change');
  await run('lanefather', ['check', 'fixture-adapter', '--slots', '1'], record.worktree, env);
  const receipt = JSON.parse(fs.readFileSync(path.join(state, 'fixture-adapter.receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'green');
  assert.equal(receipt.check_results['verify:arbitrary%20command'].status, 'passed');
  fs.writeFileSync(path.join(integration, 'integration.md'), 'independent concurrent change\n');
  repo.git('-C', integration, 'add', 'integration.md');
  repo.git('-C', integration, 'commit', '-qm', 'concurrent integration work');
  await run('lanefather', ['land', 'fixture-adapter', '--slots', '1'], repo.root, env);
  const finished = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(finished.status, 'done');
  assert.equal(finished.post_merge.status, 'green');
  const post = JSON.parse(fs.readFileSync(finished.post_merge.receipt, 'utf8'));
  assert.equal(post.results[0].status, 'passed');
  assert.ok(post.results[0].report, 'a changed integration tree must actually rerun checks');
  assert.equal(fs.existsSync(record.worktree), false);
  assert.equal(finished.overrides.length, 0);

  // Verify real Lanefather failure_evidence v1 classification:
  // 1) Pre-existing failure on base with volatile path/timestamp/port/duration classifies as GREEN (`pre-existing`).
  // 2) Different failure message on candidate stays RED (`unclassified`).
  const baseFailScript = `console.error('Error at ' + process.cwd() + '/src/a.mjs:10 on http://127.0.0.1:' + (41000 + (process.pid % 1000)) + ' at ' + new Date().toISOString() + ' in 42ms'); console.error('AssertionError: pre-existing base mismatch'); process.exit(1)`;
  fs.writeFileSync(
    path.join(integration, 'package-kit.config.mjs'),
    `export default {verify:{steps:[{name:'unit',command:['-e',${JSON.stringify(baseFailScript)}]}]}};`,
  );
  repo.git('-C', integration, 'add', 'package-kit.config.mjs');
  repo.git('-C', integration, 'commit', '-qm', 'introduce pre-existing base failure');

  await run('lanefather', ['start', 'pre-existing-lane', '--ticket', 'none', '--base', 'integrate/fixture',
    '--claims', 'README.md', '--create'], repo.root, env);
  const preRecord = JSON.parse(fs.readFileSync(path.join(state, 'pre-existing-lane.json'), 'utf8'));
  fs.writeFileSync(path.join(preRecord.worktree, 'README.md'), 'unrelated edit on failing base\n');
  repo.git('-C', preRecord.worktree, 'add', 'README.md');
  repo.git('-C', preRecord.worktree, 'commit', '-qm', 'unrelated edit');
  await run('lanefather', ['check', 'pre-existing-lane', '--slots', '1'], preRecord.worktree, env);
  const preReceipt = JSON.parse(fs.readFileSync(path.join(state, 'pre-existing-lane.receipt.json'), 'utf8'));
  assert.equal(preReceipt.status, 'green', `expected pre-existing failure to classify green: ${JSON.stringify(preReceipt)}`);
  assert.equal(preReceipt.raw_status, 'red');
  assert.equal(preReceipt.classification.checks[0].class, 'pre-existing');
  assert.equal(preReceipt.classification.checks[0].failure_comparison.version, 1);

  await run('lanefather', ['start', 'different-failure-lane', '--ticket', 'none', '--base', 'integrate/fixture',
    '--claims', 'package-kit.config.mjs', '--create'], repo.root, env);
  const diffRecord = JSON.parse(fs.readFileSync(path.join(state, 'different-failure-lane.json'), 'utf8'));
  fs.writeFileSync(
    path.join(diffRecord.worktree, 'package-kit.config.mjs'),
    `export default {verify:{steps:[{name:'unit',command:['-e',"console.error('AssertionError: brand new candidate failure'); process.exit(1)"]}]}};`,
  );
  repo.git('-C', diffRecord.worktree, 'add', 'package-kit.config.mjs');
  repo.git('-C', diffRecord.worktree, 'commit', '-qm', 'different candidate failure');
  const diffRun = await run('lanefather', ['check', 'different-failure-lane', '--slots', '1'], diffRecord.worktree, env, { allowFail: true });
  assert.notEqual(diffRun.status, 0, 'different candidate failure must fail lanefather check');
  const diffReceipt = JSON.parse(fs.readFileSync(path.join(state, 'different-failure-lane.receipt.json'), 'utf8'));
  assert.equal(diffReceipt.status, 'red');
  assert.equal(diffReceipt.classification.checks[0].class, 'unclassified');

  // 3) Candidate keeping the exact pre-existing base failure AND adding an extra failing case must stay RED (`unclassified`).
  const basePlusExtraScript = `console.error('FAIL  src/base.test.ts > suite > pre-existing'); console.error('AssertionError: pre-existing base mismatch'); console.error('FAIL  src/new.test.ts > suite > candidate regression'); console.error('AssertionError: new candidate error'); process.exit(1)`;
  const structuredBaseScript = `console.error('FAIL  src/base.test.ts > suite > pre-existing'); console.error('AssertionError: pre-existing base mismatch'); process.exit(1)`;
  fs.writeFileSync(
    path.join(integration, 'package-kit.config.mjs'),
    `export default {verify:{steps:[{name:'unit',command:['-e',${JSON.stringify(structuredBaseScript)}]}]}};`,
  );
  repo.git('-C', integration, 'add', 'package-kit.config.mjs');
  repo.git('-C', integration, 'commit', '-qm', 'structured pre-existing base failure');

  await run('lanefather', ['start', 'base-plus-extra-lane', '--ticket', 'none', '--base', 'integrate/fixture',
    '--claims', 'package-kit.config.mjs', '--after', 'different-failure-lane', '--create'], repo.root, env);
  const extraRecord = JSON.parse(fs.readFileSync(path.join(state, 'base-plus-extra-lane.json'), 'utf8'));
  fs.writeFileSync(
    path.join(extraRecord.worktree, 'package-kit.config.mjs'),
    `export default {verify:{steps:[{name:'unit',command:['-e',${JSON.stringify(basePlusExtraScript)}]}]}};`,
  );
  repo.git('-C', extraRecord.worktree, 'add', 'package-kit.config.mjs');
  repo.git('-C', extraRecord.worktree, 'commit', '-qm', 'keep base failure and add candidate regression');
  const extraRun = await run('lanefather', ['check', 'base-plus-extra-lane', '--slots', '1'], extraRecord.worktree, env, { allowFail: true });
  assert.notEqual(extraRun.status, 0, 'candidate keeping base failure plus extra failure must fail lanefather check');
  const extraReceipt = JSON.parse(fs.readFileSync(path.join(state, 'base-plus-extra-lane.receipt.json'), 'utf8'));
  assert.equal(extraReceipt.status, 'red');
  assert.equal(extraReceipt.classification.checks[0].class, 'unclassified');

  console.log(JSON.stringify({ registration: 'real private Store', checks: receipt.check_results,
    post_merge: finished.post_merge.status, post_merge_reran_after_integration_change: true, review: 'actual documentation-only exemption',
    pre_existing_classification: preReceipt.classification.checks[0].class,
    different_failure_classification: diffReceipt.classification.checks[0].class,
    base_plus_extra_classification: extraReceipt.classification.checks[0].class,
    status: finished.status, force_used: false }, null, 2));
} finally {
  if (repo) repo.cleanup();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(archive, { recursive: true, force: true });
}
