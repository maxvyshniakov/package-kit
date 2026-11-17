import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedGitEnv, tempRepository, workspaceFiles, rootPackageFiles, pyprojectFiles } from './fixtures.mjs';
import { parsePrereleaseOptions, prereleaseVersion, archiveCommit, runPrerelease } from '../src/publish-prerelease.mjs';

test('prerelease requires explicit non-latest tag and rejects ambiguous release options', () => {
 assert.deepEqual(parsePrereleaseOptions(['--prerelease','integration','--dist-tag','integration','--dry-run']), {preid:'integration',tag:'integration',dryRun:true});
 for(const args of [ ['--prerelease','integration'], ['--prerelease','integration','--dist-tag','latest'], ['--prerelease','integration','--dist-tag','beta','--resume'], ['--prerelease','bad/name','--dist-tag','beta'] ]) assert.throws(()=>parsePrereleaseOptions(args));
});
test('counter follows newest stable minor and matching preid only', () => {
 assert.deepEqual(prereleaseVersion({current:'0.42.2',published:['0.42.3','0.43.0-integration.4','0.43.0-beta.99'],unreleased:'',preid:'integration'}), {base:'0.43.0',level:'minor',version:'0.43.0-integration.5'});
 assert.equal(prereleaseVersion({current:'1.4.0',published:[],unreleased:'### Breaking\n\n- Removed API',preid:'preview'}).version,'2.0.0-preview.1');
});
test('archive uses captured commit even after HEAD advances', () => {
 const root=mkdtempSync(path.join(tmpdir(),'rk-pre-src-')), into=mkdtempSync(path.join(tmpdir(),'rk-pre-out-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:isolatedGitEnv()}).trim();
 try {
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  writeFileSync(path.join(root,'value'),'captured');git('add','value');git('commit','-qm','first');const commit=git('rev-parse','HEAD');
  writeFileSync(path.join(root,'value'),'new');git('commit','-qam','second');
  archiveCommit({root,commit,into});assert.equal(readFileSync(path.join(into,'value'),'utf8'),'captured');
  assert.throws(()=>archiveCommit({root,commit:'HEAD',into}),/full commit SHA/);
 } finally {rmSync(root,{recursive:true,force:true});rmSync(into,{recursive:true,force:true});}
});

test('programmatic prereleases reject latest before reading a checkout or touching registry', async () => {
 await assert.rejects(runPrerelease({root:'/does-not-exist'}, {preid:'integration',tag:'latest'}), /non-latest/);
});
test('dirty checkout is rejected before TLS, credentials or upload', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'rk-pre-dirty-'));
 try {
  execFileSync('git',['init','-q'],{cwd:root,env:isolatedGitEnv()});writeFileSync(path.join(root,'uncommitted'),'content');
  await assert.rejects(runPrerelease({root}, {preid:'integration',tag:'integration'}), /uncommitted/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('publication uploads the archived manifest with immutable provenance and an explicit tag', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'rk-pre-flow-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env:isolatedGitEnv()}).trim();
 const calls=[];let published=false, uploaded;
 try {
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@example/kit',version:'0.2.0'}));
  writeFileSync(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## Unreleased\n\n- New API.\n\n## 0.2.0 - 2026-01-01\n\n- Previous API.\n');
  git('add','.');git('commit','-qm','captured');const sha=git('rev-parse','HEAD');
  const code=await runPrerelease({root,changelog:{}},{preid:'integration',tag:'integration'}, {
   tls:()=>{calls.push('tls');return true;},tokenSource:()=>({token:'fixture'}),
   request:async()=>{calls.push('registry');return {ok:true,json:async()=>({versions:{'0.2.0':{},...(published?{'0.3.0-integration.1':{gitHead:sha}}:{})},'dist-tags':{latest:'0.2.0',...(published?{integration:'0.3.0-integration.1'}:{})}})};},
   execute:(cmd,args,opts)=>{
    assert.equal(cmd,'bun');calls.push(args[0]);assert.notEqual(opts.cwd,root);
    if(args[0]==='install') {
      assert.ok(args.includes('--ignore-scripts'));assert.equal(JSON.parse(readFileSync(path.join(opts.cwd,'package.json'),'utf8')).version,'0.2.0');
      writeFileSync(path.join(root,'later'),'not in snapshot');git('add','later');git('commit','-qm','advance HEAD');
    } else if(args[0]==='pm') {
      execFileSync(cmd,args,{...opts,stdio:'pipe'});
    } else {
      assert.ok(args.includes('--tag=integration'));
      uploaded=JSON.parse(readFileSync(path.join(opts.cwd,'package.json'),'utf8'));published=true;
    }
   }
  });
  assert.equal(code,0);assert.equal(uploaded.gitHead,sha);assert.equal(uploaded.version,'0.3.0-integration.1');
  assert.equal(JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version,'0.2.0');
  assert.equal(git('tag'),'');assert.deepEqual(calls,['tls','registry','install','pm','publish','registry']);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('workspace dry run packs only the selected package and cleans its snapshot', async () => {
 const repo = tempRepository(workspaceFiles(), {git:true});
 let snapshot;
 const executions=[];
 try {
  const result=await runPrerelease({root:repo.root,changelog:{}}, {preid:'preview',tag:'preview',dryRun:true}, {
   tls:()=>true, tokenSource:()=>({token:'fixture'}),
   request:async()=>({status:404}),
   execute:(cmd,args,opts)=>{
    executions.push(args);
    if(args[0]==='install') snapshot=opts.cwd;
    else if(args[0]==='pm') execFileSync(cmd,args,{...opts,stdio:'pipe'});
    else {
     assert.equal(opts.cwd,path.join(snapshot,'packages/example'));
     assert.ok(args.includes('--dry-run'));
     assert.ok(args.includes('--tag=preview'));
     const manifest=JSON.parse(readFileSync(path.join(opts.cwd,'package.json'),'utf8'));
     assert.equal(manifest.version,'0.3.0-preview.1');
    }
   },
  });
  assert.equal(result,0);
  assert.equal(executions.length,3);
  assert.throws(()=>readFileSync(path.join(snapshot,'package.json')), {code:'ENOENT'});
  assert.equal(repo.git('status','--porcelain'),'');
 } finally {repo.cleanup();}
});


test('new packages cannot acquire latest through their first prerelease', async () => {
 const repo=tempRepository(rootPackageFiles(), {git:true});
 try {
  await assert.rejects(runPrerelease({root:repo.root,changelog:{}}, {preid:'integration',tag:'integration'}, {
   tls:()=>true, tokenSource:()=>({token:'fixture'}), request:async()=>({status:404}),
   execute:()=>{throw new Error('upload or install must not start');},
  }), /established stable latest/);
 } finally {repo.cleanup();}
});

test('configured Python version source rejects a tooling npm manifest before credentials', async () => {
 const repo=tempRepository(pyprojectFiles({'package.json':{name:'tooling',version:'1.0.0'}}), {git:true});
 try {
  await assert.rejects(runPrerelease({root:repo.root,changelog:{versionSource:'pyproject.toml'}}, {preid:'integration',tag:'integration'}, {
   tls:()=>{throw new Error('TLS must not run');}, tokenSource:()=>{throw new Error('credentials must not be read');},
  }), /npm packages/);
 } finally {repo.cleanup();}
});
