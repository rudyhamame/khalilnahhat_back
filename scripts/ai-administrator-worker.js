require('dotenv').config();
const {app}=require('../src/server');
const {connectToDatabase}=require('../src/db');
(async()=>{await connectToDatabase();await app.locals.aiAdministrator.start();const keepAlive=setInterval(()=>{},60000);for(const event of ['SIGTERM','SIGINT'])process.on(event,()=>{clearInterval(keepAlive);app.locals.aiAdministrator.stop();setTimeout(()=>process.exit(0),1000);});console.log('Echo AI Administrator worker started. MongoDB holds tasks and approvals.');})().catch(error=>{console.error('Administrator worker failed:',error.name);process.exit(1);});
