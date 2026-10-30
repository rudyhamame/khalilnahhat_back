const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const read=env=>JSON.parse(execFileSync(process.execPath,['-e',"const d=require('./src/default-data');console.log(JSON.stringify({u:[...d.ADMIN_USERNAMES],g:d.ADMIN_GOOGLE_EMAILS}))"],{cwd:__dirname+'/..',env:{PATH:process.env.PATH,...env}}).toString());
test('the owner is always an admin; more admins come only from the environment',()=>{
  assert.deepEqual(read({}).u,['khalilnahhat']);
  assert.deepEqual(read({}).g,['khalilnahhatdj@gmail.com']);
  const extra=read({ADMIN_USERNAMES:' Rudy , ,Other ',ADMIN_GOOGLE_EMAILS:'Me@Example.com'});
  assert.deepEqual(extra.u,['khalilnahhat','rudy','other']);
  assert.deepEqual(extra.g,['khalilnahhatdj@gmail.com','me@example.com']);
});
