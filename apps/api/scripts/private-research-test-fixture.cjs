'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
function check(fd){
 const info=fs.fstatSync(fd);
 assert.ok(info.isFile());
 assert.equal(info.mode&0o777,0o600);
}
function readPrivateFixture(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{check(fd);return fs.readFileSync(fd,'utf8');}
 finally{fs.closeSync(fd);}
}
function rewritePrivateFixture(file,text){
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{check(fd);fs.ftruncateSync(fd,0);fs.writeFileSync(fd,text);}
 finally{fs.closeSync(fd);}
}
module.exports={readPrivateFixture,rewritePrivateFixture};
