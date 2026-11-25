'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readBoundedText}=require('./bounded-research-file.cjs');
test('reads exact limit and empty file; preserves UTF-8',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-research-'));
 try{
  const p=path.join(dir,'data');
  fs.writeFileSync(p,'é');
  assert.equal(readBoundedText(p,2,'LIMIT'),'é');
  assert.throws(()=>readBoundedText(p,1,'LIMIT'),/LIMIT/);
  fs.writeFileSync(p,'');
  assert.equal(readBoundedText(p,1,'LIMIT'),'');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('only optional missing files return null; rejects symlinks and directories',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-research-'));
 try{
  const p=path.join(dir,'data'),link=path.join(dir,'link');
  assert.equal(readBoundedText(p,20,'LIMIT',true),null);
  assert.throws(()=>readBoundedText(p,20,'LIMIT'),{code:'ENOENT'});
  fs.writeFileSync(p,'safe');
  fs.symlinkSync(p,link);
  assert.throws(()=>readBoundedText(link,20,'LIMIT',true));
  assert.throws(()=>readBoundedText(dir,20,'LIMIT'),/LIMIT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
