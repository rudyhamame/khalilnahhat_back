const test=require('node:test');
const assert=require('node:assert/strict');
const {sections,navigationIntent}=require('../src/ai-admin/navigation');
test('every dashboard sidebar section can be requested through AI navigation',()=>{
 const expected=['live-stream','live-archive','recordings','work-elements','dj-work-type','dj-service-builder',
  'clients','bookings','testimonials','meetings','youtube','gallery','prices','transactions','availability',
  'vouchers','ai-administrator','ai-configuration','service-overview-operations-guide','notifications','seasonal-theme'];
 for(const section of expected){
  assert.ok(Object.hasOwn(sections,section),`Missing AI section: ${section}`);
  assert.equal(navigationIntent('Open '+sections[section]),section);
 }
});
test('navigation refuses unrecognized URLs and commands',()=>{
 assert.equal(navigationIntent('open https://example.com/admin'),null);
 assert.equal(navigationIntent('delete notifications'),null);
 assert.equal(navigationIntent('Open Notifications'),'notifications');
 assert.equal(navigationIntent('open Service Overview & Operations Guide'),'service-overview-operations-guide');
});
