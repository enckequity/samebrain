import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t){
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'samebrain-sync455-'))),home=join(temp,'home');mkdirSync(home);
 const record={owner:'Windows3-sync455',machine:process.env.COMPUTERNAME,launcher_pid:process.pid,created_at:new Date().toISOString(),temp,disposition:'active'};
 const save=()=>{if(process.env.SAMEBRAIN_SYNC_TEST_RESOURCES)writeFileSync(process.env.SAMEBRAIN_SYNC_TEST_RESOURCES,JSON.stringify(record,null,2));};save();
 t.after(()=>{assert.equal(realpathSync(temp),resolve(temp));assert.equal(dirname(realpathSync(temp)),realpathSync(tmpdir()));const scan=dir=>{for(const name of readdirSync(dir)){const p=join(dir,name),stat=lstatSync(p);assert.equal(stat.isSymbolicLink(),false,'retain uncertain fixture link');if(stat.isDirectory())scan(p);}};scan(temp);rmSync(temp,{recursive:true});record.disposition='closed';record.finished_at=new Date().toISOString();save();});
 const remote=join(temp,'remote.git'),upstream=join(temp,'upstream'),local=join(temp,'local');
 const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:60000,windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(temp,'init','--bare','--initial-branch=main',remote);git(temp,'-c','core.autocrlf=false','clone',remote,upstream);
 const configure=dir=>{git(dir,'config','user.email','fixture@example.invalid');git(dir,'config','user.name','Fixture');git(dir,'config','core.autocrlf','false');git(dir,'config','core.hooksPath',join(temp,'no-hooks'));};configure(upstream);
 const write=(dir,path,data)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),data);};
 const commit=(dir,message)=>{git(dir,'add','--all');git(dir,'commit','-m',message);return git(dir,'rev-parse','HEAD');};
 for(const p of ['hooks/recall.mjs','hooks/sync.mjs','hooks/git-sync.mjs'])if(existsSync(join(source,p)))write(upstream,p,readFileSync(join(source,p)));
 write(upstream,'hooks/hindsight.mjs',`export const loadHindsight=()=>null;export const ${['ageLabel','bankForCwd','claimRecall','formatResults','readPages','readRecallCache','recall','releaseRecall','writeRecallCache'].map(x=>x+'=()=>{}').join(',')};`);
 write(upstream,'bin/repair-codex-plugin-hooks.mjs','export const repairPluginCache=()=>({});');
 write(upstream,'bin/render.mjs',`import {writeFileSync,mkdirSync} from 'node:fs';import {execFileSync} from 'node:child_process';mkdirSync('backups',{recursive:true});writeFileSync('backups/.last-render-head',execFileSync('git',['rev-parse','HEAD']).toString().trim());`);
 write(upstream,'.gitignore','backups/\n');write(upstream,'memory/MEMORY.md','old runtime fixture');write(upstream,'coordination/leases/historical.lease','old');commit(upstream,'base');git(upstream,'push','origin','main');git(temp,'-c','core.autocrlf=false','clone',remote,local);configure(local);
 const run=(hook='recall.mjs',args=[])=>spawnSync(process.execPath,[join(local,'hooks',hook),...args],{cwd:local,input:'{}',encoding:'utf8',timeout:120000,windowsHide:true,env:{...process.env,HOME:home,USERPROFILE:home,SAMEBRAIN_HINDSIGHT_REVALIDATE:'0'}});
 return{temp,local,upstream,remote,git,write,commit,run};
}

for(const staged of [false,true])test(`session-end sync preserves deletion of a whole configured directory (${staged?'staged':'unstaged'})`,t=>{
 const f=fixture(t);
 rmSync(join(f.local,'memory'),{recursive:true});
 if(staged)f.git(f.local,'add','--','memory');
 const r=f.run('sync.mjs',['--agent','codex']);
 assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stderr,/sync drift/);
 assert.equal(f.git(f.local,'status','--porcelain'),'');
 assert.equal(f.git(f.remote,'ls-tree','HEAD','memory/MEMORY.md'),'');
});

test('transport failures name the Git step without exposing its stderr',t=>{
 const f=fixture(t);f.git(f.local,'remote','set-url','origin',join(f.temp,'private-remote-marker.git'));
 const r=f.run();assert.match(r.stdout,/git fetch failed/);assert.doesNotMatch(r.stdout,/private-remote-marker/);
});
test('recall merges final telemetry history without deleting active claims or rewriting local commits',t=>{
 const f=fixture(t);f.write(f.local,'coordination/leases/historical.lease','historical update');const localCommit=f.commit(f.local,'old lease update');
 rmSync(join(f.local,'coordination/leases/historical.lease'));f.write(f.local,'telemetry/own.json','owned telemetry');f.write(f.local,'coordination/leases/local-active.lease','local live claim');f.commit(f.local,'completed lease and telemetry');
 rmSync(join(f.upstream,'coordination/leases/historical.lease'));f.write(f.upstream,'memory/MEMORY.md','new runtime fixture');f.write(f.upstream,'coordination/leases/foreign-active.lease','foreign live claim');const remoteCommit=f.commit(f.upstream,'shared fix and current lease');f.git(f.upstream,'push','origin','main');
 const r=f.run();assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(f.local,'memory/MEMORY.md'),'utf8'),'new runtime fixture','session must actually install current shared revision');
 assert.equal(f.git(f.local,'merge-base','--is-ancestor',localCommit,'HEAD'),'');assert.equal(f.git(f.local,'merge-base','--is-ancestor',remoteCommit,'HEAD'),'');
 for(const [path,expected] of [['telemetry/own.json','owned telemetry'],['coordination/leases/local-active.lease','local live claim'],['coordination/leases/foreign-active.lease','foreign live claim']])assert.equal(readFileSync(join(f.local,path),'utf8'),expected);
 assert.equal(readFileSync(join(f.local,'backups/.last-render-head'),'utf8'),f.git(f.local,'rev-parse','HEAD'));assert.match(r.stdout,/new runtime fixture/);
});
test('a current conflicting claim is preserved and sync drift reaches session context',t=>{
 const f=fixture(t);f.write(f.local,'coordination/leases/historical.lease','local active owner');const before=f.commit(f.local,'local claim');f.write(f.upstream,'coordination/leases/historical.lease','foreign active owner');const remote=f.commit(f.upstream,'foreign claim');f.git(f.upstream,'push','origin','main');
 const r=f.run();assert.equal(r.status,0);assert.match(r.stdout,/shared runtime sync drift/);assert.match(r.stderr,/claims were preserved/);assert.equal(f.git(f.local,'rev-parse','HEAD'),before);assert.equal(readFileSync(join(f.local,'coordination/leases/historical.lease'),'utf8'),'local active owner');assert.equal(f.git(f.local,'rev-parse','origin/main'),remote);assert.equal(f.git(f.local,'status','--porcelain'),'');assert.equal(existsSync(join(f.local,'.git/MERGE_HEAD')),false);
});
test('recall never aborts another owner existing rebase',t=>{
 const f=fixture(t);f.write(f.local,'coordination/leases/historical.lease','local conflict');f.commit(f.local,'local');f.write(f.upstream,'coordination/leases/historical.lease','foreign conflict');f.commit(f.upstream,'foreign');f.git(f.upstream,'push','origin','main');f.git(f.local,'fetch');
 const rebase=spawnSync('git',['rebase','origin/main'],{cwd:f.local,encoding:'utf8'});assert.notEqual(rebase.status,0);const head=f.git(f.local,'rev-parse','HEAD'),status=f.git(f.local,'status','--porcelain'),lease=readFileSync(join(f.local,'coordination/leases/historical.lease'),'utf8');const r=f.run();assert.match(r.stdout,/existing Git operation/);assert.equal(f.git(f.local,'rev-parse','HEAD'),head);assert.equal(f.git(f.local,'status','--porcelain'),status);assert.equal(readFileSync(join(f.local,'coordination/leases/historical.lease'),'utf8'),lease);assert.equal(existsSync(join(f.local,'.git/rebase-merge')),true);
});
test('dirty work and an uncertain sync lock remain intact with actionable context',t=>{
 const f=fixture(t);f.write(f.local,'memory/MEMORY.md','unsaved own edit');const r=f.run();assert.match(r.stdout,/Uncommitted work is preserved \(memory\/MEMORY\.md\)/);assert.equal(readFileSync(join(f.local,'memory/MEMORY.md'),'utf8'),'unsaved own edit');const lock=join(f.local,'.git/samebrain-sync.lock');writeFileSync(lock,'foreign ownership receipt');const locked=f.run();assert.match(locked.stdout,/Another sync owner/);assert.equal(readFileSync(lock,'utf8'),'foreign ownership receipt');
});
test('untracked files that block sync are named in session context and left in place',t=>{
 const f=fixture(t),before=f.git(f.local,'rev-parse','HEAD'),stray={'.last-cleanup':'x','cache/c.json':'{}','history.jsonl':'{}','policy-limits.json':'{}','projects/p/s.jsonl':'{}','settings.json':'{}'};
 for(const [path,data] of Object.entries(stray))f.write(f.local,path,data);
 const r=f.run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Uncommitted work is preserved \(\.last-cleanup, cache\/, history\.jsonl, policy-limits\.json, projects\/ and 1 more\)/);
 assert.equal(f.git(f.local,'rev-parse','HEAD'),before);for(const [path,data] of Object.entries(stray))assert.equal(readFileSync(join(f.local,path),'utf8'),data);
});
test('a blocking path name is capped before it reaches session context',t=>{
 const f=fixture(t),name='n'.repeat(120);f.write(f.local,name,'x');
 const r=f.run();assert.match(r.stdout,new RegExp(`Uncommitted work is preserved \\(${'n'.repeat(80)}\\);`));assert.equal(readFileSync(join(f.local,name),'utf8'),'x');
});
test('a lock left by a dead hook process is reclaimed while a live owner lock stays intact',t=>{
 const f=fixture(t);const lock=join(f.local,'.git/samebrain-sync.lock');
 const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout;
 writeFileSync(lock,JSON.stringify({token:'killed-hook',pid:Number(dead)}));const r=f.run();assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/sync drift/);assert.equal(existsSync(lock),false);
 const live=JSON.stringify({token:'live-owner',pid:process.pid});writeFileSync(lock,live);const held=f.run();assert.match(held.stdout,/Another sync owner/);assert.equal(readFileSync(lock,'utf8'),live);
 const foreign=JSON.stringify({token:'other-host',host:'another-machine',pid:Number(dead)});writeFileSync(lock,foreign);const remote=f.run();assert.match(remote.stdout,/Another sync owner/);assert.equal(readFileSync(lock,'utf8'),foreign);
});
test('session-end sync integrates upstream and preserves and pushes local telemetry and claims',t=>{
 const f=fixture(t);f.write(f.upstream,'memory/MEMORY.md','latest shared fix');const remote=f.commit(f.upstream,'shared runtime fix');f.git(f.upstream,'push','origin','main');f.write(f.local,'coordination/leases/own.lease','current own lease');
 const r=f.run('sync.mjs',['--agent','codex']);assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stderr,/sync drift/,'actual working state: '+f.git(f.local,'status','--porcelain'));const head=f.git(f.local,'rev-parse','HEAD');assert.equal(f.git(f.remote,'rev-parse','refs/heads/main'),head);assert.equal(f.git(f.local,'merge-base','--is-ancestor',remote,'HEAD'),'');assert.equal(readFileSync(join(f.local,'coordination/leases/own.lease'),'utf8'),'current own lease');assert.equal(readFileSync(join(f.local,'memory/MEMORY.md'),'utf8'),'latest shared fix');
});
test('session-end never commits another owner staged source together with telemetry',t=>{
 const f=fixture(t),before=f.git(f.local,'rev-parse','HEAD');f.write(f.local,'foreign-source.mjs','foreign unfinished source');f.git(f.local,'add','foreign-source.mjs');f.write(f.local,'coordination/leases/own.lease','own pending claim');
 const r=f.run('sync.mjs',['--agent','codex']);assert.match(r.stderr,/Staged work outside/);assert.equal(f.git(f.local,'rev-parse','HEAD'),before);assert.equal(f.git(f.local,'diff','--cached','--name-only'),'foreign-source.mjs');assert.equal(readFileSync(join(f.local,'foreign-source.mjs'),'utf8'),'foreign unfinished source');assert.equal(readFileSync(join(f.local,'coordination/leases/own.lease'),'utf8'),'own pending claim');
});

