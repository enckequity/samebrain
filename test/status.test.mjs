import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t){
 const temp=mkdtempSync(join(tmpdir(),'samebrain-status-'));
 t.after(()=>rmSync(temp,{recursive:true}));
 const repo=join(temp,'repo'),home=join(temp,'home');
 mkdirSync(join(repo,'bin'),{recursive:true});mkdirSync(home);
 copyFileSync(join(source,'bin/status.mjs'),join(repo,'bin/status.mjs'));
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.hooksPath',join(temp,'no-hooks'));
 git('add','bin/status.mjs');git('commit','-m','base');
 const run=()=>{const r=spawnSync(process.execPath,[join(repo,'bin/status.mjs')],{cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,HOME:home,USERPROFILE:home}});assert.equal(r.status,0,r.stderr);return r.stdout;};
 return{repo,home,git,run};
}

test('status reports divergence and dirty work without fetching or changing the index',t=>{
 const f=fixture(t),base=f.git('rev-parse','HEAD');
 f.git('remote','add','origin','https://example.invalid/never-fetch');
 f.git('update-ref','refs/remotes/origin/main',base);f.git('branch','--set-upstream-to=origin/main');
 assert.match(f.run(),/git: main, 0 ahead, 0 behind \(last fetched\), 0 uncommitted path/);
 f.git('checkout','-b','remote-fixture');writeFileSync(join(f.repo,'remote.txt'),'remote');f.git('add','remote.txt');f.git('commit','-m','remote');f.git('update-ref','refs/remotes/origin/main',f.git('rev-parse','HEAD'));f.git('checkout','main');
 writeFileSync(join(f.repo,'local.txt'),'local');f.git('add','local.txt');f.git('commit','-m','local');
 writeFileSync(join(f.repo,'pending.txt'),'unsaved');f.git('add','pending.txt');
 const before=readFileSync(join(f.repo,'.git/index'));
 assert.match(f.run(),/git: main, 1 ahead, 1 behind \(last fetched\), 1 uncommitted path/);
 assert.deepEqual(readFileSync(join(f.repo,'.git/index')),before);assert.equal(f.git('diff','--cached','--name-only'),'pending.txt');
});

test('status distinguishes missing upstream and reports stale or invalid caches without memory text',t=>{
 const f=fixture(t),cache=join(f.home,'.hindsight/samebrain-recall-cache');mkdirSync(cache,{recursive:true});
 writeFileSync(join(cache,'dev-global.json'),JSON.stringify({at:new Date(Date.now()-3*86400000).toISOString(),results:[{text:'private-memory-marker'}]}));
 writeFileSync(join(cache,'fresh.json'),JSON.stringify({at:new Date().toISOString()}));
 writeFileSync(join(cache,'invalid.json'),'{');writeFileSync(join(cache,'bad-date.json'),JSON.stringify({at:'not-a-date'}));
 const out=f.run();assert.match(out,/git: main, upstream unavailable/);assert.match(out,/recall dev-global: STALE, last refreshed 3d ago/);assert.match(out,/recall fresh: fresh/);assert.match(out,/recall invalid: invalid cache/);assert.match(out,/recall bad-date: invalid cache/);assert.doesNotMatch(out,/private-memory-marker/);
});

test('an invalid cache directory does not hide fleet status',t=>{
 const f=fixture(t);mkdirSync(join(f.home,'.hindsight'));writeFileSync(join(f.home,'.hindsight/samebrain-recall-cache'),'invalid');
 const out=f.run();assert.match(out,/cache directory unavailable/);assert.match(out,/machines: none seen yet/);
});
