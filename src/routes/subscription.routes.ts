import { Router } from 'express';
import * as S from '../controllers/subscription.controller';

const subscriptionRoutes = Router();

subscriptionRoutes.get('/status', S.status);
subscriptionRoutes.post('/create-order', S.createOrder);
subscriptionRoutes.post('/verify-payment', S.verifyPayment);
subscriptionRoutes.post('/refresh-payment', S.refreshPayment);
subscriptionRoutes.post('/cancel', S.cancel);

export default subscriptionRoutes;
