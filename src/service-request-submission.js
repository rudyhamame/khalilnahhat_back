const { z } = require('zod');
const { eventSchema, normalizeQuoteItems } = require('./quote-validation');
const eventOrder = require('./event-order');
const { evaluateSubmissionReplay, fingerprintSubmission, isSubmissionDuplicateKey } = require('./service-request-idempotency');

const serviceRequestCreateSchema = z.object({
  clientSubmissionId: z.string().uuid().optional(),
  draftId: z.string().uuid().optional(),
  items: z.array(z.object({
    serviceId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    category: z.string().trim().min(1),
    quantity: z.coerce.number().int().min(1),
  })).min(1, 'Select at least one service.'),
  event: eventSchema.optional(),
  order: eventOrder.orderSchema.optional(),
  voucherCode: z.string().trim().max(40).optional(),
});

function registerServiceRequestSubmission(app, { requireAuth, ServiceRequest, Equipment, vouchers, serializeServiceRequest, sendServiceRequestNotification, loadConversation=(owner,id)=>require('./booking-conversations').mongoStore.get(owner,id) }) {
  app.post('/api/service-requests', requireAuth, async (request, response) => {
    const parsed = serviceRequestCreateSchema.safeParse(request.body);

    if (!parsed.success) {
      return response.status(400).json({
        message: 'Service request payload failed validation.',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const user = request.authUser;
    const draftVoucher=parsed.data.order?.additional?.voucherCode?.trim().toUpperCase();
    if(draftVoucher&&parsed.data.voucherCode&&draftVoucher!==parsed.data.voucherCode.trim().toUpperCase())return response.status(400).json({message:'The voucher changed. Review the current draft code before submitting.'});
    if(draftVoucher&&!parsed.data.voucherCode)parsed.data.voucherCode=draftVoucher;
    const submissionPayload = { items: parsed.data.items, event: parsed.data.event || null, order: parsed.data.order || null, voucherCode: parsed.data.voucherCode || '', ...(parsed.data.draftId?{draftId:parsed.data.draftId}:{}) };
    const submissionHash = parsed.data.clientSubmissionId ? fingerprintSubmission(submissionPayload) : undefined;
    const findExistingSubmission = async () => ServiceRequest.findOne({ userId: user._id, clientSubmissionId: parsed.data.clientSubmissionId }).select('+submissionHash');
    const sendReplay = async (existing) => {
      const replay = evaluateSubmissionReplay(existing, submissionHash);
      if (replay.kind === 'conflict') return response.status(409).json({ message: 'This submission ID was already used for different booking details. Review the request and submit the updated details again.' });
      return response.status(200).json({ item: serializeServiceRequest(existing, false), notificationSent: false, replayed: true });
    };
    if (parsed.data.clientSubmissionId) {
      // Wait for the compound unique index before accepting protected submissions.
      await ServiceRequest.init();
      const existing = await findExistingSubmission();
      if (existing) return sendReplay(existing);
    }
    if (parsed.data.order) {
      try { Object.assign(parsed.data,eventOrder.prepareSubmittedOrder(parsed.data.order,request.authUser,parsed.data.items,await Equipment.find({isActive:true}))); }
      catch(error){return response.status(400).json({message:error.message,fields:error.fields});}
    } else if(parsed.data.event){
      try {parsed.data.items=normalizeQuoteItems(parsed.data.items,await Equipment.find({isActive:true}));}
      catch(error){return response.status(400).json({message:error.message});}
    }

    // Snapshot only this authenticated owner's draft conversation. Never accept
    // transcript text supplied in the submission body or load another owner.
    let conversation=null;
    if(parsed.data.draftId){
      try{
        const saved=await loadConversation(String(user._id||user.id),parsed.data.draftId);
        conversation={draftId:parsed.data.draftId,messages:(saved?.messages||[]).map(({id,role,content,mode,segmentId,createdAt})=>({id,role,content,mode,segmentId,createdAt}))};
      }catch{return response.status(503).json({message:'The draft conversation could not be attached. Please retry; nothing was submitted.'});}
    }

    // A voucher is claimed before the booking is saved and released again if saving fails.
    let voucher = null;
    if (parsed.data.voucherCode) {
      const claimed = await vouchers.reserve(parsed.data.voucherCode, user);
      if (claimed.error) return response.status(400).json({ message: claimed.error });
      voucher = claimed.voucher;
    }
    let serviceRequest;
    try { serviceRequest = await ServiceRequest.create({
      externalId: `service-request-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: user._id,
      customerName: `${user.firstName} ${user.lastName}`.trim(),
      customerUsername: user.username,
      customerEmail: user.email,
      items: parsed.data.items,
      event: parsed.data.event || null,
      order: parsed.data.order || null,
      conversation,
      requestNumber: `ECHO-${Date.now().toString(36).toUpperCase()}`,
      status: 'pending',
      voucher: voucher ? vouchers.snapshot(voucher) : null,
      ...(parsed.data.clientSubmissionId ? { clientSubmissionId: parsed.data.clientSubmissionId, submissionHash } : {}),
    }); } catch (error) {
      if (voucher) await vouchers.release(voucher).catch(() => {});
      if (parsed.data.clientSubmissionId && isSubmissionDuplicateKey(error)) {
        const existing = await findExistingSubmission();
        if (existing) return sendReplay(existing);
      }
      throw error;
    }
    if (voucher) await vouchers.record(voucher, user, serviceRequest).catch((error) => console.error('Voucher redemption record failed:', error));

    let notificationSent = false;

    try {
      const notification = await sendServiceRequestNotification(serviceRequest);
      notificationSent = notification.sent;
    } catch (error) {
      console.error('Failed to send Brevo service request notification:', error);
    }

    return response.status(201).json({
      item: serializeServiceRequest(serviceRequest, false),
      notificationSent,
    });
  });

}
module.exports = { registerServiceRequestSubmission };
