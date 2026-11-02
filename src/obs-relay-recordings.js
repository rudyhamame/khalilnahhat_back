// Compatibility entry point: both recording providers now use one fenced saving pipeline.
module.exports={transfer:row=>require('./live-recordings').transferRecording(row)};
