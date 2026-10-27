// Explicit links: service-price IDs and equipment slugs are separate identifiers.
const PRICE_EQUIPMENT = Object.freeze({
 'professional-dj-service':'dj-service','qsc-k12-2-speaker':'qsc-k122','elite-15-speaker':'elite-15',
 'es18p-subwoofer':'es18p','shure-microphone':'shure-mics','soundcraft-soundboard':'soundcraft',
 'jbl-concert-system':'jbl-system','intelligent-moving-head':'movingheads','baseplate-trussing':'trussing',
 uplight:'uplights','smoke-machine':'smoke','sparkler-machine':'sparklers','dry-ice-machine':'dry-ice',
 'co2-gun':'co2-gun','six-panel-led-screen':'led-screen',projector:'projector',
});
function stockView(item) {
 const known=item.stockTracked===true&&Number.isSafeInteger(item.quantityOwned)&&item.quantityOwned>=0;
 const availableQuantity=item.isActive===false?0:known?item.quantityOwned:null;
 return {availableQuantity,availabilityStatus:item.isActive===false||known&&item.quantityOwned<(item.minQuantity||1)?'unavailable':known?'available':'on_request'};
}
function priceStockView(price,items) {
 const equipmentId=PRICE_EQUIPMENT[price.serviceId];
 const equipment=equipmentId&&items.find(item=>item.slug===equipmentId);
 return {equipmentId:equipment?.slug||null,...(equipment?stockView(equipment):{availableQuantity:null,availabilityStatus:'not_applicable'})};
}
module.exports={PRICE_EQUIPMENT,stockView,priceStockView};
