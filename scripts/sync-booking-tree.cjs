// The Data Atoms Booking Tree owns the field schema. Legacy validators consume this generated projection.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const tree=require('../contracts/booking-atoms.json');
const target=path.join(__dirname,'../src/eventOrderContract.json');
const keys=tree.order.sections.flatMap(section=>section.fields.map(field=>field.key));
assert.equal(new Set(keys).size,keys.length,'Duplicate field keys');
const numbered=tree.sections.flatMap(([,fields])=>fields);
assert.equal(new Set(numbered).size,numbered.length,'Duplicate numbered atoms');
for(const key of keys)assert.ok(tree.ownership[key],`Missing field ownership: ${key}`);
for(const key of numbered)assert.ok(keys.includes(key),`Unknown numbered atom: ${key}`);
for(const [code] of tree.sections){assert.ok(tree.steps.some(step=>step.code===code.slice(0,2)),`Unknown step: ${code}`);assert.ok(tree.sectionDefinitions.some(section=>section.code===code),`Unknown section: ${code}`);}
if(process.argv.includes('--check')){assert.deepEqual(JSON.parse(fs.readFileSync(target,'utf8')),tree.order,'eventOrderContract.json differs from the Booking Tree. Run node scripts/sync-booking-tree.cjs');console.log('Booking Tree schema projection in sync.');}
else{fs.writeFileSync(target,JSON.stringify(tree.order,null,1)+'\n');console.log('Generated eventOrderContract.json from the Booking Tree.');}
