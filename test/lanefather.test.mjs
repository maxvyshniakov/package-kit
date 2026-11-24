import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { kitRoot, tempRepository } from './fixtures.mjs';
import { managedHooks, hookIssues, syncHooks } from '../src/hooks.mjs';

const adapter = path.join(kitRoot, 'src/lanefather.mjs');

test('the adapter plans arbitrary configured checks without executing them', () => {
  const repo = tempRepository({
    'package.json': { name: 'unrelated-project', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'compile widgets',command:['-e',"require('fs').writeFileSync('ran','yes')"]},
      {name:'validate, records',command:['-e','process.exit(0)'],needs:['compile widgets']}
    ],browser:[{name:'inspect pixels',command:['-e','process.exit(0)']}]}};`,
    'input.txt': 'before',
  }, { git: true });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.root, 'input.txt'), 'after');
    const result = spawnSync(process.execPath, [adapter, '--changed', '--base', base, '--plan', '--json'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.v, 1);
    assert.equal(plan.full, true);
    assert.deepEqual(plan.paths, ['input.txt']);
    assert.deepEqual(plan.suites, ['verify', 'browser']);
    assert.deepEqual(plan.checks.map(({ id, suite }) => [id, suite]), [
      ['verify:compile%20widgets', 'verify'], ['verify:validate%2C%20records', 'verify'],
      ['browser:inspect%20pixels', 'browser'],
    ]);
    assert.equal(fs.existsSync(path.join(repo.root, 'ran')), false);
  } finally { repo.cleanup(); }
});

test('selected checks run their real dependencies and report failure and blocked work', () => {
  const repo = tempRepository({
    'package.json': { name: 'another-project', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'prepare',command:['-e',"console.log('prepared')"]},
      {name:'broken',command:['-e',"console.error('actual failure');process.exit(7)"],needs:['prepare']},
      {name:'later',command:['-e',"require('fs').writeFileSync('must-not-run','yes')"],needs:['broken']}
    ]}};`,
  }, { git: true });
  try {
    const result = spawnSync(process.execPath, [adapter, '--checks', 'verify:later', '--keep-going', '--jobs', '1'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const reportPath = /^Verification report: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(reportPath, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.v, 1);
    assert.equal(report.head, repo.git('rev-parse', 'HEAD'));
    assert.equal(report.tree, repo.git('rev-parse', 'HEAD^{tree}'));
    assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
      ['verify:prepare', 'passed'], ['verify:broken', 'failed'], ['verify:later', 'blocked'],
    ]);
    assert.deepEqual(report.checks[2].blocked_by, ['verify:broken']);
    assert.match(fs.readFileSync(report.checks[1].log, 'utf8'), /actual failure/);
    assert.equal(fs.existsSync(path.join(repo.root, 'must-not-run')), false);
  } finally { repo.cleanup(); }
});

test('a full run keeps browser work after validation and reports a committed tree', () => {
  const repo = tempRepository({
    'package.json': { name: 'opaque-fixture', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'build',command:['-e',"require('fs').writeFileSync('result','valid')"]}
    ],browser:[{name:'build',command:['-e',"if(require('fs').readFileSync('result','utf8')!=='valid')process.exit(2)"]}]}};`,
    '.gitignore': 'result\n',
  }, { git: true });
  try {
    const result = spawnSync(process.execPath, [adapter, '--keep-going', '--jobs', '1'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(/^Verification report: (.+)$/m.exec(result.stdout)[1], 'utf8'));
    assert.equal(report.environment, null);
    assert.deepEqual(report.checks.map(({ id, status }) => [id, status]),
      [['verify:build', 'passed'], ['browser:build', 'passed']]);
  } finally { repo.cleanup(); }
});

test('a successful command that changes committed inputs cannot produce green evidence', () => {
  const repo = tempRepository({
    'package.json': { name: 'mutating-fixture', type: 'module' },
    'input.txt': 'original',
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'mutate',command:['-e',"require('fs').writeFileSync('input.txt','changed')"]}]}};`,
  }, { git: true });
  try {
    const result = spawnSync(process.execPath, [adapter, '--jobs', '1'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(/^Verification report: (.+)$/m.exec(result.stdout)[1], 'utf8'));
    assert.equal(report.environment.class, 'inputs-changed');
    assert.equal(report.checks[0].status, 'void');
  } finally { repo.cleanup(); }
});


test('hooks sync supplies one shared verification entry for configured lane consumers', () => {
  const repo = tempRepository({ 'package.json': { name: 'unrelated-consumer' },
    '.lanefather.toml': '[checks]\nverify=".githooks/lane-check"\n' });
  try {
    const saved = console.log;
    try { console.log = () => {}; syncHooks(repo.root); }
    finally { console.log = saved; }
    const entry = path.join(repo.root, '.githooks/lane-check');
    assert.ok(fs.existsSync(entry), 'a clean smoke checkout needs a tracked preparation entry');
    assert.equal(fs.readFileSync(entry, 'utf8'), managedHooks({ lane: true })['lane-check']);
    assert.ok(fs.statSync(entry).mode & 0o111);
    assert.deepEqual(hookIssues(repo.root), []);
    assert.equal(managedHooks()['lane-check'], undefined, 'other consumers keep their existing hooks');
  } finally { repo.cleanup(); }
});


test('the managed entry installs a clean linked checkout before planning its own locked adapter', async () => {
  // A Bun folder dependency locks a path relative to the original checkout;
  // use a packed HTTP dependency, like the registry, to test relocated worktrees.
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lane-pack-'));
  let repo, server, linked;
  const run = (command, args, cwd, env) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => {
      try { assert.equal(status, 0, stdout + stderr); resolve({ stdout, stderr }); } catch (error) { reject(error); }
    });
  });
  try {
    await run('bun', ['pm', 'pack', '--destination', archive], kitRoot, process.env);
    const tarball = fs.readFileSync(path.join(archive, fs.readdirSync(archive).find(name => name.endsWith('.tgz'))));
    server = http.createServer((request, response) => { response.setHeader('Content-Type', 'application/octet-stream'); response.end(tarball); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    repo = tempRepository({
      'package.json': { name: 'fresh-checkout-fixture', type: 'module', devDependencies: { '@maxvyshniakov/package-kit': `http://127.0.0.1:${server.address().port}/package-kit.tgz` } },
      '.gitignore': 'node_modules/\n.claude/\n',
      '.lanefather.toml': '[checks]\nverify=".githooks/lane-check"\n',
      'package-kit.config.mjs': "export default {verify:{steps:[{name:'probe',command:['-e',\"console.log('ran check')\"]}]}};",
    }, { git: true });
    linked = path.join(repo.root, '.claude/worktrees/fresh');
    await run('bun', ['install'], repo.root, repo.env);
    const saved = console.log;
    try { console.log = () => {}; syncHooks(repo.root); } finally { console.log = saved; }
    repo.git('add', '.'); repo.git('commit', '-qm', 'fixture connection');
    const base = repo.git('rev-parse', 'HEAD');
    repo.git('worktree', 'add', '--detach', linked, base);
    assert.equal(fs.existsSync(path.join(linked, 'node_modules')), false);
    const result = await run(path.join(linked, '.githooks/lane-check'), ['--changed', '--base', base, '--plan', '--json'], linked, repo.env);
    assert.equal(JSON.parse(result.stdout).checks[0].id, 'verify:probe');
    assert.ok(fs.existsSync(path.join(linked, 'node_modules/@maxvyshniakov/package-kit/src/lanefather.mjs')));
    assert.equal(repo.git('-C', linked, 'status', '--porcelain'), '');
  } finally {
    if (repo) { if (linked && fs.existsSync(linked)) repo.git('worktree', 'remove', '--force', linked); repo.cleanup(); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(archive, { recursive: true, force: true });
  }
});

test('the packaged command explains its contract without project configuration or a lease', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lane-help-'));
  try {
    const result = spawnSync(process.execPath, [adapter, '--help'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /package-kit-lane.*--changed/);
    assert.match(result.stdout, /--checks/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('cancellation never reports a zero-exiting interrupted step as passed', async () => {
  const repo = tempRepository({
    'package.json': { name: 'interrupted-project', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'waiting',command:['-e',"process.on('SIGTERM',()=>process.exit(0)); console.log('ready-for-cancel'); setInterval(()=>{},1000)"]}]}};`,
  }, { git: true });
  let child;
  try {
    child = spawn(process.execPath, [adapter, '--jobs', '1'], { cwd: repo.root, env: repo.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', cancelled = false;
    child.stdout.on('data', data => {
      stdout += data;
      if (!cancelled && stdout.includes('ready-for-cancel')) { cancelled = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    assert.equal(status, 143, stdout + stderr);
    const report = JSON.parse(fs.readFileSync(/^Verification report: (.+)$/m.exec(stdout)[1], 'utf8'));
    assert.equal(report.interrupted, 'SIGTERM');
    assert.equal(report.checks[0].status, 'cancelled');
  } finally { if (child?.exitCode === null) child.kill('SIGTERM'); repo.cleanup(); }
});

test('ambient Git bindings cannot redirect verification to another repository', () => {
  const foreign = tempRepository({ 'other.txt': 'foreign' }, { git: true });
  const repo = tempRepository({
    'package.json': { name: 'binding-fixture', type: 'module' },
    'input.txt': 'before',
    'package-kit.config.mjs': "export default {verify:{steps:[{name:'probe',command:['-e','process.exit(0)']}]}};",
  }, { git: true });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.root, 'input.txt'), 'after');
    const result = spawnSync(process.execPath, [adapter, '--changed', '--base', base, '--plan', '--json'],
      { cwd: repo.root, env: { ...repo.env, GIT_DIR: path.join(foreign.root, '.git'), GIT_WORK_TREE: foreign.root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).paths, ['input.txt']);
  } finally { foreign.cleanup(); repo.cleanup(); }
});

test('unknown selections and invalid worker budgets are refused before running checks', () => {
  const repo = tempRepository({
    'package.json': { name: 'refusal-fixture', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'probe',command:['-e',"require('fs').writeFileSync('ran','yes')"]}]}};`,
  }, { git: true });
  try {
    for (const args of [['--checks', 'missing'], ['--suites', 'missing'], ['--jobs=0'], ['--jobs=Infinity'],
      ['--jobs=1.5'], ['--checks', 'verify:probe', '--suites', 'verify'], ['--unknown']]) {
      const result = spawnSync(process.execPath, [adapter, ...args], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
      assert.equal(result.status, 1, args.join(' '));
    }
    assert.equal(fs.existsSync(path.join(repo.root, 'ran')), false);
  } finally { repo.cleanup(); }
});

test('a timed-out command has a failed report and blocks its dependants', () => {
  const repo = tempRepository({
    'package.json': { name: 'timeout-fixture', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'waiting',timeout:0.001,command:['-e','setInterval(()=>{},1000)']},
      {name:'later',needs:['waiting'],command:['-e','process.exit(0)']}
    ]}};`,
  }, { git: true });
  try {
    const result = spawnSync(process.execPath, [adapter, '--jobs', '1'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(/^Verification report: (.+)$/m.exec(result.stdout)[1], 'utf8'));
    assert.equal(report.checks[0].status, 'failed');
    assert.equal(report.checks[0].timed_out, true);
    assert.equal(report.checks[1].status, 'blocked');
  } finally { repo.cleanup(); }
});

test('keep-going collects independent results after a failure and blocks only dependants', () => {
  const repo = tempRepository({
    'package.json': { name: 'collect-fixture', type: 'module' },
    '.gitignore': 'collected\n',
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'broken',command:['-e','process.exit(7)']},
      {name:'independent',command:['-e',"setTimeout(()=>require('fs').writeFileSync('collected','yes'),100)"]},
      {name:'dependent',needs:['broken'],command:['-e','process.exit(0)']}
    ]}};`,
  }, { git: true });
  try {
    const result = spawnSync(process.execPath, [adapter, '--keep-going', '--jobs', '1'],
      { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(fs.readFileSync(/^Verification report: (.+)$/m.exec(result.stdout)[1], 'utf8'));
    assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
      ['verify:broken','failed'], ['verify:independent','passed'], ['verify:dependent','blocked'],
    ]);
    assert.equal(fs.readFileSync(path.join(repo.root, 'collected'), 'utf8'), 'yes');
    assert.deepEqual(report.checks[2].blocked_by, ['verify:broken']);
  } finally { repo.cleanup(); }
});

test('the adapter leases the slots Lanefather gives it with --jobs, no more than the configured ones', async () => {
  const { laneLeaseSlots } = await import('../src/lanefather.mjs');
  const config = { verify: { slots: 3, browserSlots: 2 } };
  const verify = [{ suite: 'verify' }], both = [{ suite: 'verify' }, { suite: 'browser' }], browser = [{ suite: 'browser' }];
  // Lanefather decided one job: one slot, not the configured three.
  assert.equal(laneLeaseSlots(config, both, 1), 1);
  assert.equal(laneLeaseSlots(config, both, 2), 2);
  assert.equal(laneLeaseSlots(config, both, 8), 3);
  assert.equal(laneLeaseSlots(config, browser, 8), 2);
  // Without --jobs, the configured slots of the selected suites, as before.
  assert.equal(laneLeaseSlots(config, both, Infinity), 3);
  assert.equal(laneLeaseSlots(config, verify, Infinity), 3);
  // Where a slot has memory, a lease holds the largest step: 6 GiB at 5 GiB a slot takes 2.
  const heavy = [{ suite: 'browser', step: { memory: 6 } }, { suite: 'verify', step: { memory: 1 } }];
  assert.equal(laneLeaseSlots(config, heavy, 1, { gibPerSlot: 5 }), 2);
  assert.equal(laneLeaseSlots(config, heavy, 1), 1, 'a machine without slot memory: the jobs');
});

function stubLanefather(dir, script) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'lanefather');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return binDir;
}

test('a passing full run stamps the verified tree via lanefather stamp record', () => {
  const repo = tempRepository({
    'package.json': { name: 'stamp-fixture', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'ok',command:['-e','process.exit(0)']}]}};`,
  }, { git: true });
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lf-stub-'));
  try {
    const head = repo.git('rev-parse', 'HEAD');
    const tree = repo.git('rev-parse', 'HEAD^{tree}');
    const calls = path.join(tools, 'calls.log');
    const binDir = stubLanefather(tools, `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}\necho "Verified tree ${tree} stamped."`);
    const env = { ...repo.env, PATH: `${binDir}:${repo.env.PATH}` };
    const result = spawnSync(process.execPath, [adapter, '--jobs', '1'],
      { cwd: repo.root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^Verified tree ${tree} stamped\\.$`, 'm'));
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), `stamp record ${head}`);
  } finally {
    repo.cleanup();
    fs.rmSync(tools, { recursive: true, force: true });
  }
});

test('partial, failed and inputs-changed runs do not stamp the verified tree', () => {
  const repo = tempRepository({
    'package.json': { name: 'no-stamp-fixture', type: 'module' },
    'input.txt': 'before',
    'package-kit.config.mjs': `export default {verify:{steps:[
      {name:'ok',command:['-e','process.exit(0)']},
      {name:'fail',command:['-e','process.exit(1)']},
    ]}};`,
  }, { git: true });
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lf-nostamp-'));
  try {
    const calls = path.join(tools, 'calls.log');
    const binDir = stubLanefather(tools, `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}\necho "Verified tree deadbeef stamped."`);
    const env = { ...repo.env, PATH: `${binDir}:${repo.env.PATH}` };
    // Partial (--checks) passes but must not stamp.
    const partialChecks = spawnSync(process.execPath, [adapter, '--checks', 'verify:ok', '--jobs', '1'],
      { cwd: repo.root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(partialChecks.status, 0, partialChecks.stdout + partialChecks.stderr);
    assert.doesNotMatch(partialChecks.stdout, /^Verified tree /m);
    // Partial (--suites) fails here too, and even if passing must not stamp; test failed full run as well.
    const failedFull = spawnSync(process.execPath, [adapter, '--jobs', '1'],
      { cwd: repo.root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(failedFull.status, 1, failedFull.stdout + failedFull.stderr);
    assert.doesNotMatch(failedFull.stdout, /^Verified tree /m);
    assert.equal(fs.existsSync(calls), false, 'lanefather stamp must not be invoked for partial or failed runs');
  } finally {
    repo.cleanup();
    fs.rmSync(tools, { recursive: true, force: true });
  }
});

test('stamping degrades silently when lanefather is older or unavailable', async () => {
  const { stampVerifiedTree } = await import('../src/lanefather.mjs');
  const repo = tempRepository({
    'package.json': { name: 'compat-fixture', type: 'module' },
    'package-kit.config.mjs': `export default {verify:{steps:[{name:'ok',command:['-e','process.exit(0)']}]}};`,
  }, { git: true });
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'package-kit-lf-compat-'));
  try {
    // Older lanefather without `stamp` subcommand exits 2 with stderr usage message.
    const oldBinDir = stubLanefather(tools, `echo "lanefather: error: argument command: invalid choice: 'stamp'" >&2\nexit 2`);
    const oldEnv = { ...repo.env, PATH: `${oldBinDir}:${repo.env.PATH}` };
    const result = spawnSync(process.execPath, [adapter, '--jobs', '1'],
      { cwd: repo.root, env: oldEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^Verification report: /m);
    assert.doesNotMatch(result.stdout, /^Verified tree /m);
    assert.equal(result.stderr, '');
    // Absent binary degrades cleanly without throwing.
    const missing = stampVerifiedTree(repo.root, 'HEAD', { env: repo.env, bin: path.join(tools, 'no-such-lanefather') });
    assert.deepEqual(missing, { stamped: false, line: '' });
  } finally {
    repo.cleanup();
    fs.rmSync(tools, { recursive: true, force: true });
  }
});
