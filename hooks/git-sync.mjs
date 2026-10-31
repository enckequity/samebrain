import {execFileSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync,readFileSync,existsSync,unlinkSync,renameSync,linkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

// Session hooks share this lock; never steal an active or uncertain owner's work.
export function syncGit(root,{timeout=8000,commitPaths=[],push=false}={}) {
 let step='repository inspection';
 // Repo hooks stay off here: post-merge would render under this timeout, and recall already
 // re-renders when the engine revision moves. LC_ALL=C keeps conflict output parseable.
 const noHooks=`core.hooksPath=${join(root,'.git','samebrain-no-hooks')}`;
 const git=args=>{step=`git ${args[0]}`;return execFileSync('git',['-c',noHooks,...args],{cwd:root,timeout,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'},stdio:['ignore','pipe','pipe']}).trim();};
 const blocked=reason=>({status:'blocked',reason});
 let lock,token;
 try {
  lock=join(resolve(root,git(['rev-parse','--git-common-dir'])),'samebrain-sync.lock');
  token=JSON.stringify({token:randomUUID(),host:hostname(),pid:process.pid,started_at:new Date(Date.now()-process.uptime()*1000).toISOString(),created_at:new Date().toISOString()});
  const acquire=()=>{
   let fd;
   try {fd=openSync(lock,'wx',0o600);writeFileSync(fd,token);return true;}
   catch(error){if(error.code==='EEXIST')return false;throw error;}
   finally{if(fd!==undefined)closeSync(fd);}
  };
  if(!acquire()&&!(reclaimDeadLock(lock)&&acquire()))return blocked('Another sync owner holds the lock; preserve it and retry after that owner finishes.');
  const pending=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'];
  if(pending.some(path=>existsSync(resolve(root,git(['rev-parse','--git-path',path])))))return blocked('An existing Git operation is in progress; its owner must finish it. No operation was aborted.');
  if(git(['branch','--show-current'])!=='main')return blocked('The checkout is not main; preserve its branch and sync the canonical main checkout.');
  const upstream=git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
  // HEAD still owns deleted paths, even after their deletion has been staged.
  const tracked=commitPaths.length?git(['ls-tree','-r','--name-only','-z','HEAD','--',...commitPaths]).split('\0'):[];
  const paths=commitPaths.filter(path=>existsSync(join(root,path))||tracked.some(file=>file===path||file.startsWith(path+'/')));
  const staged=git(['diff','--cached','--name-only','--no-renames','-z']).split('\0').filter(Boolean);
  if(staged.some(path=>!paths.some(allowed=>path===allowed||path.startsWith(allowed+'/'))))return blocked('Staged work outside memory, telemetry and claims belongs to another task; its index was preserved without committing it.');
  if(paths.length&&git(['status','--porcelain','--',...paths])){
   const indexed=git(['ls-files','-z','--',...paths]).split('\0');
   const addPaths=paths.filter(path=>existsSync(join(root,path))||indexed.some(file=>file===path||file.startsWith(path+'/')));
   if(addPaths.length)git(['add','--',...addPaths]);
   git(['commit','--only','--quiet','-m','mem: session update','--',...paths]);
  }
  const dirty=git(['status','--porcelain','--untracked-files=normal','--no-renames','-z']).split('\0').filter(Boolean);
  if(dirty.length)return blocked(`Uncommitted work is preserved (${blockingPaths(dirty)}); its owner must commit or finish it before shared runtime updates can install.`);
  const before=git(['rev-parse','HEAD']);
  git(['fetch','--quiet']);
  const target=git(['rev-parse',upstream]);
  try {git(['merge','--no-edit','--no-stat',upstream]);}
  catch(error){
   // Abort only a conflict made by this invocation, with exact original/target
   // identity. Pre-existing operations were fenced above; no lease is resolved.
   const mergePath=resolve(root,git(['rev-parse','--git-path','MERGE_HEAD']));
   const ours=existsSync(mergePath)&&readFileSync(mergePath,'utf8').trim()===target
    &&git(['rev-parse','HEAD'])===before&&git(['rev-parse','ORIG_HEAD'])===before
    &&String(error.stdout??'').includes('Automatic merge failed');
   if(ours){
    try{git(['merge','--abort']);}
    catch{return blocked('This sync merge could not be safely aborted; preserve all conflict state for its owner to recover.');}
   }
   return blocked(ours?'Current branches conflict; local commits and claims were preserved. Their owners must reconcile the conflicting work before sync can advance.':'Git integration was refused; preserve the checkout and inspect the existing operation before retrying.');
  }
  const head=git(['rev-parse','HEAD']);
  if(push)git(['push','--quiet']);
  return{status:head===before?'current':'updated',before,head,upstream};
 }catch{return{status:'unavailable',reason:`${step} failed (transport, identity or repository state). Local work is retained; inspect canonical Git status and retry when access is restored.`};}
 finally{
  if(lock&&token){try{if(readFileSync(lock,'utf8')===token)unlinkSync(lock);}catch{/* An uncertain or foreign lock stays intact. */}}
 }
}

// A hook killed mid-sync (e.g. by a hook timeout) never runs its finally, so its
// lock would block every later sync. Reclaim only a lock whose recorded PID is
// provably gone on this host; unreadable, PID-less, live-PID or other-host locks stay intact.
function reclaimDeadLock(lock){
 let seen,pid,host;
 try {seen=readFileSync(lock,'utf8');({pid,host}=JSON.parse(seen));} catch {return false;}
 if(!Number.isInteger(pid)||pid<=0||pid===process.pid||(host!==undefined&&host!==hostname()))return false;
 try {process.kill(pid,0);return false;} catch(error){if(error.code!=='ESRCH')return false;}
 // Rename, then verify: a fresh lock created concurrently is put back, never deleted.
 const moved=`${lock}.stale-${randomUUID()}`;
 try {renameSync(lock,moved);} catch {return false;}
 if(readFileSync(moved,'utf8')===seen){unlinkSync(moved);return true;}
 try {linkSync(moved,lock);unlinkSync(moved);}
 catch(error){
  // EEXIST: a newer owner already holds the lock. Otherwise put the file back.
  if(error.code==='EEXIST')unlinkSync(moved);else try {renameSync(moved,lock);} catch {/* left beside the lock for its owner */}
 }
 return false;
}

// Names what blocks sync, so a stray file shows in the session warning and not only as drift.
// The first entry's leading status space is lost to trim(), hence one or two status characters.
// Names are untrusted text in session context, so control characters are replaced and each name is capped.
function blockingPaths(entries){
 const paths=entries.map(entry=>entry.replace(/^[ MTADRCU?!]{1,2} /,'').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu,'?').slice(0,80));
 return paths.slice(0,5).join(', ')+(paths.length>5?` and ${paths.length-5} more`:'');
}

export function syncWarning(result){
 return ['current','updated'].includes(result.status)?'':`samebrain: shared runtime sync drift. ${result.reason}`;
}
