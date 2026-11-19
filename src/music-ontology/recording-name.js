// A recording has no name of its own. Its name is DERIVED: the list of its atoms' names (shown joined with " · ").
// Rows saved before this change still carry a stored `name`; it is used only while the recording has no named atoms, until a migration removes it.
const legacy=r=>String(r?.name||'').trim();
const recordingNames=r=>{
 const names=(r?.atoms||[]).map(atom=>String(atom?.name||'').trim()).filter(Boolean);
 return names.length?names:(legacy(r)?[legacy(r)]:[]);
};
const recordingName=r=>recordingNames(r).join(' · ');
module.exports={recordingNames,recordingName};
