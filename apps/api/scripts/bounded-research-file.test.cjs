'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readBoundedText,appendBoundedText,createPrivateOnce}=require('./bounded-research-file.cjs');
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

test('bounded append preserves existing bytes and rejects symlinks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-append-'));
 try{
  const p=path.join(dir,'journal'),link=path.join(dir,'link');
  assert.equal(appendBoundedText(p,'ab',3),true);
  assert.equal(appendBoundedText(p,'cd',3),false);
  assert.equal(appendBoundedText(p,'c',3),true);
  assert.equal(fs.readFileSync(p,'utf8'),'abc');
  assert.equal(fs.statSync(p).mode&0o777,0o600);
  fs.symlinkSync(p,link);
  assert.throws(()=>appendBoundedText(link,'x',10));
  assert.equal(fs.readFileSync(p,'utf8'),'abc');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('exclusive create preserves existing marker and never overwrites a symlink target',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'private-once-'));
 try{
  const p=path.join(dir,'marker'),link=path.join(dir,'link');
  assert.equal(createPrivateOnce(p,'first'),true);
  assert.equal(createPrivateOnce(p,'second'),false);
  assert.equal(fs.readFileSync(p,'utf8'),'first');
  fs.symlinkSync(p,link);
  assert.equal(createPrivateOnce(link,'third'),false);
  assert.throws(()=>readBoundedText(link,100,'LIMIT'));
  assert.equal(fs.readFileSync(p,'utf8'),'first');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
