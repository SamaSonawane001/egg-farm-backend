import { Router } from 'express';
import { auth } from '../middlewares/auth';
import { uploadAvatar } from '../middlewares/upload';
import * as A from '../controllers/auth.controller';
import * as F from '../controllers/flock.controller';
import * as D from '../controllers/feed.controller';
import * as E from '../controllers/egg.controller';
import * as I from '../controllers/invoice.controller';
import { dashboard } from '../controllers/dashboard.controller';
import { health } from '../controllers/health.controller';

const r = Router();

// ---- public ----
r.post('/auth/register', uploadAvatar, A.register);
r.post('/auth/login', A.login);
r.get('/public/invoices/:token/pdf', I.publicPdf);
r.get('/health', health);

// ---- everything below requires a valid JWT; req.ownerId is the tenant ----
r.use(auth);
r.get('/auth/me', A.me);
r.put('/profile', uploadAvatar, A.updateProfile);
r.post('/profile/password', A.changePassword);
r.get('/dashboard', dashboard);

r.get('/flock/batches', F.listBatches);
r.post('/flock/batches', F.createBatch);
r.put('/flock/batches/:id', F.updateBatch);
r.delete('/flock/batches/:id', F.deleteBatch);
r.get('/flock/mortality', F.listMortality);
r.post('/flock/mortality', F.createMortality);
r.put('/flock/mortality/:id', F.updateMortality);
r.delete('/flock/mortality/:id', F.deleteMortality);

r.get('/feed/stock', D.stock);
r.get('/feed/products', D.products);
r.post('/feed/products', D.createProduct);
r.get('/feed/products/:id', D.productDetail);
r.put('/feed/products/:id', D.updateProduct);
r.delete('/feed/products/:id', D.removeProduct);
r.get('/feed/purchases', D.listPurchases);
r.post('/feed/purchases', D.createPurchase);
r.put('/feed/purchases/:id', D.updatePurchase);
r.delete('/feed/purchases/:id', D.deletePurchase);
r.get('/feed/usage', D.listUsage);
r.post('/feed/usage', D.createUsage);
r.put('/feed/usage/:id', D.updateUsage);
r.delete('/feed/usage/:id', D.deleteUsage);

r.get('/eggs', E.list);
r.get('/eggs/stock', E.stock);
r.get('/eggs/summary', E.summary);
r.get('/eggs/monthly', E.monthly);
r.get('/eggs/months', E.months);
r.post('/eggs', E.create);
r.put('/eggs/:id', E.update);
r.delete('/eggs/:id', E.remove);

r.get('/invoices', I.list);
r.post('/invoices', I.create);
r.get('/invoices/:id', I.getOne);
r.get('/invoices/:id/pdf', I.pdf);
r.delete('/invoices/:id', I.remove);

export default r;
