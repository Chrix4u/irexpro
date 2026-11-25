'use strict';
const fs=require('node:fs'),path=require('node:path');
// Stage in a private directory on the destination filesystem. Publish the
// complete file, never open an existing destination through its pathname.
// Return whether an existing directory entry was replaced.
function publishTextArtifact(file,text){
 const dir=fs.mkdtempSync(path.join(path.dirname(file),'.publish-'));
 const staged=path.join(dir,'artifact');
 try{
  fs.writeFileSync(staged,text,{encoding:'utf8',flag:'wx',mode:0o644});
  try{
   fs.linkSync(staged,file);
   return false;
  }catch(err){
   if(err.code!=='EEXIST')throw err;
   fs.renameSync(staged,file);
   return true;
  }
 }finally{
  fs.rmSync(dir,{recursive:true,force:true});
 }
}
module.exports={publishTextArtifact};
