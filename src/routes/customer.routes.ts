import { Router } from 'express';
import { auth, farmContext } from '../middlewares/auth';
import * as C from '../controllers/customer.controller';

const customerRoutes = Router();

customerRoutes.use(auth, farmContext);
customerRoutes.get('/', C.list);
customerRoutes.get('/:customerId/ledger', C.ledger);
customerRoutes.post('/:customerId/payments', C.receivePayment);
customerRoutes.delete('/:customerId/payments/:paymentId', C.removePayment);

export default customerRoutes;
