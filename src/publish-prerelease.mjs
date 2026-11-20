// Publish one immutable committed tree under an explicit prerelease dist-tag.
// Never changes checkout versions, stable tags or Git refs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, nextVersion, parseChangelog, parseVersion } from './changelog.mjs';
import { changelogPackages } from './check-changelogs.mjs';
import { chooseVersionSource } from './version-source.mjs';
import { resolveToken } from './token.mjs';
import { runTlsGate } from './tls.mjs';
import { publishArguments, registryUrl } from './publish.mjs';

export function parsePrereleaseOptions(args) {
 const result={dryRun:false};
 for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--dry-run') result.dryRun=true;
  else if(arg==='--prerelease'||arg==='--dist-tag') {
   const key=arg==='--prerelease'?'preid':'tag';
   if(result[key]!==undefined) throw new Error(`Duplicate ${arg}`);
   result[key]=args[++i];
  } else if(arg.startsWith('--prerelease=')||arg.startsWith('--dist-tag=')) {
   const eq=arg.indexOf('='), flag=arg.slice(0,eq), key=flag==='--prerelease'?'preid':'tag';
   if(result[key]!==undefined) throw new Error(`Duplicate ${flag}`);
   result[key]=arg.slice(eq+1);
  } else throw new Error(`Unknown prerelease option: ${arg}`);
 }
 if(!/^[a-z][a-z0-9-]*$/.test(result.preid??'')) throw new Error('--prerelease needs a prerelease identifier');
 if(!/^[a-z][a-z0-9-]*$/.test(result.tag??'')||result.tag==='latest') throw new Error('--dist-tag must explicitly name a non-latest tag');
 return result;
}
export function prereleaseVersion({current,published,unreleased,preid}) {
 const releases=[current,...published.filter(v=>/^\d+\.\d+\.\d+$/.test(v))];
 const newest=releases.reduce((a,b)=>compareVersions(a,b)>=0?a:b);
 const breaking=/^###\s+Breaking\s*$/m.test(unreleased)||/^\s*-\s+Breaking:/m.test(unreleased);
 const level=breaking&&parseVersion(newest)[0]>=1?'major':'minor';
 const base=nextVersion(newest,level), prefix=`${base}-${preid}.`;
 const taken=published.filter(v=>v.startsWith(prefix)).map(v=>v.slice(prefix.length)).filter(v=>/^\d+$/.test(v)).map(Number);
 return {base,level,version:`${prefix}${taken.length?Math.max(...taken)+1:1}`};
}
export function archiveCommit({root,commit,into}) {
 if(!/^[0-9a-f]{40}$/.test(commit)) throw new Error('archiveCommit requires a full commit SHA');
 const tar=execFileSync('git',['archive','--format=tar',commit],{cwd:root,maxBuffer:1024*1024*1024});
 execFileSync('tar',['-x','-C',into],{input:tar});
}
export async function runPrerelease(config,options = {}, { tls = runTlsGate, tokenSource = resolveToken, request = fetch, execute = execFileSync } = {}) {
 // Revalidate programmatic callers as well as the CLI.
 const {preid,tag,dryRun}=parsePrereleaseOptions(['--prerelease',options.preid,'--dist-tag',options.tag,...(options.dryRun?['--dry-run']:[])]);
 const {root}=config;
 const {quickStart,versionSource}=config.changelog ?? {};
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 if(git('status','--porcelain')) throw new Error('Not publishing: the working tree has uncommitted changes');
 if(chooseVersionSource(root,versionSource)!=='package.json') throw new Error('Prerelease publishing uploads npm packages, not a configured Python version source');
 const head=git('rev-parse','HEAD');
 if(!tls({requireRegistry:true})) throw new Error('Not publishing: the TLS gate failed');
 const {token}=tokenSource();
 if(!token) throw new Error('GITHUB_TOKEN is unset and gh has no token');
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'repo-kit-prerelease-'));
 try {
  const checkout=path.join(scratch,'source');
  fs.mkdirSync(checkout);
  archiveCommit({root,commit:head,into:checkout});
  const [pkg,...others]=changelogPackages(checkout,{quickStart,versionSource});
  if(!pkg||others.length) throw new Error('Prerelease publishing requires exactly one npm package');
  const manifestPath=path.join(pkg.dir,'package.json');
  if(!fs.existsSync(manifestPath)) throw new Error('Prerelease publishing requires package.json');
  const metadata=async()=>{
   const response=await request(registryUrl(pkg.name),{headers:{Authorization:`Bearer ${token}`}});
   if(response.status===404)return {versions:{},'dist-tags':{}};
   if(!response.ok)throw new Error(`Registry lookup failed: ${response.status}`);
   return response.json();
  };
  const before=await metadata();
  const latest=before['dist-tags']?.latest;
  if(!dryRun && (!/^\d+\.\d+\.\d+$/.test(latest??'') || !before.versions?.[latest])) {
   throw new Error('Prerelease upload requires an established stable latest version; first publication may assign latest even with an explicit tag');
  }
  if(pkg.changelog===undefined) throw new Error('Prerelease publishing requires CHANGELOG.md');
  const {unreleased,errors}=parseChangelog(pkg.changelog);
  if(errors.length)throw new Error(`Malformed changelog: ${errors.join('; ')}`);
  const {version}=prereleaseVersion({current:pkg.version,published:Object.keys(before.versions??{}),unreleased,preid});
  const env={...process.env,GITHUB_TOKEN:token};
  execute('bun',['install','--frozen-lockfile','--ignore-scripts','--no-progress'],{cwd:checkout,stdio:'inherit',env});
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  fs.writeFileSync(manifestPath,JSON.stringify({...manifest,version,gitHead:head},null,2)+'\n');
  const archive=path.join(scratch,'package.tgz');
  execute('bun',['pm','pack',`--filename=${archive}`],{cwd:pkg.dir,stdio:'inherit',env});
  const packed=JSON.parse(execFileSync('tar',['-xOf',archive,'package/package.json'],{encoding:'utf8'}));
  if(packed.name!==pkg.name || packed.version!==version || packed.gitHead!==head) {
   throw new Error('Packed package identity or provenance differs from the captured prerelease');
  }
  const bunfig=path.join(checkout,'bunfig.toml');
  execute('bun',[...publishArguments(fs.existsSync(bunfig)?bunfig:undefined),archive,`--tag=${tag}`,...(dryRun?['--dry-run']:[])],{cwd:pkg.dir,stdio:'inherit',env});
  if(!dryRun) {
   const after=await metadata();
   if(after.versions?.[version]?.gitHead!==head)throw new Error(`Registry does not serve ${version} with the captured provenance`);
   if(after['dist-tags']?.[tag]!==version)throw new Error(`Registry dist-tag ${tag} does not name ${version}`);
   if(after['dist-tags']?.latest!==before['dist-tags']?.latest)throw new Error('Registry latest tag changed during prerelease publication; inspect concurrent publication before changing tags');
  }
  console.log(`${dryRun?'Dry run':'Published'}: ${pkg.name}@${version}, dist-tag ${tag}, gitHead ${head}`);
  return 0;
 } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
