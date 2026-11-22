// Genre identities are independent of language. Also sanitize pre-migration records on reads.
function withoutGenreLanguages(row){
 if(row?.kind!=='genre')return row;
 const {languageIds,languageId,languages,...genre}=row;
 return genre;
}
module.exports={withoutGenreLanguages};
