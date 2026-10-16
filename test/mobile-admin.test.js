const {test}=require('node:test');const assert=require('node:assert/strict');
const {clientUpdate,clientCreate,clientView,fileView}=require('../src/mobile-admin');
test('client mutations cannot grant admin, replace credentials or change usernames',()=>{
 for(const key of ['isAdmin','passwordHash','sessionToken','resetTokenHash','username'])assert.equal(clientUpdate.safeParse({[key]:'changed'}).success,false);
 assert.equal(clientCreate.safeParse({username:'client',firstName:'A',lastName:'B',email:'ab@example.com',isAdmin:true}).success,false);
});
test('client responses exclude passwords, session and reset secrets',()=>{
 const out=clientView({_id:'123',username:'client',firstName:'A',lastName:'B',email:'a@example.com',passwordHash:'secret',sessionToken:'secret',resetTokenHash:'secret'});
 assert.equal(JSON.stringify(out).includes('secret'),false);assert.equal(out.id,'123');
});
test('private storage list exposes no public Cloudinary URL or storage identifier',()=>{
 const out=fileView({_id:'123',name:'Contract.pdf',publicId:'private-secret',delivery:'authenticated',secure_url:'https://private-secret',clientId:'client'});
 assert.equal(JSON.stringify(out).includes('private-secret'),false);assert.equal(out.clientId,'client');
});
