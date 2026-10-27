const {test}=require('node:test');
const assert=require('node:assert/strict');
const {findPasswordAccount}=require('../src/password-account');
test('email login matches existing mixed-case email literally and rejects ambiguous accounts',async()=>{
 const account={id:'existing',username:'legacy-name'};
 const User={find(query){assert.ok(query.email.test('Client+test@Example.com'));assert.ok(!query.email.test('Clientxtest@Example.com'));return {limit:async n=>{assert.equal(n,2);return [account];}};}};
 assert.equal(await findPasswordAccount(User,{email:' Client+test@example.com '}),account);
 for(const users of [[],[account,{id:'duplicate'}]])assert.equal(await findPasswordAccount({find:()=>({limit:async()=>users})},{email:'client@example.com'}),null);
});
test('legacy username API remains available for existing clients',async()=>{
 const account={id:'admin'};
 assert.equal(await findPasswordAccount({findOne:async q=>{assert.deepEqual(q,{username:'legacy'});return account;}},{username:' Legacy '}),account);
});
