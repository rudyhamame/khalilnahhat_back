const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../src');
const files=fs.readdirSync(root,{recursive:true}).filter(name=>name.endsWith('.js')&&!name.includes('.test.')&&!name.startsWith('ai-admin/'));
const rows=[];
for(const file of files){const source=fs.readFileSync(path.join(root,file),'utf8');for(const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*([`'"])([^\n]*?)\2\s*,([^\n]*)/g)){const guard=match[4];if(/requireAdmin/.test(guard)||/admin/.test(match[3])||/^(event-drafts|simulation-drafts)\.js$|^venue-intelligence\/routes\.js$/.test(file))rows.push({module:file,method:match[1].toUpperCase(),path:match[3],line:source.slice(0,match.index).split('\n').length});}}
const extra=[{module:'content.js',path:'/api/content/{testimonials,media}{/admin,/:id}',method:'CRUD',note:'Generated crud() routes; includes publication and testimonial replies.'},{module:'music-ontology/routes.js',path:'/api/admin/music-ontology/{recordings,works,vocabulary}',method:'CRUD',note:'Generated route loops; strict ontology schemas, permanent delete denied to AI.'},{module:'music-archive.js',path:'/api/admin/music-archive/{collections,songs}',method:'CRUD',note:'Generated collections routes; legacy song writes rejected by ontology.'}];
const {app}=require('../src/server');
const registry=app.locals.aiAdministrator.registry;
const evidencePath=path.join(__dirname,'../artifacts/ai-administrator/capability-verification.json');
const evidence=fs.existsSync(evidencePath)?JSON.parse(fs.readFileSync(evidencePath,'utf8')):null;
const capabilities=registry.list().map(entry=>({...entry,testStatus:evidence?.verifiedCapabilities.includes(entry.name)?'real-handler integration passed':'not verified'}));
const runtimeRoutes=registry.inventory().filter(row=>!String(row.path).includes('ai-administrator'));
const report={capabilities,runtimeRoutes,generatedAt:new Date().toISOString(),method:'Source scan plus explicit generated-route inventory; runtime route inventory returned by registry.',routes:rows,generatedRoutes:extra};
fs.mkdirSync(path.join(__dirname,'../docs'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../docs/admin-route-inventory.json'),JSON.stringify(report,null,2)+'\n');console.log(`Inventoried ${rows.length} literal administrative routes and ${extra.length} generated route families.`);
