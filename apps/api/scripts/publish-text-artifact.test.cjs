'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {publishTextArtifact}=require('./publish-text-artifact.cjs');
test('publishes a complete new artifact and replaces it atomically',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-publish-'));
 try{
  const file=path.join(dir,'artifact.txt');
  assert.equal(publishTextArtifact(file,'first'),false);
  assert.equal(fs.readFileSync(file,'utf8'),'first');
  assert.equal(publishTextArtifact(file,'second'),true);
  assert.equal(fs.readFileSync(file,'utf8'),'second');
  assert.deepEqual(fs.readdirSync(dir),['artifact.txt']);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('replacing a symbolic link never modifies its target',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-publish-'));
 try{
  const target=path.join(dir,'target'),file=path.join(dir,'artifact');
  fs.writeFileSync(target,'unchanged');
  fs.symlinkSync(target,file);
  assert.equal(publishTextArtifact(file,'replacement'),true);
  assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
  assert.equal(fs.readFileSync(file,'utf8'),'replacement');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
