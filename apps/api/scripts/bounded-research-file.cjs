'use strict';
const fs=require('node:fs');
// Read and validate the same descriptor. Optional missing files are distinct
// from unreadable, nonregular, symlinked or oversized inputs.
function readBoundedText(file,maxBytes,invalidCode,allowMissing=false){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('INVALID_READ_LIMIT');
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  }catch(err){
    if(allowMissing&&err.code==='ENOENT')return null;
    throw err;
  }
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>maxBytes)throw Error(invalidCode);
    const chunks=[];
    let total=0;
    const buffer=Buffer.alloc(Math.min(65536,maxBytes+1));
    while(total<=maxBytes){
      const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,maxBytes+1-total),null);
      if(n===0)break;
      total+=n;
      if(total>maxBytes)throw Error(invalidCode);
      chunks.push(Buffer.from(buffer.subarray(0,n)));
    }
    return Buffer.concat(chunks,total).toString('utf8');
  }finally{fs.closeSync(fd);}
}
module.exports={readBoundedText};
