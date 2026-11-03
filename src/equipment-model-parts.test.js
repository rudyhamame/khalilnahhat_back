const test=require('node:test');
const assert=require('node:assert/strict');
const {Equipment,publicView,updateSchema}=require('./equipment');

test('admin-defined set pieces survive equipment storage and the public response',()=>{
 const input={modelParts:[{name:'Left speaker',nameAr:'سماعة يسار',src:'/echo/models/left.glb',x:-2,z:1,rotation:30},{name:'Right speaker',src:'https://assets.example.com/right.glb',x:2,z:1,rotation:-30}]};
 const parsed=updateSchema.parse(input);
 const document=new Equipment({slug:'custom-set',category:'sound',name:'Owner set',...parsed});
 assert.equal(document.validateSync(),undefined);
 const view=publicView(document.toObject());
 assert.equal(view.modelParts.length,2);
 assert.equal(view.modelParts[0].name,'Left speaker');
 assert.equal(view.modelParts[0].src,input.modelParts[0].src);
 assert.equal(view.modelParts[1].rotation,-30);
 assert.deepEqual(publicView({slug:'empty',name:'Empty'}).modelParts,[]);
 assert.deepEqual(updateSchema.parse({modelParts:[]}).modelParts,[]);
});

test('set models reject unsafe URLs, invalid placement and excessive piece counts',()=>{
 const part={name:'Piece',src:'https://assets.example.com/model.glb'};
 for(const src of ['javascript:alert(1)','http://assets.example.com/model.glb','//assets.example.com/model.glb','/echo/../private.glb','https://user:secret@assets.example.com/model.glb']){
  assert.equal(updateSchema.safeParse({modelParts:[{...part,src}]}).success,false,src);
 }
 for(const patch of [{x:Infinity},{z:101},{rotation:361},{name:''}])assert.equal(updateSchema.safeParse({modelParts:[{...part,...patch}]}).success,false);
 assert.equal(updateSchema.safeParse({modelParts:Array(33).fill(part)}).success,false);
});

test('set membership and quantities persist without requiring a 3D model',()=>{
 const parsed=updateSchema.parse({isSet:true,setItems:[{equipmentId:'speaker',quantity:2}],priceCents:25000});
 const document=new Equipment({slug:'speaker-set',category:'sound',name:'Speaker set',...parsed});
 assert.equal(document.validateSync(),undefined);
 const view=publicView(document.toObject());
 assert.equal(view.isSet,true);
 assert.deepEqual(view.setItems,[{equipmentId:'speaker',quantity:2,x:0,z:0,rotation:0}]);
 assert.deepEqual(view.modelParts,[]);
 for(const quantity of [0,-1,1.5,33])assert.equal(updateSchema.safeParse({setItems:[{equipmentId:'speaker',quantity}]}).success,false);
 assert.equal(updateSchema.safeParse({setItems:[{equipmentId:'speaker',quantity:2},{equipmentId:'speaker',quantity:2}]}).success,false);
 assert.equal(updateSchema.safeParse({setItems:[{equipmentId:'speaker',quantity:20},{equipmentId:'monitor',quantity:20}]}).success,false);
});
